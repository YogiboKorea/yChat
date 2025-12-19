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
require("dotenv").config();
const nodemailer = require('nodemailer');
const multer = require('multer');
const ftp = require('basic-ftp');
const dayjs = require('dayjs');

// ✅ 정적 FAQ 데이터 불러오기
const staticFaqList = require("./faq");

// ========== [환경 설정] ==========
const {
  ACCESS_TOKEN, REFRESH_TOKEN, CAFE24_CLIENT_ID, CAFE24_CLIENT_SECRET,
  DB_NAME, MONGODB_URI, CAFE24_MALLID, OPEN_URL, API_KEY,
  FINETUNED_MODEL = "gpt-3.5-turbo", CAFE24_API_VERSION = "2024-06-01",
  PORT = 5000, FTP_PUBLIC_BASE,
  SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS
} = process.env;

let accessToken = ACCESS_TOKEN;
let refreshToken = REFRESH_TOKEN;

// ========== [Express 초기화] ==========
const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ========== [글로벌 상태] ==========
let pendingCoveringContext = false;
let allSearchableData = [...staticFaqList];

// ========== [상수: 링크 및 버튼 HTML] ==========

// 1. 상담사 연결 (팝업)
const COUNSELOR_LINKS_HTML = `
<br><br>
📮 <a href="javascript:void(0)" onclick="window.open('http://pf.kakao.com/_lxmZsxj/chat','kakao','width=500,height=600,scrollbars=yes');" style="color:#3b1e1e; font-weight:bold; text-decoration:underline;">카카오플친 연결하기 (팝업)</a><br>
📮 <a href="javascript:void(0)" onclick="window.open('https://talk.naver.com/ct/wc4u67?frm=psf','naver','width=500,height=600,scrollbars=yes');" style="color:#03c75a; font-weight:bold; text-decoration:underline;">네이버톡톡 연결하기 (팝업)</a>
`;

// 2. 답변 하단 기본 문구
const FALLBACK_MESSAGE_HTML = `
<br><br>
---------------------------------<br>
<strong>정확한 답변 확인을 위해 상담사 연결을 통해 진행하시겠습니까?</strong>
${COUNSELOR_LINKS_HTML}
`;

// 3. 로그인 버튼 (스타일 적용)
const LOGIN_BTN_HTML = `
<div style="margin-top:15px;">
  <a href="/member/login.html" style="
    display: inline-block;
    padding: 10px 20px;
    background-color: #58b5ca;
    color: #ffffff;
    text-decoration: none;
    border-radius: 25px;
    font-weight: bold;
    font-size: 14px;
    box-shadow: 0 2px 5px rgba(0,0,0,0.1);
  ">로그인 페이지 이동하기 →</a>
</div>
`;

// ========== [시스템 프롬프트 설정] ==========
function convertPromptLinks(promptText) { return promptText; }

const basePrompt = `
1. 역할 및 말투
전문가 역할: 요기보(Yogibo) 브랜드의 전문 상담원입니다.
존대 및 공손: 고객에게 항상 존댓말과 공손한 말투를 사용합니다.
이모티콘 활용: 대화 중 적절히 이모티콘을 사용합니다.

2. ★ 답변 원칙 (매우 중요)
제공된 [참고 정보]에 있는 내용으로만 답변하세요.
"엔젤 비즈", "마이크로 비즈" 등 요기보 제품이 아닌 용어는 절대 사용하지 마세요.
[참고 정보]에 없는 내용은 솔직하게 모른다고 하고 상담원 연결을 권유하세요.
없는 정보를 지어내면 해고됩니다.

3. ★ 추천상품
고객이 추천 상품을 원할경우 요기보의 대표상품 맥스를 추천 해주면되
또한 나머지 추천 상품에 대해서도 사이즈 정보에 올라가 있는 제품 명을 기준으로
추천 해서 사용하면 됩니다.
`;


const YOGIBO_SYSTEM_PROMPT = convertPromptLinks(basePrompt);

// ========== [데이터 로딩] ==========
const companyDataPath = path.join(__dirname, "json", "companyData.json");
let companyData = {};
try {
  if (fs.existsSync(companyDataPath)) {
    companyData = JSON.parse(fs.readFileSync(companyDataPath, "utf-8"));
  }
} catch (e) { console.error("companyData load fail", e); }

// ========== [MongoDB 토큰 관리] ==========
const tokenCollectionName = "tokens";
async function getTokensFromDB() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const doc = await client.db(DB_NAME).collection(tokenCollectionName).findOne({});
    if (doc) { accessToken = doc.accessToken; refreshToken = doc.refreshToken; }
    else { await saveTokensToDB(accessToken, refreshToken); }
  } finally { await client.close(); }
}
async function saveTokensToDB(at, rt) {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    await client.db(DB_NAME).collection(tokenCollectionName).updateOne({}, { $set: { accessToken: at, refreshToken: rt, updatedAt: new Date() } }, { upsert: true });
  } finally { await client.close(); }
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

// ========== [RAG 로직] ==========
async function updateSearchableData() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const notes = await client.db(DB_NAME).collection("postItNotes").find({}).toArray();
    const dynamic = notes.map(n => ({ c: n.category || "etc", q: n.question, a: n.answer }));
    allSearchableData = [...staticFaqList, ...dynamic];
    console.log(`✅ 검색 데이터 갱신: ${allSearchableData.length}개`);
  } catch (err) { console.error("데이터 갱신 실패:", err); } finally { await client.close(); }
}

function findRelevantContent(msg) {
  const kws = msg.split(/\s+/).filter(w => w.length > 1);
  if (!kws.length) return [];
  const scored = allSearchableData.map(i => {
    let s = 0; const q = (i.q||"").toLowerCase(), a = (i.a||"").toLowerCase();
    kws.forEach(w => { if(q.includes(w)) s+=5; if(a.includes(w)) s+=2; });
    return { ...i, score: s };
  });
  return scored.filter(i => i.score > 0).sort((a, b) => b.score - a.score).slice(0, 4);
}

async function getGPT3TurboResponse(input, context = []) {
  const txt = context.map(i => `Q: ${i.q}\nA: ${i.a}`).join("\n\n");
  const sys = `${YOGIBO_SYSTEM_PROMPT}\n[참고 정보]\n${txt || "정보 없음."}`;
  try {
    const res = await axios.post(OPEN_URL, {
      model: FINETUNED_MODEL, messages: [{ role: "system", content: sys }, { role: "user", content: input }]
    }, { headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' } });
    return res.data.choices[0].message.content;
  } catch (e) { return "답변 생성 중 문제가 발생했습니다."; }
}

// ========== [유틸 함수] ==========
function normalizeSentence(s) { return s.replace(/[?!！？]/g, "").replace(/없나요/g, "없어요").trim(); }
function containsOrderNumber(s) { return /\d{8}-\d{7}/.test(s); }
function addSpaceAfterPeriod(t) { return t.replace(/\.([^\s])/g, '. $1'); }

// ✅ [로그인 체크]
function isUserLoggedIn(id) {
  if (!id) return false;
  if (id === "null") return false;
  if (id === "undefined") return false;
  if (String(id).trim() === "") return false;
  return true;
}

// ========== [배송 조회 함수] ==========
async function getOrderShippingInfo(id) {
  const today = new Date();
  const start = new Date(); start.setDate(today.getDate() - 14);
  return apiRequest("GET", `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`, {}, {
    member_id: id, start_date: start.toISOString().split('T')[0], end_date: today.toISOString().split('T')[0], limit: 10
  });
}

// ✅ [수정] 배송 상세 + 송장번호 링크 생성
async function getShipmentDetail(orderId) {
  const API_URL = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders/${orderId}/shipments`;
  try {
    const response = await apiRequest("GET", API_URL, {}, { shop_no: 1 });
    
    // 디버깅 로그
    console.log(`[배송조회] ${orderId}:`, JSON.stringify(response));

    if (response.shipments && response.shipments.length > 0) {
      const shipment = response.shipments[0];
      
      // 택배사별 URL 매핑 정보
      const carrierMap = {
        "0019": { name: "롯데 택배", url: "https://www.lotteglogis.com/home/reservation/tracking/linkView?InvNo=" },
        "0039": { name: "경동 택배", url: "https://kdexp.com/service/delivery/tracking.do?barcode=" },
        "0023": { name: "경동 택배", url: "https://kdexp.com/service/delivery/tracking.do?barcode=" }
      };

      const carrierInfo = carrierMap[shipment.shipping_company_code] || { name: shipment.shipping_company_name || "지정 택배사", url: "" };
      
      // 정보 주입
      shipment.shipping_company_name = carrierInfo.name;
      
      // ✅ 송장번호가 있고 URL 패턴이 있으면 전체 추적 링크 생성
      if (shipment.tracking_no && carrierInfo.url) {
        shipment.tracking_url = carrierInfo.url + shipment.tracking_no;
      } else {
        shipment.tracking_url = null;
      }

      return shipment;
    }
    return null;
  } catch (error) {
    console.error("Error fetching shipment:", error.message);
    throw error;
  }
}

// ========== [★ 핵심 로직: findAnswer] ==========
async function findAnswer(userInput, memberId) {
  const normalized = normalizeSentence(userInput);

  // 1. 상담사 연결
  if (normalized.includes("상담사 연결") || normalized.includes("상담원 연결")) {
    return { text: `상담사와 연결을 도와드리겠습니다.${COUNSELOR_LINKS_HTML}` };
  }

  // 2. 매장 안내
  if (normalized.includes("오프라인 매장") || normalized.includes("매장안내")) {
    return { text: `가까운 매장을 안내해 드립니다.<br><a href="/why.stroe.html" target="_blank">매장안내 바로가기</a>` };
  }

  // 3. 내 아이디 조회
  if (normalized.includes("내 아이디") || normalized.includes("아이디 조회")) {
    return isUserLoggedIn(memberId)
      ? { text: `안녕하세요 ${memberId} 고객님, 무엇을 도와드릴까요?` }
      : { text: `로그인이 필요한 서비스입니다.<br>아래 버튼을 눌러 로그인해주세요.${LOGIN_BTN_HTML}` };
  }

  // 4. 주문번호로 배송 조회
  if (containsOrderNumber(normalized)) {
    if (isUserLoggedIn(memberId)) {
      try {
        const orderId = normalized.match(/\d{8}-\d{7}/)[0];
        const ship = await getShipmentDetail(orderId);
        
        if (ship) {
            const status = ship.status || "배송 준비중";
            
            // ✅ 송장번호 표시 및 링크 생성 (송장 있으면 링크 걸기)
            let trackingDisplay = "등록 대기중";
            if (ship.tracking_no) {
                if (ship.tracking_url) {
                    trackingDisplay = `<a href="${ship.tracking_url}" target="_blank" style="color:#58b5ca; font-weight:bold; text-decoration:underline;">${ship.tracking_no}</a> (클릭)`;
                } else {
                    trackingDisplay = ship.tracking_no;
                }
            }

            return {
                text: `주문번호 <strong>${orderId}</strong>의 배송 상태는 <strong>${status}</strong>입니다.<br>
                       🚚 택배사: ${ship.shipping_company_name}<br>
                       📄 송장번호: ${trackingDisplay}`
            };
        } else {
            return { text: "해당 주문번호의 배송 정보를 찾을 수 없습니다." };
        }
      } catch (e) { return { text: "조회 오류가 발생했습니다." }; }
    }
    return { text: `정확한 조회를 위해 로그인이 필요합니다.${LOGIN_BTN_HTML}` };
  }

  // 5. 일반 배송/주문 조회
  if ((normalized.includes("배송") || normalized.includes("주문상태") || normalized.includes("배송정보")) && !containsOrderNumber(normalized)) {
    if (isUserLoggedIn(memberId)) {
      try {
        const data = await getOrderShippingInfo(memberId);
        if (data.orders?.[0]) {
          const t = data.orders[0];
          const ship = await getShipmentDetail(t.order_id);
          
          if (ship) {
             // ✅ 최근 주문 조회 시에도 송장번호 링크 적용
             let trackingDisplay = "등록 대기중";
             if (ship.tracking_no) {
                 if (ship.tracking_url) {
                     trackingDisplay = `<a href="${ship.tracking_url}" target="_blank" style="color:#58b5ca; font-weight:bold; text-decoration:underline;">${ship.tracking_no}</a>`;
                 } else {
                     trackingDisplay = ship.tracking_no;
                 }
             }
             
             return { text: `최근 주문(<strong>${t.order_id}</strong>)은 <strong>${ship.shipping_company_name}</strong> 배송 중입니다.<br>📄 송장번호: ${trackingDisplay}` };
          }
          return { text: "최근 주문 확인 중입니다." };
        }
        return { text: "최근 2주 내 주문 내역이 없습니다." };
      } catch (e) { return { text: "조회 실패." }; }
    } else {
      return { text: `배송정보를 확인하시려면 로그인이 필요합니다.<br>아래 버튼을 이용해 주세요.${LOGIN_BTN_HTML}` };
    }
  }

  // [JSON 하드코딩 로직들]

  // (1) 커버링
  if (pendingCoveringContext) {
    const types = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
    if (types.includes(normalized)) {
      const key = `${normalized} 커버링 방법을 알고 싶어`;
      pendingCoveringContext = false;
      if (companyData.covering?.[key]) return { text: companyData.covering[key].answer, videoHtml: `<iframe width="100%" height="auto" src="${companyData.covering[key].videoUrl}" frameborder="0" allowfullscreen></iframe>` };
    }
  }
  if (normalized.includes("커버링") && normalized.includes("방법")) {
    const types = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
    const found = types.find(t => normalized.includes(t));
    if (found) {
      const key = `${found} 커버링 방법을 알고 싶어`;
      if (companyData.covering?.[key]) return { text: companyData.covering[key].answer, videoHtml: `<iframe width="100%" height="auto" src="${companyData.covering[key].videoUrl}" frameborder="0" allowfullscreen></iframe>` };
    } else {
      pendingCoveringContext = true;
      return { text: "어떤 커버링을 알고 싶으신가요? (맥스, 더블, 슬림 등)" };
    }
  }

  // (2) 사이즈
  if (normalized.includes("사이즈") || normalized.includes("크기")) {
    const types = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
    for (let t of types) {
      if (normalized.includes(t) && companyData.sizeInfo?.[`${t} 사이즈 또는 크기.`]) {
        return { text: companyData.sizeInfo[`${t} 사이즈 또는 크기.`].description, imageUrl: companyData.sizeInfo[`${t} 사이즈 또는 크기.`].imageUrl };
      }
    }
  }

  // (4) 비즈 안내 (로직 강화)
  if (normalized.includes("비즈") || normalized.includes("충전재") || normalized.includes("알갱이")) {
    let key = null;

    if (normalized.includes("프리미엄 플러스")) key = "프리미엄 플러스 비즈 에 대해 알고 싶어";
    else if (normalized.includes("프리미엄")) key = "프리미엄 비즈 에 대해 알고 싶어";
    else if (normalized.includes("스탠다드")) key = "스탠다드 비즈 에 대해 알고 싶어";
    
    // 특정 비즈 설명이 있으면 출력
    if (key && companyData.biz?.[key]) {
        return { text: companyData.biz[key].description };
    }

    // ✅ [추가] 그냥 '비즈'만 물어본 경우 -> AI가 지어내지 않게 "요기보 정품 비즈 3종"을 강제로 답변
    return {
      text: `요기보의 정품 비즈(충전재)는 3가지 종류가 있습니다. 😊<br><br>
      1️⃣ <strong>스탠다드 비즈</strong>: 전세계 빈백소파에 가장 많이 사용 되는 충전재입니다. 편안함과 부드러운 사용감에 초점이 맞춰져 있어요. Yogibo의 트랜스포밍 기능을 사용하는데 최적화 되어있는 비즈입니다.<br>
      2️⃣ <strong>프리미엄 비즈</strong>: Yogibo에서 개발하여, 국내 독점으로 사용하고 있는 신소재(HRF)에요. 스탠다드 비즈의 부드러움과 편안함을 유지하고, 복원력과 내구성은 월등히 업그레이드 한 비즈입니다.<br>
      3️⃣ <strong>프리미엄 플러스</strong>:스탠다드 비즈 대비 복원력과 내구성이 10배 이상 업그레이드 된 차세대 비즈에요. 집 뿐만 아니라 많은 사람들이 이용하는 공용 공간에 최적화된 비즈입니다.<br><br>
      궁금하신 비즈 이름을 말씀해주시면 더 자세히 알려드릴게요! (예: "프리미엄 비즈 알려줘")`
    };
  }

  
  // (4) 기타 정보
  if (companyData.goodsInfo) {
    let b=null, m=6; for(let k in companyData.goodsInfo){const d=levenshtein.get(normalized,normalizeSentence(k));if(d<m){m=d;b=companyData.goodsInfo[k];}}
    if(b) return { text: Array.isArray(b.description)?b.description.join("\n"):b.description, imageUrl: b.imageUrl };
  }
  if (companyData.homePage) {
    let b=null, m=5; for(let k in companyData.homePage){const d=levenshtein.get(normalized,normalizeSentence(k));if(d<m){m=d;b=companyData.homePage[k];}}
    if(b) return { text: b.description };
  }
  if (companyData.asInfo) {
    let b=null, m=8; for(let k in companyData.asInfo){const d=levenshtein.get(normalized,normalizeSentence(k));if(d<m){m=d;b=companyData.asInfo[k];}}
    if(b) return { text: b.description };
  }

  return null;
}

// ========== [Chat 요청 처리] ==========
app.post("/chat", async (req, res) => {
  const { message, memberId } = req.body;
  if (!message) return res.status(400).json({ error: "No message" });

  try {
    const ruleAnswer = await findAnswer(message, memberId);
    if (ruleAnswer) {
      if (message !== "내 아이디") await saveConversationLog(memberId, message, ruleAnswer.text);
      return res.json(ruleAnswer);
    }

    const docs = findRelevantContent(message);
    let gptAnswer = await getGPT3TurboResponse(message, docs);
    gptAnswer = addSpaceAfterPeriod(gptAnswer) + FALLBACK_MESSAGE_HTML;

    await saveConversationLog(memberId, message, gptAnswer);
    res.json({ text: gptAnswer, videoHtml: null });

  } catch (e) {
    console.error(e);
    res.status(500).json({ text: "오류가 발생했습니다." });
  }
});

async function saveConversationLog(mid, uMsg, bRes) {
  const client = new MongoClient(MONGODB_URI);
  try { await client.connect();
    await client.db(DB_NAME).collection("conversationLogs").updateOne(
      { memberId: mid || null, date: new Date().toISOString().split("T")[0] },
      { $push: { conversation: { userMessage: uMsg, botResponse: bRes, createdAt: new Date() } } },
      { upsert: true }
    );
  } finally { await client.close(); }
}

// ========== [기타 API들 (기존 유지)] ==========
app.get("/postIt", async (req, res) => {
  const p = parseInt(req.query.page)||1; const l=300;
  try { const c=new MongoClient(MONGODB_URI); await c.connect();
    const f = req.query.category?{category:req.query.category}:{};
    const n = await c.db(DB_NAME).collection("postItNotes").find(f).sort({_id:-1}).skip((p-1)*l).limit(l).toArray();
    const t = await c.db(DB_NAME).collection("postItNotes").countDocuments(f);
    await c.close(); res.json({notes:n, totalCount:t, currentPage:p});
  } catch(e){res.status(500).json({error:e.message})}
});
app.post("/postIt", async(req,res)=>{ try{const c=new MongoClient(MONGODB_URI);await c.connect();await c.db(DB_NAME).collection("postItNotes").insertOne({...req.body,createdAt:new Date()});await c.close();await updateSearchableData();res.json({message:"OK"})}catch(e){res.status(500).json({error:e.message})} });
app.put("/postIt/:id", async(req,res)=>{ try{const c=new MongoClient(MONGODB_URI);await c.connect();await c.db(DB_NAME).collection("postItNotes").updateOne({_id:new ObjectId(req.params.id)},{$set:{...req.body,updatedAt:new Date()}});await c.close();await updateSearchableData();res.json({message:"OK"})}catch(e){res.status(500).json({error:e.message})} });
app.delete("/postIt/:id", async(req,res)=>{ try{const c=new MongoClient(MONGODB_URI);await c.connect();await c.db(DB_NAME).collection("postItNotes").deleteOne({_id:new ObjectId(req.params.id)});await c.close();await updateSearchableData();res.json({message:"OK"})}catch(e){res.status(500).json({error:e.message})} });

app.get('/chatConnet', async(req,res)=>{ try{const c=new MongoClient(MONGODB_URI);await c.connect();const d=await c.db(DB_NAME).collection("conversationLogs").find({}).toArray();await c.close();
  const wb=new ExcelJS.Workbook();const ws=wb.addWorksheet('Log');ws.columns=[{header:'ID',key:'m'},{header:'Date',key:'d'},{header:'Log',key:'c'}];
  d.forEach(r=>ws.addRow({m:r.memberId||'Guest',d:r.date,c:JSON.stringify(r.conversation)}));
  res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");res.setHeader("Content-Disposition","attachment; filename=log.xlsx");
  await wb.xlsx.write(res);res.end();}catch(e){res.status(500).send("Err")} });

const upload = multer({storage:multer.diskStorage({destination:(r,f,c)=>c(null,path.join(__dirname,'uploads')),filename:(r,f,c)=>c(null,`${Date.now()}_${f.originalname}`)}),limits:{fileSize:5*1024*1024}});
const transporter = nodemailer.createTransport({host:SMTP_HOST,port:Number(SMTP_PORT),secure:SMTP_SECURE==='true',auth:{user:SMTP_USER,pass:SMTP_PASS}});
app.post('/send-email', upload.single('attachment'), async(req,res)=>{ try{
  await transporter.sendMail({from:req.body.companyName,to:'contact@yogico.kr',replyTo:req.body.companyEmail,subject:`Contact: ${req.body.companyName}`,text:req.body.message,attachments:req.file?[{path:req.file.path}]:[]});
  res.json({success:true});}catch(e){res.status(500).json({success:false,error:e.message})} });

app.post('/api/:_any/uploads/image', upload.single('file'), async(req,res)=>{
  if(!req.file) return res.status(400).json({error:'No file'}); const c=new ftp.Client();
  try{await c.access({host:process.env.FTP_HOST,user:process.env.FTP_USER,password:process.env.FTP_PASS,secure:false});
    const dir=`yogibo/${dayjs().format('YYYY/MM/DD')}`; await c.cd('web/img/temple/uploads').catch(()=>{}); await c.ensureDir(dir); await c.uploadFrom(req.file.path,req.file.filename);
    res.json({url:`${FTP_PUBLIC_BASE}/uploads/${dir}/${req.file.filename}`.replace(/([^:]\/)\/+/g,'$1')});
  }catch(e){res.status(500).json({error:e.message})}finally{c.close();fs.unlink(req.file.path,()=>{})}
});

const runDb=async(cb)=>{const c=new MongoClient(MONGODB_URI);await c.connect();try{return await cb(c.db(DB_NAME))}finally{await c.close()}};
const EC='eventTemple';
const nb=blocks=>blocks.map(b=>(b?.type==='video'?{...b,autoplay:!!b.autoplay}:b));
app.post('/api/:_any/eventTemple',async(req,res)=>{try{const p={...req.body,createdAt:new Date()};if(p.content?.blocks)p.content.blocks=nb(p.content.blocks);const r=await runDb(db=>db.collection(EC).insertOne(p));res.json({_id:r.insertedId,...p})}catch(e){res.status(500).json({error:'Err'})}});
app.get('/api/:_any/eventTemple',async(req,res)=>{try{const l=await runDb(db=>db.collection(EC).find({mallId:CAFE24_MALLID}).sort({createdAt:-1}).toArray());res.json(l)}catch(e){res.status(500).json({error:'Err'})}});
app.get('/api/:_any/eventTemple/:id',async(req,res)=>{try{const d=await runDb(db=>db.collection(EC).findOne({_id:new ObjectId(req.params.id)}));res.json(d)}catch(e){res.status(500).json({error:'Err'})}});
app.put('/api/:_any/eventTemple/:id',async(req,res)=>{try{const s={...req.body,updatedAt:new Date()};if(s.content?.blocks)s.content.blocks=nb(s.content.blocks);delete s._id;await runDb(db=>db.collection(EC).updateOne({_id:new ObjectId(req.params.id)},{$set:s}));res.json({success:true})}catch(e){res.status(500).json({error:'Err'})}});
app.delete('/api/:_any/eventTemple/:id',async(req,res)=>{try{await runDb(db=>db.collection(EC).deleteOne({_id:new ObjectId(req.params.id)}));res.json({success:true})}catch(e){res.status(500).json({error:'Err'})}});

// ========== [서버 실행] ==========
(async function initialize() {
  try {
    console.log("🟡 서버 시작...");
    await getTokensFromDB();
    await updateSearchableData();
    app.listen(PORT, () => console.log(`🚀 실행 완료: ${PORT}`));
  } catch (err) { console.error("❌ 초기화 오류:", err.message); process.exit(1); }
})();