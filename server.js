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
require("dotenv").config();
const nodemailer = require('nodemailer');
const multer = require('multer');
const ftp = require('basic-ftp');
const dayjs = require('dayjs');

// ✅ 정적 FAQ 데이터 불러오기 (같은 폴더에 faq.js가 있어야 함)
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
  SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS,
  FTP_PUBLIC_BASE
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
// RAG 검색 대상 데이터
let allSearchableData = [...staticFaqList];

// ========== [상수: 상담사 연결 링크 포맷] ==========
// 사용자가 요청한 링크 포맷을 HTML로 변환하여 클릭 유도
const COUNSELOR_LINKS_HTML = `
<br><br>
📮 <a href="http://pf.kakao.com/_lxmZsxj/chat" target="_blank" style="color:#3b1e1e; font-weight:bold; text-decoration:underline;">카카오플친 연결하기 (클릭)</a><br>
📮 <a href="https://talk.naver.com/ct/wc4u67?frm=psf" target="_blank" style="color:#03c75a; font-weight:bold; text-decoration:underline;">네이버톡톡 연결하기 (클릭)</a>
`;

// AI가 답변을 못하거나 불확실할 때 붙이는 문구
const FALLBACK_MESSAGE_HTML = `
<br><br>
---------------------------------<br>
<strong>정확한 답변 확인을 위해 상담사 연결을 통해 진행하시겠습니까?</strong>
${COUNSELOR_LINKS_HTML}
`;

// ========== [시스템 프롬프트 설정] ==========
function convertPromptLinks(promptText) {
  return promptText
    .replace(/\[카카오플친 연결하기\]/g, '<a href="http://pf.kakao.com/_lxmZsxj/chat" target="_blank">카카오플친 연결하기</a>')
    .replace(/\[네이버톡톡 연결하기\]/g, '<a href="https://talk.naver.com/ct/wc4u67?frm=psf" target="_blank">네이버톡톡 연결하기</a>');
}

const basePrompt = `
1. 역할 및 말투
전문가 역할: 요기보(Yogibo) 브랜드의 전문 상담원입니다.
존대 및 공손: 고객에게 항상 존댓말과 공손한 말투를 사용합니다.
이모티콘 활용: 대화 중 적절히 이모티콘을 사용합니다.

2. 답변 원칙
제공된 [참고 정보]를 최우선으로 하여 답변합니다.
[참고 정보]에 없는 내용이라면 일반적인 상식 선에서 정중하게 대답하되, 확신이 없다면 솔직하게 모른다고 하고 상담원 연결을 권유하세요.
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
    const collection = db.collection(tokenCollectionName);
    const tokensDoc = await collection.findOne({});
    if (tokensDoc) {
      accessToken = tokensDoc.accessToken;
      refreshToken = tokensDoc.refreshToken;
      console.log('MongoDB에서 토큰 로드 성공');
    } else {
      console.log('초기 토큰 저장 진행');
      await saveTokensToDB(accessToken, refreshToken);
    }
  } catch (error) {
    console.error('토큰 로드 중 오류:', error);
  } finally {
    await client.close();
  }
}

async function saveTokensToDB(newAccessToken, newRefreshToken) {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(tokenCollectionName);
    await collection.updateOne({}, { $set: { accessToken: newAccessToken, refreshToken: newRefreshToken, updatedAt: new Date() } }, { upsert: true });
    console.log('MongoDB에 토큰 저장 완료');
  } catch (error) {
    console.error('토큰 저장 중 오류:', error);
  } finally {
    await client.close();
  }
}

async function refreshAccessToken() {
  console.log('Token Refreshing...');
  await getTokensFromDB();
  return accessToken;
}

// ========== [Cafe24 API 요청 함수] ==========
async function apiRequest(method, url, data = {}, params = {}) {
  try {
    const response = await axios({
      method, url, data, params,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Cafe24-Api-Version': CAFE24_API_VERSION
      },
    });
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 401) {
      console.log('Access Token 만료. 갱신 시도...');
      await refreshAccessToken();
      return apiRequest(method, url, data, params);
    } else {
      throw error;
    }
  }
}

// ========== [RAG 핵심 로직] ==========

async function updateSearchableData() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const postItNotes = await db.collection("postItNotes").find({}).toArray();

    const dynamicFaqs = postItNotes.map(note => ({
      c: note.category || "etc",
      q: note.question,
      a: note.answer
    }));

    allSearchableData = [...staticFaqList, ...dynamicFaqs];
    console.log(`✅ 검색 데이터 갱신 완료: 총 ${allSearchableData.length}개`);
  } catch (err) {
    console.error("검색 데이터 갱신 실패:", err);
  } finally {
    await client.close();
  }
}

function findRelevantContent(userMessage) {
  const keywords = userMessage.split(/\s+/).filter(w => w.length > 1);
  if (keywords.length === 0) return [];

  const scored = allSearchableData.map(item => {
    let score = 0;
    const qText = (item.q || "").toLowerCase();
    const aText = (item.a || "").toLowerCase();
    keywords.forEach(word => {
      const w = word.toLowerCase();
      if (qText.includes(w)) score += 5;
      if (aText.includes(w)) score += 2;
    });
    return { ...item, score };
  });

  return scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
}

// ========== [GPT 호출 함수] ==========
async function getGPT3TurboResponse(userInput, contextData = []) {
  const contextText = contextData.map(item => `Q: ${item.q}\nA: ${item.a}`).join("\n\n");
  
  const finalSystemPrompt = `
${YOGIBO_SYSTEM_PROMPT}

[참고 정보]
${contextText || "관련된 참고 정보가 없습니다. 고객의 질문에 대해 친절하게 답변해주세요."}
`;

  try {
    const response = await axios.post(
      OPEN_URL,
      {
        model: FINETUNED_MODEL,
        messages: [
          { role: "system", content: finalSystemPrompt },
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
    const gptAnswer = response.data.choices[0].message.content;
    return addSpaceAfterPeriod(gptAnswer);
  } catch (error) {
    console.error("GPT 호출 오류:", error.message);
    return "죄송합니다. 현재 답변을 생성하는데 문제가 발생했습니다.";
  }
}

// ========== [도우미 함수] ==========
function addSpaceAfterPeriod(text) {
  return text.replace(/\.([^\s])/g, '. $1');
}
function normalizeSentence(sentence) {
  return sentence.replace(/[?!！？]/g, "").replace(/없나요/g, "없어요").trim();
}
function containsOrderNumber(input) {
  return /\d{8}-\d{7}/.test(input);
}

// ========== [Cafe24 주문/배송] ==========
async function getOrderShippingInfo(memberId) {
  const API_URL = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`;
  const today = new Date();
  const end_date = today.toISOString().split('T')[0];
  const twoWeeksAgo = new Date(today);
  twoWeeksAgo.setDate(today.getDate() - 14);
  const start_date = twoWeeksAgo.toISOString().split('T')[0];
  
  try {
    return await apiRequest("GET", API_URL, {}, { member_id: memberId, start_date, end_date, limit: 10 });
  } catch (error) {
    console.error("Error fetching order info:", error.message);
    throw error;
  }
}

async function getShipmentDetail(orderId) {
  const API_URL = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders/${orderId}/shipments`;
  try {
    const response = await apiRequest("GET", API_URL, {}, { shop_no: 1 });
    if (response.shipments && response.shipments.length > 0) {
      const shipment = response.shipments[0];
      const shippingCompanies = {
        "0019": { name: "롯데 택배", url: "https://www.lotteglogis.com/home/reservation/tracking/index" },
        "0039": { name: "경동 택배", url: "https://kdexp.com/index.do" }
      };
      if (shippingCompanies[shipment.shipping_company_code]) {
        shipment.shipping_company_name = shippingCompanies[shipment.shipping_company_code].name;
        shipment.shipping_company_url = shippingCompanies[shipment.shipping_company_code].url;
      } else {
        shipment.shipping_company_name = shipment.shipping_company_code || "물류 창고";
      }
      return shipment;
    }
    return null;
  } catch (error) {
    console.error("Error fetching shipment:", error.message);
    throw error;
  }
}

// ========== [메인 로직: findAnswer (규칙 기반)] ==========
async function findAnswer(userInput, memberId) {
  const normalized = normalizeSentence(userInput);

  // ✅ [1] 상담사 연결 (사용자 요청 포맷 적용)
  if (normalized.includes("상담사 연결") || normalized.includes("상담원 연결")) {
    return {
      text: `상담사 연결을 도와드리겠습니다.${COUNSELOR_LINKS_HTML}`,
      videoHtml: null
    };
  }

  // 2. 오프라인 매장
  if (normalized.includes("오프라인 매장") || normalized.includes("매장안내")) {
    return {
      text: `가까운 매장을 안내해 드립니다.<br><a href="/why.stroe.html" target="_blank">매장안내 바로가기</a>`,
      videoHtml: null
    };
  }

  // 3. 내 아이디
  if (normalized.includes("내 아이디") || normalized.includes("아이디 조회")) {
    return memberId && memberId !== "null"
      ? { text: `안녕하세요 ${memberId} 고객님, 무엇을 도와드릴까요?` }
      : { text: `로그인이 필요합니다. <a href="/member/login.html" target="_blank">로그인 하러가기</a>` };
  }

  // 4. 주문번호 조회
  if (containsOrderNumber(normalized)) {
    if (memberId && memberId !== "null") {
      try {
        const match = normalized.match(/\d{8}-\d{7}/);
        const orderId = match ? match[0] : "";
        const shipment = await getShipmentDetail(orderId);
        if (shipment) {
          const comp = shipment.shipping_company_name;
          const status = shipment.status || "배송중";
          return { text: `주문번호 ${orderId}는 ${comp}를 통해 ${status}입니다. 송장: ${shipment.tracking_no}` };
        }
        return { text: "해당 주문의 배송 정보를 찾을 수 없습니다." };
      } catch (e) { return { text: "배송 조회 중 오류가 발생했습니다." }; }
    } else {
      return { text: "로그인 후 정확한 조회가 가능합니다." };
    }
  }

  // 5. 일반 배송 상태
  if ((normalized.includes("배송") || normalized.includes("주문상태")) && !containsOrderNumber(normalized)) {
    if (memberId && memberId !== "null") {
      try {
        const orderData = await getOrderShippingInfo(memberId);
        if (orderData.orders && orderData.orders.length > 0) {
          const target = orderData.orders[0];
          const shipment = await getShipmentDetail(target.order_id);
          if (shipment) {
            return { text: `최근 주문(${target.order_id})은 ${shipment.shipping_company_name} 배송 중입니다. 송장: ${shipment.tracking_no}` };
          }
          return { text: "최근 주문의 상세 정보를 확인 중입니다." };
        }
        return { text: "최근 2주 내 주문 내역이 없습니다." };
      } catch (e) { return { text: "주문 정보 조회 실패." }; }
    } else {
      return { text: "배송 조회는 로그인이 필요합니다. (소파 제작기간: 3~7일 소요)" };
    }
  }

  // 6. 커버링
  if (normalized.includes("커버링") && normalized.includes("방법")) {
    const types = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭"];
    const found = types.find(t => normalized.includes(t));
    if (found && companyData.covering) {
      const key = `${found} 커버링 방법을 알고 싶어`;
      if (companyData.covering[key]) {
        return {
          text: companyData.covering[key].answer,
          videoHtml: `<iframe width="100%" height="auto" src="${companyData.covering[key].videoUrl}" frameborder="0" allowfullscreen></iframe>`
        };
      }
    }
  }

  return null; // 규칙 없음 -> GPT로
}

// ========== [Chat 요청 처리 (메인)] ==========
app.post("/chat", async (req, res) => {
  const userInput = req.body.message;
  const memberId = req.body.memberId;

  if (!userInput) return res.status(400).json({ error: "Message required." });

  try {
    // 1. 규칙 기반 답변
    const ruleAnswer = await findAnswer(userInput, memberId);
    if (ruleAnswer) {
      if (userInput !== "내 아이디") await saveConversationLog(memberId, userInput, ruleAnswer.text);
      return res.json(ruleAnswer);
    }

    // 2. 규칙에 없음 -> RAG 검색
    const relevantDocs = findRelevantContent(userInput);
    
    // 3. GPT 호출
    let gptText = await getGPT3TurboResponse(userInput, relevantDocs);

    // ✅ [핵심 기능 추가] 
    // 검색된 정보가 없거나(교육 안 된 내용), RAG를 통해 생성된 AI 답변일 경우
    // 사용자 요청대로 상담사 연결 유도 링크를 하단에 붙여줌
    if (relevantDocs.length === 0 || relevantDocs.length > 0) {
        gptText += FALLBACK_MESSAGE_HTML;
    }

    const finalResponse = {
      text: gptText,
      videoHtml: null,
      imageUrl: null
    };

    await saveConversationLog(memberId, userInput, finalResponse.text);
    return res.json(finalResponse);

  } catch (error) {
    console.error("/chat 오류:", error);
    return res.status(500).json({ text: "오류가 발생했습니다. 잠시 후 다시 시도해주세요." });
  }
});

// ========== [로그 저장] ==========
async function saveConversationLog(memberId, userMessage, botResponse) {
  const client = new MongoClient(MONGODB_URI);
  const today = new Date().toISOString().split("T")[0];
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const logs = db.collection("conversationLogs");
    const logEntry = { userMessage, botResponse, createdAt: new Date() };
    await logs.updateOne(
      { memberId: memberId || null, date: today },
      { $push: { conversation: logEntry } },
      { upsert: true }
    );
  } catch(e) { console.error("로그 저장 실패", e); } finally { await client.close(); }
}

// ========== [포스트잇 API] ==========
app.get("/postIt", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const PAGE_SIZE = 300;
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    const filter = req.query.category ? { category: req.query.category } : {};
    const totalCount = await db.collection("postItNotes").countDocuments(filter);
    const notes = await db.collection("postItNotes").find(filter).sort({_id:-1}).skip((page-1)*PAGE_SIZE).limit(PAGE_SIZE).toArray();
    await client.close();
    res.json({ notes, totalCount, currentPage: page });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/postIt", async (req, res) => {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    await client.db(DB_NAME).collection("postItNotes").insertOne({ ...req.body, createdAt: new Date() });
    await client.close();
    await updateSearchableData();
    res.json({ message: "등록 완료" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/postIt/:id", async (req, res) => {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    await client.db(DB_NAME).collection("postItNotes").updateOne({ _id: new ObjectId(req.params.id) }, { $set: { ...req.body, updatedAt: new Date() } });
    await client.close();
    await updateSearchableData();
    res.json({ message: "수정 완료" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/postIt/:id", async (req, res) => {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    await client.db(DB_NAME).collection("postItNotes").deleteOne({ _id: new ObjectId(req.params.id) });
    await client.close();
    await updateSearchableData();
    res.json({ message: "삭제 완료" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ========== [기타 기능: Email, FTP, EventTemple 등] ==========
const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) { cb(null, path.join(__dirname, 'uploads')); },
    filename(req, file, cb) { cb(null, `${Date.now()}_${file.originalname}`); },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT), secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

app.post('/send-email', upload.single('attachment'), async (req, res) => {
  try {
    const { companyEmail, companyName, message } = req.body;
    await transporter.sendMail({
      from: { name: companyName, address: process.env.SMTP_USER },
      to: 'contact@yogico.kr', replyTo: companyEmail, subject: `Contact 요청: ${companyName}`,
      text: message, attachments: req.file ? [{ filename: req.file.originalname, path: req.file.path }] : []
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/:_any/uploads/image', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일 없음' });
  const client = new ftp.Client(15000);
  try {
    await client.access({ host: process.env.FTP_HOST, user: process.env.FTP_USER, password: process.env.FTP_PASS, secure: false });
    const relSuffix = `yogibo/${dayjs().format('YYYY/MM/DD')}`;
    await client.cd('web/img/temple/uploads').catch(()=>{});
    await client.ensureDir(relSuffix);
    await client.uploadFrom(req.file.path, req.file.filename);
    const url = `${FTP_PUBLIC_BASE}/uploads/${relSuffix}/${req.file.filename}`.replace(/([^:]\/)\/+/g, '$1');
    res.json({ url });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { client.close(); fs.unlink(req.file.path, ()=>{}); }
});

// EventTemple Routes (간소화)
const runDb = async (task) => { const c=new MongoClient(MONGODB_URI); await c.connect(); try{return await task(c.db(DB_NAME))}finally{await c.close()}};
const EVENT_COLL='eventTemple';
app.post('/api/:_any/eventTemple', async(req,res)=>{try{const r=await runDb(db=>db.collection(EVENT_COLL).insertOne({...req.body, createdAt:new Date()}));res.json(r)}catch(e){res.status(500).json({error:'Err'})}});
app.get('/api/:_any/eventTemple', async(req,res)=>{try{const l=await runDb(db=>db.collection(EVENT_COLL).find({mallId:CAFE24_MALLID}).sort({createdAt:-1}).toArray());res.json(l)}catch(e){res.status(500).json({error:'Err'})}});
app.get('/api/:_any/eventTemple/:id', async(req,res)=>{try{const d=await runDb(db=>db.collection(EVENT_COLL).findOne({_id:new ObjectId(req.params.id)}));res.json(d)}catch(e){res.status(500).json({error:'Err'})}});
app.put('/api/:_any/eventTemple/:id', async(req,res)=>{try{await runDb(db=>db.collection(EVENT_COLL).updateOne({_id:new ObjectId(req.params.id)},{$set:{...req.body,updatedAt:new Date()}}));res.json({success:true})}catch(e){res.status(500).json({error:'Err'})}});
app.delete('/api/:_any/eventTemple/:id', async(req,res)=>{try{await runDb(db=>db.collection(EVENT_COLL).deleteOne({_id:new ObjectId(req.params.id)}));res.json({success:true})}catch(e){res.status(500).json({error:'Err'})}});

// 엑셀 다운로드
app.get('/chatConnet', async (req, res) => {
  try {
    const list = await runDb(db=>db.collection("conversationLogs").find({}).toArray());
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Logs');
    sheet.columns = [{header:'ID',key:'memberId'},{header:'Date',key:'date'},{header:'Log',key:'conversation'}];
    list.forEach(d => sheet.addRow({memberId: d.memberId||'비회원', date: d.date, conversation: JSON.stringify(d.conversation)}));
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=logs.xlsx");
    await workbook.xlsx.write(res); res.end();
  } catch (e) { res.status(500).send("Error"); }
});

// ========== [서버 실행] ==========
(async function initialize() {
  try {
    console.log("🟡 서버 시작 중...");
    await getTokensFromDB();
    await updateSearchableData();
    app.listen(PORT, () => console.log(`🚀 서버 실행 완료! 포트: ${PORT}`));
  } catch (err) { console.error("❌ 초기화 오류:", err.message); process.exit(1); }
})();