const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const compression = require("compression");
const axios = require("axios");
const { MongoClient, ObjectId } = require("mongodb");
const levenshtein = require("fast-levenshtein");
const ExcelJS = require("exceljs");
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const multer = require('multer');
const ftp = require('basic-ftp');
const dayjs = require('dayjs');
require("dotenv").config();

// ✅ 정적 FAQ 데이터 불러오기
const staticFaqList = require("./faq");

// ========== [환경 설정] ==========
const {
  ACCESS_TOKEN, REFRESH_TOKEN, CAFE24_CLIENT_ID, CAFE24_CLIENT_SECRET,
  DB_NAME, MONGODB_URI, CAFE24_MALLID, OPEN_URL, API_KEY,
  FINETUNED_MODEL = "gpt-3.5-turbo", CAFE24_API_VERSION = "2024-06-01",
  PORT = 5000,
  SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS,
  FTP_HOST = 'yogibo.ftp.cafe24.com',
  FTP_USER = 'yogibo',
  FTP_PASS = 'korea2025!!',
  FTP_PUBLIC_BASE
} = process.env;

const MALL_ID = CAFE24_MALLID || 'yogibo';

let accessToken = ACCESS_TOKEN;
let refreshToken = REFRESH_TOKEN;

// ========== [Express 초기화] ==========
const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// Multer 설정
const upload = multer({
  storage: multer.diskStorage({
    destination: (r, f, c) => {
      const dir = path.join(__dirname, 'uploads');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      c(null, dir);
    },
    filename: (r, f, c) => c(null, `${Date.now()}_${f.originalname}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ========== [DB 유틸리티] ==========
// 챗봇과 템플 모두에서 사용하는 DB 연결 함수
const runDb = async (callback) => {
  const client = new MongoClient(MONGODB_URI, { maxPoolSize: 10 });
  try {
    await client.connect();
    return await callback(client.db(DB_NAME));
  } finally {
    await client.close();
  }
};

// ========== [챗봇 글로벌 상태] ==========
let pendingCoveringContext = false;
let allSearchableData = [...staticFaqList];

// ========== [챗봇 상수: 링크 및 버튼] ==========
const COUNSELOR_LINKS_HTML = `
<br><br>
📮 <a href="javascript:void(0)" onclick="window.open('http://pf.kakao.com/_lxmZsxj/chat','kakao','width=500,height=600,scrollbars=yes');" style="color:#3b1e1e; font-weight:bold; text-decoration:underline; cursor:pointer;">카카오플친 연결하기 (팝업)</a><br>
📮 <a href="javascript:void(0)" onclick="window.open('https://talk.naver.com/ct/wc4u67?frm=psf','naver','width=500,height=600,scrollbars=yes');" style="color:#03c75a; font-weight:bold; text-decoration:underline; cursor:pointer;">네이버톡톡 연결하기 (팝업)</a>
`;
const FALLBACK_MESSAGE_HTML = `<br><br>---------------------------------<br><strong>원하시는 답변을 찾지 못하셨나요? 상담사 연결을 도와드릴까요?</strong>${COUNSELOR_LINKS_HTML}`;
const LOGIN_BTN_HTML = `<div style="margin-top:15px;"><a href="/member/login.html" style="display: inline-block; padding: 10px 20px; background-color: #58b5ca; color: #ffffff; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 14px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">로그인 페이지 이동하기 →</a></div>`;

// ========== [챗봇 시스템 프롬프트] ==========
const YOGIBO_SYSTEM_PROMPT = `
1. 역할 및 말투
전문가 역할: 요기보(Yogibo) 브랜드의 전문 상담원입니다.
존대 및 공손: 고객에게 항상 존댓말과 공손한 말투를 사용합니다.
이모티콘 활용: 대화 중 적절히 이모티콘을 사용합니다.
가독성: 답변 시 줄바꿈(Enter)을 자주 사용하여 읽기 편하게 작성하세요. 문단 사이에는 빈 줄을 하나 더 넣으세요.

2. ★ 답변 원칙 (매우 중요)
제공된 [참고 정보]에 있는 내용으로만 답변하세요.
"엔젤 비즈", "마이크로 비즈" 등 요기보 제품이 아닌 용어는 절대 사용하지 마세요.
전화번호나 주소 같은 중요 정보는 [참고 정보]에 없으면 절대 지어내지 마세요.
[참고 정보]에 없는 내용은 솔직하게 모른다고 답하세요.

3. ★ 추천 상품 가이드
고객이 추천 상품을 원할 경우 요기보의 대표상품 '맥스(Max)'를 우선 추천하세요.
또한 [참고 정보]에 있는 다른 제품들의 특징(사이즈, 용도)을 바탕으로 추천하세요.
`;

// ========== [데이터 로딩] ==========
const companyDataPath = path.join(__dirname, "json", "companyData.json");
let companyData = {};
try { if (fs.existsSync(companyDataPath)) companyData = JSON.parse(fs.readFileSync(companyDataPath, "utf-8")); } catch (e) {}

// ========== [토큰 관리] ==========
const tokenCollectionName = "tokens";
async function getTokensFromDB() {
  await runDb(async (db) => {
    const doc = await db.collection(tokenCollectionName).findOne({});
    if (doc) { accessToken = doc.accessToken; refreshToken = doc.refreshToken; }
    else { await saveTokensToDB(accessToken, refreshToken); }
  });
}
async function saveTokensToDB(at, rt) {
  await runDb(async (db) => {
    await db.collection(tokenCollectionName).updateOne({}, { $set: { accessToken: at, refreshToken: rt, updatedAt: new Date() } }, { upsert: true });
  });
}
async function refreshAccessToken() { await getTokensFromDB(); return accessToken; }

// ========== [Cafe24 API] ==========
async function apiRequest(method, url, data = {}, params = {}) {
  try {
    const res = await axios({ method, url, data, params, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Cafe24-Api-Version': CAFE24_API_VERSION } });
    return res.data;
  } catch (error) {
    if (error.response?.status === 401) { await refreshAccessToken(); return apiRequest(method, url, data, params); }
    throw error;
  }
}

// ========== [챗봇 RAG 로직 (검색 강화)] ==========
async function updateSearchableData() {
  await runDb(async (db) => {
    const notes = await db.collection("postItNotes").find({}).toArray();
    const dynamic = notes.map(n => ({ c: n.category || "etc", q: n.question, a: n.answer }));
    allSearchableData = [...staticFaqList, ...dynamic];
    console.log(`✅ 검색 데이터 갱신 완료: 총 ${allSearchableData.length}개`);
  });
}

function findRelevantContent(msg) {
  const kws = msg.split(/\s+/).filter(w => w.length > 1);
  if (!kws.length) return [];
  const scored = allSearchableData.map(item => {
    let score = 0;
    const q = (item.q || "").toLowerCase().replace(/\s+/g, "");
    const a = (item.a || "").toLowerCase();
    const cleanMsg = msg.toLowerCase().replace(/\s+/g, "");
    if (q.includes(cleanMsg) || cleanMsg.includes(q)) score += 20;
    kws.forEach(w => {
      const cleanW = w.toLowerCase();
      if (item.q.toLowerCase().includes(cleanW)) score += 10;
      if (item.a.toLowerCase().includes(cleanW)) score += 1;
    });
    return { ...item, score };
  });
  return scored.filter(i => i.score >= 5).sort((a, b) => b.score - a.score).slice(0, 3);
}

async function getGPT3TurboResponse(input, context = []) {
  const txt = context.map(i => `Q: ${i.q}\nA: ${i.a}`).join("\n\n");
  try {
    const res = await axios.post(OPEN_URL, {
      model: FINETUNED_MODEL, messages: [{ role: "system", content: `${YOGIBO_SYSTEM_PROMPT}\n[참고 정보]\n${txt || "정보 없음."}` }, { role: "user", content: input }]
    }, { headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' } });
    return res.data.choices[0].message.content;
  } catch (e) { return "답변 생성 중 문제가 발생했습니다."; }
}

function formatResponseText(text) {
  if (!text) return "";
  let formatted = text.replace(/([가-힣]+)[.]\s/g, '$1.\n\n');
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return formatted.replace(urlRegex, url => {
    let cleanUrl = url.replace(/[.,]$/, '');
    return `<a href="${cleanUrl}" target="_blank" style="color:#58b5ca; font-weight:bold; text-decoration:underline;">${cleanUrl}</a>`;
  });
}

function normalizeSentence(s) { return s.replace(/[?!！？]/g, "").replace(/없나요/g, "없어요").trim(); }
function containsOrderNumber(s) { return /\d{8}-\d{7}/.test(s); }
function isUserLoggedIn(id) { return id && id !== "null" && id !== "undefined" && String(id).trim() !== ""; }

async function getOrderShippingInfo(id) {
  const today = new Date(); const start = new Date(); start.setDate(today.getDate() - 14);
  return apiRequest("GET", `https://${MALL_ID}.cafe24api.com/api/v2/admin/orders`, {}, { member_id: id, start_date: start.toISOString().split('T')[0], end_date: today.toISOString().split('T')[0], limit: 10 });
}

async function getShipmentDetail(orderId) {
  const res = await apiRequest("GET", `https://${MALL_ID}.cafe24api.com/api/v2/admin/orders/${orderId}/shipments`, {}, { shop_no: 1 });
  if (res.shipments?.[0]) {
    const s = res.shipments[0];
    const map = { "0019": "롯데 택배", "0039": "경동 택배", "0023": "경동 택배" };
    s.shipping_company_name = map[s.shipping_company_code] || s.shipping_company_code || "지정 택배사";
    if (s.tracking_no) {
        if (s.shipping_company_code === "0019") s.tracking_url = "https://www.lotteglogis.com/home/reservation/tracking/linkView?InvNo=" + s.tracking_no;
        else if (["0039", "0023"].includes(s.shipping_company_code)) s.tracking_url = "https://kdexp.com/service/delivery/tracking.do?barcode=" + s.tracking_no;
    }
    return s;
  }
  return null;
}

// ========== [챗봇 findAnswer (최신 로직)] ==========
async function findAnswer(userInput, memberId) {
  const normalized = normalizeSentence(userInput);
  if (normalized.includes("상담사 연결") || normalized.includes("상담원 연결")) return { text: `상담사와 연결을 도와드리겠습니다.${COUNSELOR_LINKS_HTML}` };
  if (normalized.includes("고객센터") && (normalized.includes("번호") || normalized.includes("전화"))) return { text: "요기보 고객센터 전화번호는 **02-557-0920** 입니다. 😊<br>운영시간: 평일 10:00 ~ 17:30 (점심시간 12:00~13:00)" };
  if (normalized.includes("오프라인 매장") || normalized.includes("매장안내")) return { text: `가까운 매장을 안내해 드립니다.<br><a href="/why/store.html" target="_blank" style="color:#58b5ca; font-weight:bold; text-decoration:underline;">매장안내 바로가기</a>` };
  if (normalized.includes("내 아이디") || normalized.includes("아이디 조회")) return isUserLoggedIn(memberId) ? { text: `안녕하세요 ${memberId} 고객님, 무엇을 도와드릴까요?` } : { text: `로그인이 필요한 서비스입니다.<br>아래 버튼을 눌러 로그인해주세요.${LOGIN_BTN_HTML}` };

  if (containsOrderNumber(normalized)) {
    if (isUserLoggedIn(memberId)) {
      try {
        const orderId = normalized.match(/\d{8}-\d{7}/)[0];
        const ship = await getShipmentDetail(orderId);
        if (ship) {
            const status = ship.status || "배송 준비중";
            const track = ship.tracking_no ? (ship.tracking_url ? `<a href="${ship.tracking_url}" target="_blank" style="color:#58b5ca;">${ship.tracking_no}</a> (클릭)` : ship.tracking_no) : "등록 대기중";
            return { text: `주문번호 <strong>${orderId}</strong>의 배송 상태는 <strong>${status}</strong>입니다.<br>🚚 택배사: ${ship.shipping_company_name}<br>📄 송장번호: ${track}` };
        }
        return { text: "해당 주문번호의 배송 정보를 찾을 수 없습니다." };
      } catch (e) { return { text: "조회 오류가 발생했습니다." }; }
    }
    return { text: `정확한 조회를 위해 로그인이 필요합니다.${LOGIN_BTN_HTML}` };
  }

  const isTracking = (normalized.includes("배송") || normalized.includes("주문")) && (normalized.includes("조회") || normalized.includes("확인") || normalized.includes("언제") || normalized.includes("어디"));
  const isFAQ = normalized.includes("비용") || normalized.includes("비") || normalized.includes("주소") || normalized.includes("변경");
  if (isTracking && !isFAQ && !containsOrderNumber(normalized)) {
    if (isUserLoggedIn(memberId)) {
      try {
        const data = await getOrderShippingInfo(memberId);
        if (data.orders?.[0]) {
          const t = data.orders[0];
          const ship = await getShipmentDetail(t.order_id);
          if (ship) {
             const track = ship.tracking_no ? (ship.tracking_url ? `<a href="${ship.tracking_url}" target="_blank" style="color:#58b5ca;">${ship.tracking_no}</a>` : ship.tracking_no) : "등록 대기중";
             return { text: `최근 주문(<strong>${t.order_id}</strong>)은 <strong>${ship.shipping_company_name}</strong> 배송 중입니다.<br>📄 송장번호: ${track}` };
          }
          return { text: "최근 주문 확인 중입니다." };
        }
        return { text: "최근 2주 내 주문 내역이 없습니다." };
      } catch (e) { return { text: "조회 실패." }; }
    } else return { text: `배송정보를 확인하시려면 로그인이 필요합니다.<br>아래 버튼을 이용해 주세요.${LOGIN_BTN_HTML}` };
  }

  if (pendingCoveringContext) {
    const types = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
    if (types.includes(normalized)) {
      const key = `${normalized} 커버링 방법을 알고 싶어`;
      pendingCoveringContext = false;
      if (companyData.covering?.[key]) return { text: formatResponseText(companyData.covering[key].answer), videoHtml: `<iframe width="100%" height="auto" src="${companyData.covering[key].videoUrl}" frameborder="0" allowfullscreen></iframe>` };
    }
  }
  if (normalized.includes("커버링") && normalized.includes("방법")) {
    const types = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
    const found = types.find(t => normalized.includes(t));
    if (found) {
      const key = `${found} 커버링 방법을 알고 싶어`;
      if (companyData.covering?.[key]) return { text: formatResponseText(companyData.covering[key].answer), videoHtml: `<iframe width="100%" height="auto" src="${companyData.covering[key].videoUrl}" frameborder="0" allowfullscreen></iframe>` };
    } else {
      pendingCoveringContext = true;
      return { text: "어떤 커버링을 알고 싶으신가요? (맥스, 더블, 슬림 등)" };
    }
  }

  if (normalized.includes("사이즈") || normalized.includes("크기")) {
    const types = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
    for (let t of types) {
      if (normalized.includes(t) && companyData.sizeInfo?.[`${t} 사이즈 또는 크기.`]) {
        return { text: formatResponseText(companyData.sizeInfo[`${t} 사이즈 또는 크기.`].description), imageUrl: companyData.sizeInfo[`${t} 사이즈 또는 크기.`].imageUrl };
      }
    }
  }

  if (normalized.includes("비즈") || normalized.includes("충전재")) {
    if (["충전", "방법", "리필", "세탁", "버리"].some(k => normalized.includes(k))) return null;
    let key = null;
    if (normalized.includes("프리미엄 플러스")) key = "프리미엄 플러스 비즈 에 대해 알고 싶어";
    else if (normalized.includes("프리미엄")) key = "프리미엄 비즈 에 대해 알고 싶어";
    else if (normalized.includes("스탠다드")) key = "스탠다드 비즈 에 대해 알고 싶어";
    if (key && companyData.biz?.[key]) return { text: formatResponseText(companyData.biz[key].description) };
    return { text: formatResponseText(`요기보의 정품 비즈는 3가지 종류가 있습니다. 1️⃣ 스탠다드 비즈 2️⃣ 프리미엄 비즈 3️⃣ 프리미엄 플러스.`) };
  }

  if (companyData.goodsInfo) {
    let b=null, m=6; for(let k in companyData.goodsInfo){const d=levenshtein.get(normalized,normalizeSentence(k));if(d<m){m=d;b=companyData.goodsInfo[k];}}
    if(b) return { text: formatResponseText(Array.isArray(b.description)?b.description.join("\n"):b.description), imageUrl: b.imageUrl };
  }
  return null;
}

// ========== [챗봇 라우터] ==========
app.post("/chat", async (req, res) => {
  const { message, memberId } = req.body;
  try {
    const ruleAnswer = await findAnswer(message, memberId);
    if (ruleAnswer) {
      if (message !== "내 아이디") await saveConversationLog(memberId, message, ruleAnswer.text);
      return res.json(ruleAnswer);
    }
    const docs = findRelevantContent(message);
    let gptAnswer = await getGPT3TurboResponse(message, docs);
    gptAnswer = formatResponseText(gptAnswer);
    if (docs.length === 0) gptAnswer += FALLBACK_MESSAGE_HTML;
    await saveConversationLog(memberId, message, gptAnswer);
    res.json({ text: gptAnswer });
  } catch (e) { res.status(500).json({ text: "오류 발생" }); }
});

async function saveConversationLog(mid, uMsg, bRes) {
  await runDb(async (db) => {
    await db.collection("conversationLogs").updateOne(
      { memberId: mid || null, date: new Date().toISOString().split("T")[0] },
      { $push: { conversation: { userMessage: uMsg, botResponse: bRes, createdAt: new Date() } } },
      { upsert: true }
    );
  });
}

// ========== [기타 API: 포스트잇/엑셀] ==========
app.get("/postIt", async (req, res) => {
  const p = parseInt(req.query.page)||1; const l=300;
  await runDb(async (db) => {
    const n = await db.collection("postItNotes").find({}).sort({_id:-1}).skip((p-1)*l).limit(l).toArray();
    const t = await db.collection("postItNotes").countDocuments({});
    res.json({notes:n, totalCount:t});
  });
});
app.post("/postIt", async(req,res)=>{ await runDb(async(db)=>{ await db.collection("postItNotes").insertOne({...req.body,createdAt:new Date()}); await updateSearchableData(); res.json({message:"OK"}); }); });
app.put("/postIt/:id", async(req,res)=>{ await runDb(async(db)=>{ await db.collection("postItNotes").updateOne({_id:new ObjectId(req.params.id)},{$set:{...req.body,updatedAt:new Date()}}); await updateSearchableData(); res.json({message:"OK"}); }); });
app.delete("/postIt/:id", async(req,res)=>{ await runDb(async(db)=>{ await db.collection("postItNotes").deleteOne({_id:new ObjectId(req.params.id)}); await updateSearchableData(); res.json({message:"OK"}); }); });

app.get('/chatConnet', async(req,res)=>{ 
  await runDb(async(db)=>{
    const d=await db.collection("conversationLogs").find({}).toArray();
    const wb=new ExcelJS.Workbook();const ws=wb.addWorksheet('Log');ws.columns=[{header:'ID',key:'m'},{header:'Date',key:'d'},{header:'Log',key:'c'}];
    d.forEach(r=>ws.addRow({m:r.memberId||'Guest',d:r.date,c:JSON.stringify(r.conversation)}));
    res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");res.setHeader("Content-Disposition","attachment; filename=log.xlsx");
    await wb.xlsx.write(res);res.end();
  });
});

const transporter = nodemailer.createTransport({host:SMTP_HOST,port:Number(SMTP_PORT),secure:SMTP_SECURE==='true',auth:{user:SMTP_USER,pass:SMTP_PASS}});
app.post('/send-email', upload.single('attachment'), async(req,res)=>{ try{
  await transporter.sendMail({from:req.body.companyName,to:'contact@yogico.kr',replyTo:req.body.companyEmail,subject:`Contact: ${req.body.companyName}`,text:req.body.message,attachments:req.file?[{path:req.file.path}]:[]});
  res.json({success:true});}catch(e){res.status(500).json({success:false,error:e.message})} });


// ============================================
// [Temple 기능 통합구역 - 원본 로직 그대로 복원]
// ============================================

// 1. FTP Upload (Advanced Version - User Provided)
const FTP_PUBLIC_URL_BASE = (FTP_PUBLIC_BASE || `http://${MALL_ID}.openhost.cafe24.com/web/img/temple`).replace(/\/+$/,'');

app.post('/api/:_any/uploads/image', upload.single('file'), async (req, res) => {
  const localPath = req.file?.path; const filename = req.file?.filename;
  if (!localPath || !filename) return res.status(400).json({ error: '파일이 없습니다.' });

  const client = new ftp.Client(15000); client.ftp.verbose = false;
  try {
    await client.access({ host: FTP_HOST, user: FTP_USER, password: FTP_PASS, secure: false });
    const ymd = dayjs().format('YYYY/MM/DD');
    const relSuffix = `${MALL_ID}/${ymd}`;
    const baseCandidates = ['web/img/temple/uploads', 'img/temple/uploads', 'temple/uploads'];

    let finalPwd = null;
    let usedBase = null;
    for (const base of baseCandidates) {
      try {
        try { await client.cd('/'); } catch {}
        await client.cd(base);
        await client.ensureDir(relSuffix);
        finalPwd = await client.pwd();
        await client.uploadFrom(localPath, filename);
        usedBase = base;
        const url = `${FTP_PUBLIC_URL_BASE}/uploads/${relSuffix}/${filename}`.replace(/([^:]\/)\/+/g, '$1');
        return res.json({ url, ftpBase: usedBase, ftpDir: finalPwd, ftpPath: `${finalPwd}/${filename}` });
      } catch (e) { continue; }
    }
    return res.status(500).json({ error: '경로 이동 실패', detail: 'uploads 베이스 디렉터리에 진입할 수 없습니다.' });
  } catch (err) {
    console.error('[FTP UPLOAD ERROR]', err);
    return res.status(500).json({ error: '이미지 업로드 실패(FTP)', detail: err?.message || String(err) });
  } finally {
    client.close();
    fs.unlink(localPath, () => {});
  }
});

// 2. Events CRUD (EventTemple)
const EVENT_COLL = 'eventTemple';
function normalizeBlocks(blocks = []) {
  if (!Array.isArray(blocks)) return [];
  return blocks.map(b => (b?.type === 'video' ? { ...b, autoplay: !!b.autoplay } : b));
}

function mountEventRoutes(basePath) {
  // 생성
  app.post(`/api/:_any${basePath}`, async (req, res) => {
    try {
      const payload = req.body || {};
      if (!payload.title) return res.status(400).json({ error: '제목(title)을 입력해주세요.' });
      
      const content = payload.content || {};
      if (Array.isArray(content.blocks)) content.blocks = normalizeBlocks(content.blocks);

      const doc = {
        mallId: MALL_ID,
        title: payload.title.trim(),
        content, 
        images: payload.images || [],
        gridSize: payload.gridSize ?? null,
        layoutType: payload.layoutType || 'none',
        classification: payload.classification || {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await runDb(async (db) => {
        const r = await db.collection(EVENT_COLL).insertOne(doc);
        res.json({ _id: r.insertedId, ...doc });
      });
    } catch (err) { res.status(500).json({ error: '이벤트 생성에 실패했습니다.' }); }
  });

  // 목록
  app.get(`/api/:_any${basePath}`, async (req, res) => {
    await runDb(async (db) => {
      const list = await db.collection(EVENT_COLL).find({ mallId: MALL_ID }).sort({ createdAt: -1 }).toArray();
      res.json(list);
    });
  });

  // 상세
  app.get(`/api/:_any${basePath}/:id`, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
    await runDb(async (db) => {
      const ev = await db.collection(EVENT_COLL).findOne({ _id: new ObjectId(req.params.id), mallId: MALL_ID });
      ev ? res.json(ev) : res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
    });
  });

  // 수정
  app.put(`/api/:_any${basePath}/:id`, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
    const p = req.body;
    const set = { updatedAt: new Date() };
    if (p.title) set.title = String(p.title).trim();
    if (p.content) {
      if (Array.isArray(p.content.blocks)) p.content.blocks = normalizeBlocks(p.content.blocks);
      set.content = p.content;
    }
    if (p.images) set.images = p.images;
    if (p.gridSize !== undefined) set.gridSize = p.gridSize;
    if (p.layoutType) set.layoutType = p.layoutType;
    if (p.classification) set.classification = p.classification;

    await runDb(async (db) => {
      const r = await db.collection(EVENT_COLL).updateOne({ _id: new ObjectId(req.params.id), mallId: MALL_ID }, { $set: set });
      res.json({ success: true });
    });
  });

  // 삭제
  app.delete(`/api/:_any${basePath}/:id`, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
    await runDb(async (db) => {
      await db.collection(EVENT_COLL).deleteOne({ _id: new ObjectId(req.params.id), mallId: MALL_ID });
      await Promise.all([
        db.collection(`visits_${MALL_ID}`).deleteMany({ pageId: req.params.id }),
        db.collection(`clicks_${MALL_ID}`).deleteMany({ pageId: req.params.id }),
        db.collection(`prdClick_${MALL_ID}`).deleteMany({ pageId: req.params.id })
      ]);
      res.json({ success: true });
    });
  });
}

mountEventRoutes('/eventTemple');
// Alias for /events (Legacy Support)
app.use('/api/:_any/events', (req, res, next) => { req.url = req.url.replace('/events', '/eventTemple'); next(); });


// 3. Tracking (User's Logic)
app.post('/api/:_any/track', async (req, res) => {
  const { pageId, pageUrl, visitorId, referrer, device, type, element, timestamp, productNo } = req.body;
  if (!pageId || !visitorId || !type || !timestamp) return res.status(400).json({ error: '필수 필드 누락' });
  if (!ObjectId.isValid(pageId)) return res.sendStatus(204);

  const kst = new Date(new Date(timestamp).getTime() + 9*60*60*1000);
  const dateKey = kst.toISOString().slice(0, 10);
  let pathOnly; try { pathOnly = new URL(pageUrl).pathname; } catch { pathOnly = pageUrl; }

  await runDb(async (db) => {
    // 상품 클릭
    if (type === 'click' && element === 'product' && productNo) {
      let productName = null;
      try {
        const productRes = await apiRequest('GET', `https://${MALL_ID}.cafe24api.com/api/v2/admin/products/${productNo}`, {}, { shop_no: 1 });
        const prod = productRes.product || productRes.products?.[0];
        productName = prod?.product_name || null;
      } catch (e) {}

      await db.collection(`prdClick_${MALL_ID}`).updateOne(
        { pageId, productNo },
        { 
          $inc: { clickCount: 1 }, 
          $setOnInsert: { productName, firstClickAt: kst, pageUrl: pathOnly, referrer: referrer||null, device: device||null }, 
          $set: { lastClickAt: kst } 
        },
        { upsert: true }
      );
    } 
    // 쿠폰 클릭
    else if (type === 'click' && element === 'coupon') {
        const coupons = Array.isArray(productNo) ? productNo : [productNo];
        await Promise.all(coupons.map(cpn => 
          db.collection(`clicks_${MALL_ID}`).insertOne({
            pageId, visitorId, dateKey, pageUrl: pathOnly, referrer, device, type, element, timestamp: kst, couponNo: cpn
          })
        ));
    }
    // URL 클릭 및 기타
    else if (type === 'click') {
        await db.collection(`clicks_${MALL_ID}`).insertOne({
            pageId, visitorId, dateKey, pageUrl: pathOnly, referrer, device, type, element, timestamp: kst
        });
    }
    // 조회/재방문
    else {
      const update = { $set: { lastVisit: kst, pageUrl: pathOnly, referrer, device }, $setOnInsert: { firstVisit: kst }, $inc: {} };
      if (type === 'view') update.$inc.viewCount = 1;
      if (type === 'revisit') update.$inc.revisitCount = 1;
      await db.collection(`visits_${MALL_ID}`).updateOne({ pageId, visitorId, dateKey }, update, { upsert: true });
    }
  });
  res.sendStatus(204);
});


// 4. Cafe24 Integration (Category/Coupon/Product) - ★ Full User Logic (Complex)
app.get('/api/:_any/categories/all', async (req, res) => {
  try {
    const all = []; let offset = 0, limit = 100;
    while(true) {
      const d = await apiRequest('GET', `https://${MALL_ID}.cafe24api.com/api/v2/admin/categories`, {}, { limit, offset });
      if (!d.categories?.length) break;
      all.push(...d.categories); offset += d.categories.length;
    }
    res.json(all);
  } catch (e) { res.status(500).json({ message: '전체 카테고리 조회 실패', error: e.message }); }
});

app.get('/api/:_any/coupons', async (req, res) => {
  try {
    const all = []; let offset = 0, limit = 100;
    while(true) {
      const d = await apiRequest('GET', `https://${MALL_ID}.cafe24api.com/api/v2/admin/coupons`, {}, { shop_no: 1, limit, offset });
      if (!d.coupons?.length) break;
      all.push(...d.coupons); offset += d.coupons.length;
    }
    res.json(all);
  } catch (e) { res.status(500).json({ message: '쿠폰 조회 실패', error: e.message }); }
});

// ★ [Complex] 카테고리별 상품 목록 + 쿠폰/할인 계산
app.get('/api/:_any/categories/:category_no/products', async (req, res) => {
  const { category_no } = req.params;
  try {
    const coupon_nos = (req.query.coupon_no||'').split(',').filter(Boolean);
    const limit = parseInt(req.query.limit, 10)||100;
    const offset = parseInt(req.query.offset, 10)||0;
    const shop_no = 1;

    // 1. 쿠폰 로드
    const coupons = await Promise.all(coupon_nos.map(async no => {
      const d = await apiRequest('GET', `https://${MALL_ID}.cafe24api.com/api/v2/admin/coupons`, {}, { shop_no, coupon_no: no, fields: 'coupon_no,available_product,available_product_list,available_category,available_category_list,benefit_amount,benefit_percentage' });
      return d.coupons?.[0] || null;
    }));
    const validCoupons = coupons.filter(Boolean);

    // 2. 카테고리 상품
    const catRes = await apiRequest('GET', `https://${MALL_ID}.cafe24api.com/api/v2/admin/categories/${category_no}/products`, {}, { shop_no, display_group: 1, limit, offset });
    const sorted = (catRes.products||[]).slice().sort((a,b)=>a.sequence_no-b.sequence_no);
    const productNos = sorted.map(p=>p.product_no);
    if (!productNos.length) return res.json([]);

    // 3. 상품 상세
    const detailRes = await apiRequest('GET', `https://${MALL_ID}.cafe24api.com/api/v2/admin/products`, {}, { shop_no, product_no: productNos.join(','), limit: productNos.length, fields: 'product_no,product_name,price,summary_description,list_image,icons,product_tags' });
    const detailMap = (detailRes.products||[]).reduce((m,p)=>{m[p.product_no]=p; return m;}, {});

    // 4. 아이콘 & 할인 (병렬)
    const iconResults = await Promise.all(productNos.map(async no => {
        try {
            const iRes = await apiRequest('GET', `https://${MALL_ID}.cafe24api.com/api/v2/admin/products/${no}/icons`, {}, { shop_no });
            const iconsData = iRes?.icons;
            let imageList = [];
            if(iconsData) {
                if(iconsData.use_show_date !== 'T') imageList = iconsData.image_list||[];
                else {
                    const now = new Date();
                    if(now >= new Date(iconsData.show_start_date) && now < new Date(iconsData.show_end_date)) imageList = iconsData.image_list||[];
                }
            }
            return { product_no: no, customIcons: imageList.map(i=>({icon_url: i.path, icon_alt: i.code})) };
        } catch { return { product_no: no, customIcons: [] }; }
    }));
    const iconsMap = iconResults.reduce((m,i)=>{m[i.product_no]=i.customIcons; return m;}, {});

    const discountMap = {};
    await Promise.all(productNos.map(async no => {
        try {
            const d = await apiRequest('GET', `https://${MALL_ID}.cafe24api.com/api/v2/admin/products/${no}/discountprice`, {}, { shop_no });
            discountMap[no] = d.discountprice?.pc_discount_price!=null ? parseFloat(d.discountprice.pc_discount_price) : null;
        } catch {}
    }));

    const formatKRW = num => num!=null ? Number(num).toLocaleString('ko-KR') + '원' : null;

    // 5. 조합 & 쿠폰 계산
    const result = sorted.map(item => {
        const prod = detailMap[item.product_no]; if(!prod) return null;
        
        // 쿠폰 계산 함수 (User's logic)
        const couponInfos = validCoupons.map(coupon => {
            const pList = coupon.available_product_list || [];
            const cList = coupon.available_category_list || [];
            const prodOk = coupon.available_product==='U' || (coupon.available_product==='I' && pList.includes(item.product_no)) || (coupon.available_product==='E' && !pList.includes(item.product_no));
            const catOk = coupon.available_category==='U' || (coupon.available_category==='I' && cList.includes(parseInt(category_no,10))) || (coupon.available_category==='E' && !cList.includes(parseInt(category_no,10)));
            if(!prodOk || !catOk) return null;

            const orig = parseFloat(prod.price||0);
            const pct = parseFloat(coupon.benefit_percentage||0), amt = parseFloat(coupon.benefit_amount||0);
            let bPrice = null;
            if(pct>0) bPrice = +(orig*(100-pct)/100).toFixed(2);
            else if(amt>0) bPrice = +(orig-amt).toFixed(2);
            if(bPrice==null) return null;
            return { coupon_no: coupon.coupon_no, benefit_percentage: pct, benefit_price: bPrice };
        }).filter(Boolean).sort((a,b)=>b.benefit_percentage-a.benefit_percentage);

        const first = couponInfos[0];
        return {
            product_no: item.product_no, product_name: prod.product_name, price: formatKRW(parseFloat(prod.price)),
            summary_description: prod.summary_description, list_image: prod.list_image,
            sale_price: (discountMap[item.product_no]!=null && +discountMap[item.product_no]!==+prod.price) ? formatKRW(discountMap[item.product_no]) : null,
            benefit_price: first ? formatKRW(first.benefit_price) : null, benefit_percentage: first?.benefit_percentage,
            couponInfos: couponInfos.length ? couponInfos : null,
            icons: prod.icons, additional_icons: iconsMap[item.product_no]||[], product_tags: prod.product_tags
        };
    }).filter(Boolean);

    res.json(result);
  } catch (err) { res.status(err.response?.status||500).json({ message: '카테고리 상품 조회 실패', error: err.message }); }
});

// 전체 상품 조회
app.get('/api/:_any/products', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const params = { shop_no: 1, limit: 1000, offset: req.query.offset || 0 };
    if (q) params['search[product_name]'] = q;
    const d = await apiRequest('GET', `https://${MALL_ID}.cafe24api.com/api/v2/admin/products`, {}, params);
    const slim = (d.products || []).map(p => ({ product_no: p.product_no, product_code: p.product_code, product_name: p.product_name, price: p.price, list_image: p.list_image }));
    res.json({ products: slim, total: d.total_count });
  } catch (e) { res.status(500).json({ error: '전체 상품 조회 실패' }); }
});

// ★ 단일 상품 (Full User Logic)
app.get('/api/:_any/products/:product_no', async (req, res) => {
  const { product_no } = req.params;
  try {
    const shop_no = 1;
    const coupon_nos = (req.query.coupon_no||'').split(',').filter(Boolean);

    // 기본정보
    const pRes = await apiRequest('GET', `https://${MALL_ID}.cafe24api.com/api/v2/admin/products/${product_no}`, {}, { shop_no, fields: 'product_no,product_code,product_name,price,summary_description,list_image,icons,product_tags' });
    const p = pRes.product || pRes.products?.[0];
    if (!p) return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });

    // 아이콘 & 할인
    let customIcons = [];
    try {
        const iRes = await apiRequest('GET', `https://${MALL_ID}.cafe24api.com/api/v2/admin/products/${product_no}/icons`, {}, { shop_no });
        const iData = iRes?.icons;
        if(iData) {
            let list = [];
            if(iData.use_show_date !== 'T') list = iData.image_list||[];
            else {
                const now = new Date();
                if(now >= new Date(iData.show_start_date) && now < new Date(iData.show_end_date)) list = iData.image_list||[];
            }
            customIcons = list.map(i=>({icon_url: i.path, icon_alt: i.code}));
        }
    } catch {}
    
    let sale_price = null;
    try {
        const dRes = await apiRequest('GET', `https://${MALL_ID}.cafe24api.com/api/v2/admin/products/${product_no}/discountprice`, {}, { shop_no });
        sale_price = dRes.discountprice?.pc_discount_price!=null ? parseFloat(dRes.discountprice.pc_discount_price) : null;
    } catch {}

    // 쿠폰
    const coupons = await Promise.all(coupon_nos.map(async no => {
        const d = await apiRequest('GET', `https://${MALL_ID}.cafe24api.com/api/v2/admin/coupons`, {}, { shop_no, coupon_no: no, fields: 'coupon_no,available_product,available_product_list,available_category,available_category_list,benefit_amount,benefit_percentage' });
        return d.coupons?.[0];
    }));
    
    let benefit_price = null, benefit_percentage = null;
    coupons.filter(Boolean).forEach(cpn => {
        const pList = cpn.available_product_list||[];
        const ok = cpn.available_product==='U' || (cpn.available_product==='I' && pList.includes(parseInt(product_no))) || (cpn.available_product==='E' && !pList.includes(parseInt(product_no)));
        if(!ok) return;

        const orig = parseFloat(p.price);
        const pct = parseFloat(cpn.benefit_percentage||0), amt = parseFloat(cpn.benefit_amount||0);
        let bPrice = pct>0 ? +((orig*(100-pct))/100).toFixed(2) : +(orig-amt).toFixed(2);
        if(bPrice!=null && pct>(benefit_percentage||0)) { benefit_percentage = pct; benefit_price = bPrice; }
    });

    res.json({ ...p, sale_price, benefit_price, benefit_percentage, additional_icons: customIcons });
  } catch (e) { res.status(500).json({ error: '단일 상품 조회 실패' }); }
});

// 5. Analytics (Full User Logic)
app.get('/api/:_any/analytics/:pageId/visitors-by-date', async (req, res) => {
  const { pageId } = req.params; const { start_date, end_date, url } = req.query;
  if(!start_date || !end_date) return res.status(400).json({ error: 'Date required' });
  const match = { pageId, dateKey: { $gte: start_date.slice(0,10), $lte: end_date.slice(0,10) } };
  if(url) match.pageUrl = url;
  
  await runDb(async (db) => {
    const stats = await db.collection(`visits_${MALL_ID}`).aggregate([
      { $match: match },
      { $group: { _id: { date: '$dateKey', visitorId: '$visitorId' }, viewCount: { $sum: { $ifNull: ['$viewCount',0] } }, revisitCount: { $sum: { $ifNull: ['$revisitCount',0] } } } },
      { $group: { _id: '$_id.date', totalVisitors: { $sum: 1 }, newVisitors: { $sum: { $cond: [{ $gt: ['$viewCount', 0] }, 1, 0] } }, returningVisitors: { $sum: { $cond: [{ $gt: ['$revisitCount', 0] }, 1, 0] } } } },
      { $project: { _id: 0, date: '$_id', totalVisitors: 1, newVisitors: 1, returningVisitors: 1, revisitRate: { $concat: [ { $toString: { $round: [ { $multiply: [ { $cond: [ { $gt: ['$totalVisitors', 0] }, { $divide: ['$returningVisitors', '$totalVisitors'] }, 0 ] }, 100 ] }, 0 ] } }, ' %' ] } } },
      { $sort: { date: 1 } }
    ]).toArray();
    res.json(stats);
  });
});

app.get('/api/:_any/analytics/:pageId/clicks-by-date', async (req, res) => {
  const { pageId } = req.params; const { start_date, end_date, url } = req.query;
  if(!start_date || !end_date) return res.status(400).json({ error: 'Date required' });
  const match = { pageId, dateKey: { $gte: start_date.slice(0,10), $lte: end_date.slice(0,10) } };
  if(url) match.pageUrl = url;

  await runDb(async (db) => {
    const data = await db.collection(`clicks_${MALL_ID}`).aggregate([
      { $match: match },
      { $group: { _id: { date: '$dateKey', element: '$element' }, count: { $sum: 1 } } },
      { $group: { _id: '$_id.date', url: { $sum: { $cond: [{ $eq: ['$_id.element','url'] }, '$count', 0] } }, product: { $sum: { $cond: [{ $eq: ['$_id.element','product'] }, '$count', 0] } }, coupon: { $sum: { $cond: [{ $eq: ['$_id.element','coupon'] }, '$count', 0] } } } },
      { $project: { _id: 0, date: '$_id', 'URL 클릭':'$url', 'URL 클릭(기존 product)':'$product', '쿠폰 클릭':'$coupon' } },
      { $sort: { date: 1 } }
    ]).toArray();
    res.json(data);
  });
});

app.get('/api/:_any/analytics/:pageId/coupon-stats', async (req, res) => {
  const { coupon_no, start_date, end_date } = req.query;
  if (!coupon_no) return res.status(400).json({ error: 'coupon_no required' });
  const couponNos = coupon_no.split(',');
  const results = [];
  try {
    for (const no of couponNos) {
      let couponName = '(이름없음)';
      try {
        const nameRes = await apiRequest('GET', `https://${MALL_ID}.cafe24api.com/api/v2/admin/coupons`, {}, { shop_no:1, coupon_no:no, fields:'coupon_name', limit:1 });
        couponName = nameRes.coupons?.[0]?.coupon_name || couponName;
      } catch {}
      
      let issued = 0, used = 0, unused = 0, autoDel = 0;
      const pageSize = 500;
      for (let offset = 0; ; offset += pageSize) {
        const issuesRes = await apiRequest('GET', `https://${MALL_ID}.cafe24api.com/api/v2/admin/coupons/${no}/issues`, {}, { shop_no:1, issued_start_date:start_date, issued_end_date:end_date, limit:pageSize, offset });
        const issues = issuesRes.issues || [];
        if (!issues.length) break;
        issues.forEach(item => {
            issued++;
            if (item.used_coupon === 'T') used++;
            else {
                const exp = item.expiration_date ? new Date(item.expiration_date) : null;
                if (exp && exp < new Date()) autoDel++; else unused++;
            }
        });
      }
      results.push({ couponNo: no, couponName, issuedCount: issued, usedCount: used, unusedCount: unused, autoDeletedCount: autoDel });
    }
    res.json(results);
  } catch (e) { res.status(500).json({ error: '쿠폰 통계 오류', message: e.message }); }
});

app.get('/api/:_any/analytics/:pageId/devices-by-date', async (req, res) => {
  const { pageId } = req.params; const { start_date, end_date, url } = req.query;
  const match = { pageId, dateKey: { $gte: start_date.slice(0,10), $lte: end_date.slice(0,10) } };
  if(url) match.pageUrl = url;
  await runDb(async (db) => {
    const data = await db.collection(`visits_${MALL_ID}`).aggregate([
      { $match: match }, { $group: { _id: { date:'$dateKey', device:'$device' }, count: { $sum:1 } } }, { $project: { _id:0, date:'$_id.date', device:'$_id.device', count:1 } }, { $sort: { date:1 } }
    ]).toArray();
    res.json(data);
  });
});

app.get('/api/:_any/analytics/:pageId/product-performance', async (req, res) => {
  try {
    const clicks = await runDb(async (db) => db.collection(`prdClick_${MALL_ID}`).aggregate([{ $match: { pageId: req.params.pageId } }, { $group: { _id: '$productNo', clicks: { $sum: '$clickCount' } } }]).toArray());
    if (!clicks.length) return res.json([]);
    const productNos = clicks.map(c => c._id);
    const prodRes = await apiRequest('GET', `https://${MALL_ID}.cafe24api.com/api/v2/admin/products`, {}, { shop_no: 1, product_no: productNos.join(','), limit: productNos.length, fields: 'product_no,product_name' });
    const detailMap = (prodRes.products || []).reduce((m,p) => { m[p.product_no]=p.product_name; return m; }, {});
    res.json(clicks.map(c => ({ productNo: c._id, productName: detailMap[c._id] || '이름없음', clicks: c.clicks })).sort((a,b)=>b.clicks-a.clicks));
  } catch (e) { res.status(500).json({ error: '상품 퍼포먼스 집계 실패' }); }
});

app.get('/api/:_any/analytics/:pageId/url-clicks', async (req, res) => {
  const { pageId } = req.params; const { start_date, end_date, url } = req.query;
  const match = { pageId, type:'click', element:'url', timestamp: { $gte: new Date(start_date), $lte: new Date(end_date) } };
  if(url) match.pageUrl = url;
  await runDb(async (db) => { const count = await db.collection(`clicks_${MALL_ID}`).countDocuments(match); res.json({ count }); });
});
app.get('/api/:_any/analytics/:pageId/coupon-clicks', async (req, res) => {
  const { pageId } = req.params; const { start_date, end_date, url } = req.query;
  const match = { pageId, type:'click', element:'coupon', timestamp: { $gte: new Date(start_date), $lte: new Date(end_date) } };
  if(url) match.pageUrl = url;
  await runDb(async (db) => { const count = await db.collection(`clicks_${MALL_ID}`).countDocuments(match); res.json({ count }); });
});
app.get('/api/:_any/analytics/:pageId/urls', async (req, res) => {
  const { pageId } = req.params; await runDb(async (db) => { const urls = await db.collection(`visits_${MALL_ID}`).distinct('pageUrl', { pageId }); res.json(urls); });
});
app.get('/api/:_any/analytics/:pageId/coupons-distinct', async (req, res) => {
  const { pageId } = req.params; await runDb(async (db) => { const list = await db.collection(`clicks_${MALL_ID}`).distinct('couponNo', { pageId, element: 'coupon' }); res.json(list); });
});
app.get('/api/:_any/analytics/:pageId/devices', async (req, res) => {
  const { pageId } = req.params; const { start_date, end_date, url } = req.query;
  const match = { pageId, dateKey: { $gte: start_date.slice(0,10), $lte: end_date.slice(0,10) } }; if(url) match.pageUrl = url;
  await runDb(async (db) => { const data = await db.collection(`visits_${MALL_ID}`).aggregate([{ $match: match }, { $group: { _id: '$device', count: { $sum: { $add: [ { $ifNull: ['$viewCount',0] }, { $ifNull: ['$revisitCount',0] } ] } } } }, { $project: { _id:0, device_type:'$_id', count:1 } }]).toArray(); res.json(data); });
});
app.get('/api/:_any/analytics/:pageId/product-clicks', async (req, res) => {
  const { pageId } = req.params; const { start_date, end_date } = req.query;
  const filter = { pageId }; if (start_date && end_date) filter.lastClickAt = { $gte: new Date(start_date), $lte: new Date(end_date) };
  await runDb(async (db) => { const docs = await db.collection(`prdClick_${MALL_ID}`).find(filter).sort({ clickCount: -1 }).toArray(); res.json(docs.map(d => ({ productNo: d.productNo, clicks: d.clickCount }))); });
});

// ========== [서버 실행] ==========
(async function initialize() {
  try {
    console.log("🟡 서버 시작...");
    await getTokensFromDB();
    await updateSearchableData();
    app.listen(PORT, () => console.log(`🚀 실행 완료: ${PORT}`));
  } catch (err) { console.error("❌ 초기화 오류:", err.message); process.exit(1); }
})();