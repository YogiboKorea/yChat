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
  ACCESS_TOKEN,
  REFRESH_TOKEN,
  CAFE24_CLIENT_ID,
  CAFE24_CLIENT_SECRET,
  DB_NAME,
  MONGODB_URI,
  CAFE24_MALLID,
  OPEN_URL,
  API_KEY,
  FINETUNED_MODEL = "gpt-3.5-turbo",
  CAFE24_API_VERSION = "2024-06-01",
  PORT = 5000,
  FTP_PUBLIC_BASE,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS
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

// ========== [상수: 상담사 연결 링크 (팝업 방식)] ==========
const COUNSELOR_LINKS_HTML = `
<br><br>
📮 <a href="javascript:void(0)" onclick="window.open('http://pf.kakao.com/_lxmZsxj/chat','kakao','width=500,height=600,scrollbars=yes');" style="color:#3b1e1e; font-weight:bold; text-decoration:underline;">카카오플친 연결하기 (팝업)</a><br>
📮 <a href="javascript:void(0)" onclick="window.open('https://talk.naver.com/ct/wc4u67?frm=psf','naver','width=500,height=600,scrollbars=yes');" style="color:#03c75a; font-weight:bold; text-decoration:underline;">네이버톡톡 연결하기 (팝업)</a>
`;

const FALLBACK_MESSAGE_HTML = `
<br><br>
---------------------------------<br>
<strong>정확한 답변 확인을 위해 상담사 연결을 통해 진행하시겠습니까?</strong>
${COUNSELOR_LINKS_HTML}
`;

// ========== [시스템 프롬프트 설정] ==========
function convertPromptLinks(promptText) {
  return promptText; // 프롬프트 내 링크는 텍스트로 유지
}

const basePrompt = `
1. 역할 및 말투
전문가 역할: 요기보(Yogibo) 브랜드의 전문 상담원입니다.
존대 및 공손: 고객에게 항상 존댓말과 공손한 말투를 사용합니다.
이모티콘 활용: 대화 중 적절히 이모티콘을 사용합니다.

2. 답변 원칙
제공된 [참고 정보]를 최우선으로 하여 답변합니다.
모르는 내용일 경우 솔직하게 모른다고 하고 상담원 연결을 권유하세요.
`;
const YOGIBO_SYSTEM_PROMPT = convertPromptLinks(basePrompt);

// ========== [데이터 로딩] ==========
const companyDataPath = path.join(__dirname, "json", "companyData.json");
let companyData = {};
try {
  if (fs.existsSync(companyDataPath)) {
    companyData = JSON.parse(fs.readFileSync(companyDataPath, "utf-8"));
  }
} catch (e) {
  console.error("companyData.json 로드 실패:", e);
}

// ========== [MongoDB 토큰 관리 함수] ==========
const tokenCollectionName = "tokens";

async function getTokensFromDB() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const doc = await db.collection(tokenCollectionName).findOne({});
    if (doc) {
      accessToken = doc.accessToken;
      refreshToken = doc.refreshToken;
    } else {
      await saveTokensToDB(accessToken, refreshToken);
    }
  } finally {
    await client.close();
  }
}

async function saveTokensToDB(newAT, newRT) {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    await client.db(DB_NAME).collection(tokenCollectionName).updateOne(
      {},
      {
        $set: {
          accessToken: newAT,
          refreshToken: newRT,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
  } finally {
    await client.close();
  }
}

async function refreshAccessToken() {
  await getTokensFromDB();
  return accessToken;
}

// ========== [Cafe24 API 요청] ==========
async function apiRequest(method, url, data = {}, params = {}) {
  try {
    const res = await axios({
      method,
      url,
      data,
      params,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Cafe24-Api-Version': CAFE24_API_VERSION
      }
    });
    return res.data;
  } catch (error) {
    if (error.response?.status === 401) {
      await refreshAccessToken();
      return apiRequest(method, url, data, params);
    }
    throw error;
  }
}

// ========== [RAG 로직] ==========
async function updateSearchableData() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const notes = await client.db(DB_NAME).collection("postItNotes").find({}).toArray();
    const dynamic = notes.map(n => ({
      c: n.category || "etc",
      q: n.question,
      a: n.answer
    }));
    allSearchableData = [...staticFaqList, ...dynamic];
    console.log(`✅ 검색 데이터 갱신 완료: 총 ${allSearchableData.length}개 로드됨`);
  } catch (err) {
    console.error("데이터 갱신 실패:", err);
  } finally {
    await client.close();
  }
}

function findRelevantContent(userMessage) {
  const keywords = userMessage.split(/\s+/).filter(w => w.length > 1);
  if (!keywords.length) return [];

  const scored = allSearchableData.map(item => {
    let score = 0;
    const q = (item.q || "").toLowerCase();
    const a = (item.a || "").toLowerCase();
    
    keywords.forEach(w => {
      if (q.includes(w)) score += 5;
      if (a.includes(w)) score += 2;
    });
    return { ...item, score };
  });

  return scored
    .filter(i => i.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
}

async function getGPT3TurboResponse(userInput, contextData = []) {
  const contextText = contextData.map(i => `Q: ${i.q}\nA: ${i.a}`).join("\n\n");
  const systemPrompt = `${YOGIBO_SYSTEM_PROMPT}\n[참고 정보]\n${contextText || "정보 없음."}`;
  
  try {
    const res = await axios.post(
      OPEN_URL,
      {
        model: FINETUNED_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userInput }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return res.data.choices[0].message.content;
  } catch (e) {
    return "죄송합니다. 답변 생성 중 문제가 발생했습니다.";
  }
}

// ========== [도우미 함수] ==========
function normalizeSentence(s) {
  return s.replace(/[?!！？]/g, "").replace(/없나요/g, "없어요").trim();
}

function containsOrderNumber(s) {
  return /\d{8}-\d{7}/.test(s);
}

function addSpaceAfterPeriod(text) {
  return text.replace(/\.([^\s])/g, '. $1');
}

// ========== [배송 관련 함수] ==========
async function getOrderShippingInfo(memberId) {
  const today = new Date();
  const start = new Date();
  start.setDate(today.getDate() - 14);
  
  return apiRequest("GET", `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`, {}, {
    member_id: memberId,
    start_date: start.toISOString().split('T')[0],
    end_date: today.toISOString().split('T')[0],
    limit: 10
  });
}

async function getShipmentDetail(orderId) {
  const res = await apiRequest("GET", `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders/${orderId}/shipments`, {}, { shop_no: 1 });
  if (res.shipments?.[0]) {
    const s = res.shipments[0];
    const map = { "0019": "롯데 택배", "0039": "경동 택배" };
    s.shipping_company_name = map[s.shipping_company_code] || s.shipping_company_code || "물류 창고";
    return s;
  }
  return null;
}

// ========== [★ 핵심 로직: findAnswer (규칙 + JSON 데이터)] ==========
async function findAnswer(userInput, memberId) {
  const normalized = normalizeSentence(userInput);

  // 1. 상담사 연결 (팝업)
  if (normalized.includes("상담사 연결") || normalized.includes("상담원 연결")) {
    return {
      text: `상담사와 연결을 도와드리겠습니다.${COUNSELOR_LINKS_HTML}`,
      videoHtml: null
    };
  }

  // 2. 오프라인 매장
  if (normalized.includes("오프라인 매장") || normalized.includes("매장안내")) {
    return {
      text: `가까운 매장을 안내해 드립니다.<br><a href="/why.stroe.html" target="_blank">매장안내 바로가기</a>`
    };
  }

  // 3. 내 아이디
  if (normalized.includes("내 아이디") || normalized.includes("아이디 조회")) {
    return memberId && memberId !== "null"
      ? { text: `안녕하세요 ${memberId} 고객님, 무엇을 도와드릴까요?` }
      : { text: `로그인이 필요합니다. <a href="/member/login.html" target="_blank">로그인 하러가기</a>` };
  }

  // 4. 주문번호/배송 조회 (API)
  if (containsOrderNumber(normalized)) {
    if (memberId && memberId !== "null") {
      try {
        const orderId = normalized.match(/\d{8}-\d{7}/)[0];
        const ship = await getShipmentDetail(orderId);
        return ship 
          ? { text: `주문번호 ${orderId}는 ${ship.shipping_company_name}로 배송 중입니다. 송장: ${ship.tracking_no}` }
          : { text: "배송 정보를 찾을 수 없습니다." };
      } catch (e) {
        return { text: "조회 중 오류가 발생했습니다." };
      }
    }
    return { text: "로그인 후 조회 가능합니다." };
  }

  if ((normalized.includes("배송") || normalized.includes("주문상태")) && !containsOrderNumber(normalized)) {
    if (memberId && memberId !== "null") {
      try {
        const data = await getOrderShippingInfo(memberId);
        if (data.orders?.[0]) {
          const t = data.orders[0];
          const s = await getShipmentDetail(t.order_id);
          return s 
            ? { text: `최근 주문(${t.order_id})은 ${s.shipping_company_name} 배송 중입니다.` }
            : { text: "최근 주문 확인 중입니다." };
        }
        return { text: "최근 2주 내 주문 내역이 없습니다." };
      } catch (e) {
        return { text: "조회 실패." };
      }
    }
    return { text: "로그인이 필요합니다." };
  }

  // =========================================================
  // ★ [복구된 JSON 기반 로직]
  // =========================================================

  // (1) 커버링 방법 (Context 처리)
  if (pendingCoveringContext) {
    const types = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
    if (types.includes(normalized)) {
      const key = `${normalized} 커버링 방법을 알고 싶어`;
      pendingCoveringContext = false;
      if (companyData.covering && companyData.covering[key]) {
        return {
          text: companyData.covering[key].answer,
          videoHtml: `<iframe width="100%" height="auto" src="${companyData.covering[key].videoUrl}" frameborder="0" allowfullscreen></iframe>`
        };
      }
    }
  }

  // (2) 커버링 방법 (Direct)
  if (normalized.includes("커버링") && normalized.includes("방법")) {
    const types = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
    const found = types.find(t => normalized.includes(t));
    if (found) {
      const key = `${found} 커버링 방법을 알고 싶어`;
      if (companyData.covering && companyData.covering[key]) {
        return {
          text: companyData.covering[key].answer,
          videoHtml: `<iframe width="100%" height="auto" src="${companyData.covering[key].videoUrl}" frameborder="0" allowfullscreen></iframe>`
        };
      }
    } else {
      pendingCoveringContext = true;
      return { text: "어떤 커버링을 알고 싶으신가요? (맥스, 더블, 슬림, 미니 등)" };
    }
  }

  // (3) 사이즈 안내
  if (normalized.includes("사이즈") || normalized.includes("크기")) {
    const types = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
    for (let t of types) {
      if (normalized.includes(t)) {
        const key = `${t} 사이즈 또는 크기.`;
        if (companyData.sizeInfo && companyData.sizeInfo[key]) {
          return {
            text: companyData.sizeInfo[key].description,
            imageUrl: companyData.sizeInfo[key].imageUrl
          };
        }
      }
    }
  }

  // (4) 비즈 안내
  const bizKeys = ["스탠다드", "프리미엄", "프리미엄 플러스"];
  if (normalized.includes("비즈") || bizKeys.some(k => normalized.includes(k))) {
    const matched = bizKeys.find(k => normalized.includes(k));
    if (matched) {
      const key = `${matched} 비즈 에 대해 알고 싶어`;
      if (companyData.biz && companyData.biz[key]) {
        return { text: companyData.biz[key].description };
      }
    } else {
      return { text: "어떤 비즈가 궁금하신가요? (스탠다드, 프리미엄 등)" };
    }
  }

  // (5) goodsInfo (유사도)
  if (companyData.goodsInfo) {
    let best = null;
    let minDist = 6;
    for (let q in companyData.goodsInfo) {
      const dist = levenshtein.get(normalized, normalizeSentence(q));
      if (dist < minDist) {
        minDist = dist;
        best = companyData.goodsInfo[q];
      }
    }
    if (best) {
      return {
        text: Array.isArray(best.description) ? best.description.join("\n") : best.description,
        imageUrl: best.imageUrl
      };
    }
  }

  // (6) homePage (유사도)
  if (companyData.homePage) {
    let best = null;
    let minDist = 5;
    for (let q in companyData.homePage) {
      const dist = levenshtein.get(normalized, normalizeSentence(q));
      if (dist < minDist) {
        minDist = dist;
        best = companyData.homePage[q];
      }
    }
    if (best) {
      return { text: best.description };
    }
  }

  // (7) asInfo (유사도)
  if (companyData.asInfo) {
    let best = null;
    let minDist = 8;
    for (let q in companyData.asInfo) {
      const dist = levenshtein.get(normalized, normalizeSentence(q));
      if (dist < minDist) {
        minDist = dist;
        best = companyData.asInfo[q];
      }
    }
    if (best) {
      return { text: best.description };
    }
  }

  return null; // 규칙 없음 -> GPT로
}

// ========== [Chat 요청 처리] ==========
app.post("/chat", async (req, res) => {
  const { message, memberId } = req.body;
  if (!message) return res.status(400).json({ error: "No message" });

  try {
    // 1. 규칙(JSON/API) 답변 시도
    const ruleAnswer = await findAnswer(message, memberId);
    if (ruleAnswer) {
      if (message !== "내 아이디") await saveConversationLog(memberId, message, ruleAnswer.text);
      return res.json(ruleAnswer);
    }

    // 2. 규칙 없으면 RAG + GPT
    const docs = findRelevantContent(message);
    let gptAnswer = await getGPT3TurboResponse(message, docs);

    // ✅ [추가] RAG/GPT 답변 하단에 상담사 연결 팝업 유도 링크 부착
    gptAnswer = addSpaceAfterPeriod(gptAnswer); // 마침표 뒤 띄어쓰기 적용
    
    // 답변이 있거나 없거나, AI 응답에는 항상 상담 연결 유도
    gptAnswer += FALLBACK_MESSAGE_HTML;

    await saveConversationLog(memberId, message, gptAnswer);
    res.json({ text: gptAnswer, videoHtml: null });

  } catch (e) {
    console.error(e);
    res.status(500).json({ text: "오류가 발생했습니다." });
  }
});

async function saveConversationLog(memberId, userMessage, botResponse) {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    await client.db(DB_NAME).collection("conversationLogs").updateOne(
      { memberId: memberId || null, date: new Date().toISOString().split("T")[0] },
      { $push: { conversation: { userMessage, botResponse, createdAt: new Date() } } },
      { upsert: true }
    );
  } finally {
    await client.close();
  }
}

// ========== [포스트잇 API] ==========
app.get("/postIt", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 300;
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    const filter = req.query.category ? { category: req.query.category } : {};
    const totalCount = await db.collection("postItNotes").countDocuments(filter);
    const notes = await db.collection("postItNotes").find(filter).sort({ _id: -1 }).skip((page - 1) * limit).limit(limit).toArray();
    await client.close();
    res.json({ notes, totalCount, currentPage: page });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/postIt", async (req, res) => {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    await client.db(DB_NAME).collection("postItNotes").insertOne({ ...req.body, createdAt: new Date() });
    await client.close();
    await updateSearchableData();
    res.json({ message: "등록 완료" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/postIt/:id", async (req, res) => {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    await client.db(DB_NAME).collection("postItNotes").updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { ...req.body, updatedAt: new Date() } }
    );
    await client.close();
    await updateSearchableData();
    res.json({ message: "수정 완료" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/postIt/:id", async (req, res) => {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    await client.db(DB_NAME).collection("postItNotes").deleteOne({ _id: new ObjectId(req.params.id) });
    await client.close();
    await updateSearchableData();
    res.json({ message: "삭제 완료" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== [엑셀 다운로드] ==========
app.get('/chatConnet', async (req, res) => {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const d = await client.db(DB_NAME).collection("conversationLogs").find({}).toArray();
    await client.close();

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Log');
    ws.columns = [
      { header: 'ID', key: 'm' },
      { header: 'Date', key: 'd' },
      { header: 'Log', key: 'c' }
    ];
    d.forEach(r => ws.addRow({
      m: r.memberId || 'Guest',
      d: r.date,
      c: JSON.stringify(r.conversation)
    }));

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=log.xlsx");
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    res.status(500).send("Err");
  }
});

// ========== [이메일 전송 (Nodemailer)] ==========
const upload = multer({
  storage: multer.diskStorage({
    destination: (r, f, c) => c(null, path.join(__dirname, 'uploads')),
    filename: (r, f, c) => c(null, `${Date.now()}_${f.originalname}`)
  }),
  limits: { fileSize: 5 * 1024 * 1024 }
});

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT),
  secure: SMTP_SECURE === 'true',
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});

app.post('/send-email', upload.single('attachment'), async (req, res) => {
  try {
    const { companyEmail, companyName, message } = req.body;
    await transporter.sendMail({
      from: { name: companyName, address: process.env.SMTP_USER },
      to: 'contact@yogico.kr',
      replyTo: companyEmail,
      subject: `Contact: ${companyName}`,
      text: message,
      attachments: req.file ? [{ path: req.file.path }] : []
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== [FTP 이미지 업로드] ==========
app.post('/api/:_any/uploads/image', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const client = new ftp.Client(15000);
  try {
    await client.access({
      host: process.env.FTP_HOST,
      user: process.env.FTP_USER,
      password: process.env.FTP_PASS,
      secure: false
    });
    const dir = `yogibo/${dayjs().format('YYYY/MM/DD')}`;
    await client.cd('web/img/temple/uploads').catch(() => {});
    await client.ensureDir(dir);
    await client.uploadFrom(req.file.path, req.file.filename);
    
    res.json({ url: `${FTP_PUBLIC_BASE}/uploads/${dir}/${req.file.filename}`.replace(/([^:]\/)\/+/g, '$1') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    client.close();
    fs.unlink(req.file.path, () => {});
  }
});

// ========== [EventTemple Routes] ==========
const runDb = async (task) => {
  const c = new MongoClient(MONGODB_URI);
  await c.connect();
  try { return await task(c.db(DB_NAME)); } finally { await c.close(); }
};
const EVENT_COLL = 'eventTemple';

// 정규화 함수
function normalizeBlocks(blocks = []) {
  return blocks.map(b => (b?.type === 'video' ? { ...b, autoplay: !!b.autoplay } : b));
}

app.post('/api/:_any/eventTemple', async (req, res) => {
  try {
    const doc = { ...req.body, createdAt: new Date() };
    if (doc.content?.blocks) doc.content.blocks = normalizeBlocks(doc.content.blocks);
    const r = await runDb(db => db.collection(EVENT_COLL).insertOne(doc));
    res.json({ _id: r.insertedId, ...doc });
  } catch (e) { res.status(500).json({ error: 'Err' }); }
});

app.get('/api/:_any/eventTemple', async (req, res) => {
  try {
    const l = await runDb(db => db.collection(EVENT_COLL).find({ mallId: CAFE24_MALLID }).sort({ createdAt: -1 }).toArray());
    res.json(l);
  } catch (e) { res.status(500).json({ error: 'Err' }); }
});

app.get('/api/:_any/eventTemple/:id', async (req, res) => {
  try {
    const d = await runDb(db => db.collection(EVENT_COLL).findOne({ _id: new ObjectId(req.params.id) }));
    res.json(d);
  } catch (e) { res.status(500).json({ error: 'Err' }); }
});

app.put('/api/:_any/eventTemple/:id', async (req, res) => {
  try {
    const set = { ...req.body, updatedAt: new Date() };
    if (set.content?.blocks) set.content.blocks = normalizeBlocks(set.content.blocks);
    delete set._id;
    await runDb(db => db.collection(EVENT_COLL).updateOne({ _id: new ObjectId(req.params.id) }, { $set: set }));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Err' }); }
});

app.delete('/api/:_any/eventTemple/:id', async (req, res) => {
  try {
    await runDb(db => db.collection(EVENT_COLL).deleteOne({ _id: new ObjectId(req.params.id) }));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Err' }); }
});

// ========== [서버 실행] ==========
(async function initialize() {
  try {
    console.log("🟡 서버 시작...");
    await getTokensFromDB();
    await updateSearchableData();
    app.listen(PORT, () => console.log(`🚀 실행 완료: ${PORT}`));
  } catch (err) {
    console.error("❌ 초기화 오류:", err.message);
    process.exit(1);
  }
})();