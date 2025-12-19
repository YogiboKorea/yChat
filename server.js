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
  PORT = 5000
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
📮 <a href="javascript:void(0)" onclick="window.open('http://pf.kakao.com/_lxmZsxj/chat','kakao','width=500,height=600,scrollbars=yes');" style="color:#3b1e1e; font-weight:bold; text-decoration:underline; cursor:pointer;">카카오플친 연결하기 (팝업)</a><br>
📮 <a href="javascript:void(0)" onclick="window.open('https://talk.naver.com/ct/wc4u67?frm=psf','naver','width=500,height=600,scrollbars=yes');" style="color:#03c75a; font-weight:bold; text-decoration:underline; cursor:pointer;">네이버톡톡 연결하기 (팝업)</a>
`;

// 2. 답변 하단 기본 문구 (모르는 질문일 때만 사용)
const FALLBACK_MESSAGE_HTML = `
<br><br>
---------------------------------<br>
<strong>원하시는 답변을 찾지 못하셨나요? 상담사 연결을 도와드릴까요?</strong>
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

// ✅ [환각 방지 + 전화번호 지어내기 금지]
const basePrompt = `
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
const YOGIBO_SYSTEM_PROMPT = convertPromptLinks(basePrompt);

// ========== [데이터 로딩] ==========
const companyDataPath = path.join(__dirname, "json", "companyData.json");
let companyData = {};
try {
  if (fs.existsSync(companyDataPath)) {
    companyData = JSON.parse(fs.readFileSync(companyDataPath, "utf-8"));
  }
} catch (e) { console.error("companyData load fail", e); }

// ========== [MongoDB 토큰 관리 함수] ==========
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
    console.log(`✅ 검색 데이터 갱신 완료: 총 ${allSearchableData.length}개 로드됨 (정적 ${staticFaqList.length} + 포스트잇 ${dynamic.length})`);
  } catch (err) { console.error("데이터 갱신 실패:", err); } finally { await client.close(); }
}

// ✅ [수정] 검색 로직 완화 및 로그 추가
function findRelevantContent(msg) {
  const kws = msg.split(/\s+/).filter(w => w.length > 1);
  if (!kws.length) return [];

  console.log(`🔍 검색 시작: "${msg}" (키워드: ${kws})`);

  const scored = allSearchableData.map(item => {
    let score = 0;
    const q = (item.q || "").toLowerCase().replace(/\s+/g, "");
    const a = (item.a || "").toLowerCase();
    const cleanMsg = msg.toLowerCase().replace(/\s+/g, "");

    // 질문 전체 포함 시 가산점
    if (q.includes(cleanMsg) || cleanMsg.includes(q)) score += 20;

    kws.forEach(w => {
      const cleanW = w.toLowerCase();
      if (item.q.toLowerCase().includes(cleanW)) score += 10;
      if (item.a.toLowerCase().includes(cleanW)) score += 1;
    });

    return { ...item, score };
  });

  // ✅ 기준 점수 완화 (10 -> 5) : 키워드가 하나라도(특히 질문에) 포함되면 가져오도록 함
  const results = scored.filter(i => i.score >= 5).sort((a, b) => b.score - a.score).slice(0, 3);
  
  console.log(`📊 검색 결과: ${results.length}개 발견`);
  if(results.length > 0) console.log(`   👉 1위: Q: ${results[0].q} / Score: ${results[0].score}`);

  return results;
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

// ========== [유틸 함수: 텍스트 포맷팅] ==========
function formatResponseText(text) {
  if (!text) return "";
  let formatted = text.replace(/([가-힣]+)[.]\s/g, '$1.\n\n'); 
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  formatted = formatted.replace(urlRegex, function(url) {
    let cleanUrl = url.replace(/[.,]$/, ''); 
    return `<a href="${cleanUrl}" target="_blank" style="color:#58b5ca; font-weight:bold; text-decoration:underline;">${cleanUrl}</a>`;
  });
  return formatted;
}

function normalizeSentence(s) { return s.replace(/[?!！？]/g, "").replace(/없나요/g, "없어요").trim(); }
function containsOrderNumber(s) { return /\d{8}-\d{7}/.test(s); }

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

// ✅ [배송 상세 조회 + 송장 링크]
async function getShipmentDetail(orderId) {
  const API_URL = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders/${orderId}/shipments`;
  try {
    const response = await apiRequest("GET", API_URL, {}, { shop_no: 1 });
    console.log(`[배송조회] ${orderId}:`, JSON.stringify(response));

    if (response.shipments && response.shipments.length > 0) {
      const shipment = response.shipments[0];
      const carrierMap = {
        "0019": { name: "롯데 택배", url: "https://www.lotteglogis.com/home/reservation/tracking/linkView?InvNo=" },
        "0039": { name: "경동 택배", url: "https://kdexp.com/service/delivery/tracking.do?barcode=" },
        "0023": { name: "경동 택배", url: "https://kdexp.com/service/delivery/tracking.do?barcode=" }
      };
      const carrierInfo = carrierMap[shipment.shipping_company_code] || { name: shipment.shipping_company_name || "지정 택배사", url: "" };
      shipment.shipping_company_name = carrierInfo.name;
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

  // 2. [안전장치] 고객센터 전화번호 (검색 실패 대비 하드코딩)
  if (normalized.includes("고객센터") && (normalized.includes("번호") || normalized.includes("전화"))) {
      return { text: "요기보 고객센터 전화번호는 **02-557-0920** 입니다. 😊<br>운영시간: 평일 10:00 ~ 17:30 (점심시간 12:00~13:00)" };
  }

  // 3. 매장 안내
  if (normalized.includes("오프라인 매장") || normalized.includes("매장안내")) {
    return { text: `가까운 매장을 안내해 드립니다.<br><a href="/why.stroe.html" target="_blank">매장안내 바로가기</a>` };
  }

  // 4. 내 아이디 조회
  if (normalized.includes("내 아이디") || normalized.includes("아이디 조회")) {
    return isUserLoggedIn(memberId)
      ? { text: `안녕하세요 ${memberId} 고객님, 무엇을 도와드릴까요?` }
      : { text: `로그인이 필요한 서비스입니다.<br>아래 버튼을 눌러 로그인해주세요.${LOGIN_BTN_HTML}` };
  }

  // 5. 주문번호로 배송 조회
  if (containsOrderNumber(normalized)) {
    if (isUserLoggedIn(memberId)) {
      try {
        const orderId = normalized.match(/\d{8}-\d{7}/)[0];
        const ship = await getShipmentDetail(orderId);
        if (ship) {
            const status = ship.status || "배송 준비중";
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

  // 6. 일반 배송/주문 조회 (조건 강화)
  const isTracking = (normalized.includes("배송") || normalized.includes("주문")) && 
                     (normalized.includes("조회") || normalized.includes("확인") || normalized.includes("언제") || normalized.includes("어디"));
  const isFAQ = normalized.includes("비용") || normalized.includes("비") || normalized.includes("주소") || normalized.includes("변경");

  if (isTracking && !isFAQ && !containsOrderNumber(normalized)) {
    if (isUserLoggedIn(memberId)) {
      try {
        const data = await getOrderShippingInfo(memberId);
        if (data.orders?.[0]) {
          const t = data.orders[0];
          const ship = await getShipmentDetail(t.order_id);
          if (ship) {
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

  // (2) 사이즈
  if (normalized.includes("사이즈") || normalized.includes("크기")) {
    const types = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
    for (let t of types) {
      if (normalized.includes(t) && companyData.sizeInfo?.[`${t} 사이즈 또는 크기.`]) {
        return { text: formatResponseText(companyData.sizeInfo[`${t} 사이즈 또는 크기.`].description), imageUrl: companyData.sizeInfo[`${t} 사이즈 또는 크기.`].imageUrl };
      }
    }
  }

  // (3) 비즈 안내
  if (normalized.includes("비즈") || normalized.includes("충전재") || normalized.includes("알갱이")) {
    const actionKeywords = ["충전", "방법", "넣는", "보충", "리필", "세탁", "버리", "폐기", "교체", "구매", "파는"];
    if (actionKeywords.some(keyword => normalized.includes(keyword))) {
        return null; // 검색 로직으로 이동
    }

    let key = null;
    if (normalized.includes("프리미엄 플러스")) key = "프리미엄 플러스 비즈 에 대해 알고 싶어";
    else if (normalized.includes("프리미엄")) key = "프리미엄 비즈 에 대해 알고 싶어";
    else if (normalized.includes("스탠다드")) key = "스탠다드 비즈 에 대해 알고 싶어";
    
    if (key && companyData.biz?.[key]) { return { text: formatResponseText(companyData.biz[key].description) }; }
    // 단순 '비즈 종류' 문의에 대한 답변
    return {
      text: formatResponseText(`요기보의 정품 비즈(충전재)는 3가지 종류가 있습니다. 😊. 
        1️⃣ 스탠다드 비즈: 전세계 빈백소파에 가장 많이 사용 되는 충전재입니다. 편안함과 부드러운 사용감에 초점이 맞춰져 있어요. Yogibo의 트랜스포밍 기능을 사용하는데 최적화 되어있는 비즈입니다.. 
        2️⃣ 프리미엄 비즈: Yogibo에서 개발하여, 국내 독점으로 사용하고 있는 신소재(HRF)에요. 스탠다드 비즈의 부드러움과 편안함을 유지하고, 복원력과 내구성은 월등히 업그레이드 한 비즈입니다.. 
        3️⃣ 프리미엄 플러스: 스탠다드 비즈 대비 복원력과 내구성이 10배 이상 업그레이드 된 차세대 비즈에요. 집 뿐만 아니라 많은 사람들이 이용하는 공용 공간에 최적화된 비즈입니다.`)
    };
  }

  // (4) 추천 상품
  if (normalized.includes("추천") || normalized.includes("인기")) {
      const maxInfo = companyData.sizeInfo?.["맥스 사이즈 또는 크기."];
      if (maxInfo) {
          return {
              text: formatResponseText(`요기보의 베스트셀러, 맥스(Max)를 추천드려요! 👍. 가장 인기 있는 사이즈로, 침대/소파/의자 등 다양하게 활용 가능합니다. ${maxInfo.description}`),
              imageUrl: maxInfo.imageUrl
          };
      }
  }

  // (5) 기타 정보
  if (companyData.goodsInfo) {
    let b=null, m=6; for(let k in companyData.goodsInfo){const d=levenshtein.get(normalized,normalizeSentence(k));if(d<m){m=d;b=companyData.goodsInfo[k];}}
    if(b) return { text: formatResponseText(Array.isArray(b.description)?b.description.join("\n"):b.description), imageUrl: b.imageUrl };
  }
  if (companyData.homePage) {
    let b=null, m=5; for(let k in companyData.homePage){const d=levenshtein.get(normalized,normalizeSentence(k));if(d<m){m=d;b=companyData.homePage[k];}}
    if(b) return { text: formatResponseText(b.description) };
  }
  if (companyData.asInfo) {
    let b=null, m=8; for(let k in companyData.asInfo){const d=levenshtein.get(normalized,normalizeSentence(k));if(d<m){m=d;b=companyData.asInfo[k];}}
    if(b) return { text: formatResponseText(b.description) };
  }

  return null;
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
    gptAnswer = formatResponseText(gptAnswer);

    // ✅ 검색된 정보가 없을 때만 상담사 연결 버튼 부착
    if (docs.length === 0) {
        gptAnswer += FALLBACK_MESSAGE_HTML;
    }

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

//const runDb=async(cb)=>{const c=new MongoClient(MONGODB_URI);await c.connect();try{return await cb(c.db(DB_NAME))}finally{await c.close()}};
const EC='eventTemple';
const nb=blocks=>blocks.map(b=>(b?.type==='video'?{...b,autoplay:!!b.autoplay}:b));
app.post('/api/:_any/eventTemple',async(req,res)=>{try{const p={...req.body,createdAt:new Date()};if(p.content?.blocks)p.content.blocks=nb(p.content.blocks);const r=await runDb(db=>db.collection(EC).insertOne(p));res.json({_id:r.insertedId,...p})}catch(e){res.status(500).json({error:'Err'})}});
app.get('/api/:_any/eventTemple',async(req,res)=>{try{const l=await runDb(db=>db.collection(EC).find({mallId:CAFE24_MALLID}).sort({createdAt:-1}).toArray());res.json(l)}catch(e){res.status(500).json({error:'Err'})}});
app.get('/api/:_any/eventTemple/:id',async(req,res)=>{try{const d=await runDb(db=>db.collection(EC).findOne({_id:new ObjectId(req.params.id)}));res.json(d)}catch(e){res.status(500).json({error:'Err'})}});
app.put('/api/:_any/eventTemple/:id',async(req,res)=>{try{const s={...req.body,updatedAt:new Date()};if(s.content?.blocks)s.content.blocks=nb(s.content.blocks);delete s._id;await runDb(db=>db.collection(EC).updateOne({_id:new ObjectId(req.params.id)},{$set:s}));res.json({success:true})}catch(e){res.status(500).json({error:'Err'})}});
app.delete('/api/:_any/eventTemple/:id',async(req,res)=>{try{await runDb(db=>db.collection(EC).deleteOne({_id:new ObjectId(req.params.id)}));res.json({success:true})}catch(e){res.status(500).json({error:'Err'})}});




//요기보 탬플



//여기부터 yogibo 템플 추가 하여 진행하기

// 필요 모듈 (중복 require 있으면 이 줄들은 생략하세요)
const ftp = require('basic-ftp');
const dayjs = require('dayjs');
const MALL_ID = 'yogibo';
const FTP_HOST = 'yogibo.ftp.cafe24.com';
const FTP_USER = 'yogibo';
const FTP_PASS = 'korea2025!!';


// 퍼블릭 URL 접두사 (중복 슬래시 방지)
const FTP_PUBLIC_BASE = (process.env.FTP_PUBLIC_BASE || 'http://yogibo.openhost.cafe24.com/web/img/temple').replace(/\/+$/,'');


// 업로드 엔드포인트 (이 블록만 교체)
app.post('/api/:_any/uploads/image', upload.single('file'), async (req, res) => {
  const localPath = req.file?.path;
  const filename  = req.file?.filename;
  if (!localPath || !filename) {
    return res.status(400).json({ error: '파일이 없습니다.' });
  }

  const client = new ftp.Client(15000);
  client.ftp.verbose = false;

  try {
    await client.access({
      host: FTP_HOST,
      user: FTP_USER,
      password: FTP_PASS,
      secure: false,            // Cafe24 일반 FTP
    });

    const pwd0 = await client.pwd().catch(() => '(pwd error)');
    console.log('[FTP] login PWD:', pwd0);

    // 날짜 suffix: yogibo/YYYY/MM/DD
    const ymd = dayjs().format('YYYY/MM/DD');
    const relSuffix = `${MALL_ID}/${ymd}`;

    // 📌 상대경로 베이스 후보 (상단 트리 스샷 기준)
    const baseCandidates = [
      'web/img/temple/uploads',
      'img/temple/uploads',
      'temple/uploads',
    ];

    let usedBase = null;
    let finalPwd = null;

    for (const base of baseCandidates) {
      try {
        // 항상 시작 지점으로 돌아가려 시도 (에러 무시)
        try { await client.cd('/'); } catch {}
        try { await client.cd(pwd0); } catch {}

        // 상대경로로 베이스 진입 시도
        await client.cd(base);
        console.log('[FTP] cd base OK:', base, 'pwd:', await client.pwd());

        // base/yogibo/YYYY/MM/DD 생성 & 진입
        await client.ensureDir(relSuffix);
        finalPwd = await client.pwd();
        console.log('[FTP] ensured subdir, pwd:', finalPwd);

        // 업로드 (현재 디렉터리에 filename 저장)
        await client.uploadFrom(localPath, filename);

        // 검증용: 사이즈/리스트
        let size = -1;
        try { size = await client.size(filename); } catch {}
        const listing = await client.list().catch(() => []);
        console.log('[FTP] uploaded:', `${finalPwd}/${filename}`, 'size:', size);
        console.log('[FTP] list in final dir:', listing.map(i => i.name));

        usedBase = base;
        // 공개 URL 생성
        const url = `${FTP_PUBLIC_BASE}/uploads/${relSuffix}/${filename}`.replace(/([^:]\/)\/+/g, '$1');

        return res.json({
          url,
          ftpBase: usedBase,
          ftpDir: finalPwd,
          ftpPath: `${finalPwd}/${filename}`,
          size,
        });
      } catch (e) {
        console.log('[FTP] try base fail:', base, e?.message || e);
        // 다음 후보로 계속
      }
    }

    // 어떤 베이스도 진입 실패
    return res.status(500).json({
      error: '경로 이동 실패',
      detail: 'uploads 베이스 디렉터리에 진입할 수 없습니다.',
      tried: baseCandidates,
      loginPwd: pwd0,
    });
  } catch (err) {
    console.error('[IMAGE UPLOAD ERROR][FTP]', err?.code, err?.message || err);
    return res.status(500).json({ error: '이미지 업로드 실패(FTP)', detail: err?.message || String(err) });
  } finally {
    try { client.close(); } catch {}
    fs.unlink(localPath, () => {});
  }
});


// ───────────────────────────────────────────────
// DB helper (withDb가 전역에 없을 때를 대비한 안전 래퍼)
// ───────────────────────────────────────────────
const runDb =
  (typeof withDb === 'function')
    ? withDb
    : async (task) => {
        const client = new MongoClient(MONGODB_URI, { maxPoolSize: 8 });
        await client.connect();
        try { return await task(client.db(DB_NAME)); }
        finally { await client.close(); }
      };

const EVENT_COLL = 'eventTemple';

/** ✅ NEW: blocks 내 video.autoplay를 Boolean으로 정규화 */
function normalizeBlocks(blocks = []) {
  if (!Array.isArray(blocks)) return [];
  return blocks.map(b => {
    const type = b?.type || 'image';
    if (type === 'video') {
      return {
        ...b,
        autoplay:
          b?.autoplay === true ||
          b?.autoplay === 'true' ||
          b?.autoplay === 1 ||
          b?.autoplay === '1'
      };
    }
    return b;
  });
}

// ───────────────────────────────────────────────
// EventTemple + events(알리아스) 라우트 마운트
// ───────────────────────────────────────────────
function mountEventRoutes(basePath) {
  // 생성
  app.post(`/api/:_any${basePath}`, async (req, res) => {
    try {
      const payload = req.body || {};
      if (!payload.title || typeof payload.title !== 'string') {
        return res.status(400).json({ error: '제목(title)을 입력해주세요.' });
      }
      if (!Array.isArray(payload.images)) {
        return res.status(400).json({ error: 'images를 배열로 보내주세요.' });
      }

      /** ✅ content 정규화 */
      const content = payload.content || {};
      if (Array.isArray(content.blocks)) {
        content.blocks = normalizeBlocks(content.blocks);
      }

      const now = new Date();
      const doc = {
        mallId: MALL_ID,
        title: payload.title.trim(),
        content, // ← 보정된 content 저장
        images: payload.images,
        gridSize: payload.gridSize ?? null,
        layoutType: payload.layoutType || 'none',
        classification: payload.classification || {},
        createdAt: now,
        updatedAt: now,
      };

      const result = await runDb(db => db.collection(EVENT_COLL).insertOne(doc));
      return res.json({ _id: result.insertedId, ...doc });
    } catch (err) {
      console.error('[CREATE eventTemple ERROR]', err);
      return res.status(500).json({ error: '이벤트 생성에 실패했습니다.' });
    }
  });

  // 목록
  app.get(`/api/:_any${basePath}`, async (req, res) => {
    try {
      const list = await runDb(db =>
        db.collection(EVENT_COLL)
          .find({ mallId: MALL_ID })
          .sort({ createdAt: -1 })
          .toArray()
      );
      return res.json(list);
    } catch (err) {
      console.error('[GET eventTemple ERROR]', err);
      return res.status(500).json({ error: '이벤트 목록 조회에 실패했습니다.' });
    }
  });

  // 상세
  app.get(`/api/:_any${basePath}/:id`, async (req, res) => {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
    try {
      const ev = await runDb(db =>
        db.collection(EVENT_COLL).findOne({ _id: new ObjectId(id), mallId: MALL_ID })
      );
      if (!ev) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
      return res.json(ev);
    } catch (err) {
      console.error('[GET eventTemple ONE ERROR]', err);
      return res.status(500).json({ error: '이벤트 조회에 실패했습니다.' });
    }
  });

  // 수정
  app.put(`/api/:_any${basePath}/:id`, async (req, res) => {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
    const p = req.body || {};
    const set = { updatedAt: new Date() };
    if (p.title) set.title = String(p.title).trim();

    /** ✅ content.blocks 정규화 후 저장 */
    if (p.content) {
      const content = p.content;
      if (Array.isArray(content.blocks)) {
        content.blocks = normalizeBlocks(content.blocks);
      }
      set.content = content;
    }

    if (Array.isArray(p.images)) set.images = p.images;
    if (p.gridSize !== undefined) set.gridSize = p.gridSize;
    if (p.layoutType) set.layoutType = p.layoutType;
    if (p.classification) set.classification = p.classification;

    try {
      const r = await runDb(db =>
        db.collection(EVENT_COLL).updateOne(
          { _id: new ObjectId(id), mallId: MALL_ID },
          { $set: set }
        )
      );
      if (!r.matchedCount) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
      const updated = await runDb(db =>
        db.collection(EVENT_COLL).findOne({ _id: new ObjectId(id) })
      );
      return res.json({ success: true, data: updated });
    } catch (err) {
      console.error('[UPDATE eventTemple ERROR]', err);
      return res.status(500).json({ error: '이벤트 수정에 실패했습니다.' });
    }
  });

  // 삭제
  app.delete(`/api/:_any${basePath}/:id`, async (req, res) => {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
    try {
      const r = await runDb(db =>
        db.collection(EVENT_COLL).deleteOne({ _id: new ObjectId(id), mallId: MALL_ID })
      );
      if (!r.deletedCount) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
      return res.json({ success: true });
    } catch (err) {
      console.error('[DELETE eventTemple ERROR]', err);
      return res.status(500).json({ error: '이벤트 삭제에 실패했습니다.' });
    }
  });
}

// 신규 경로
mountEventRoutes('/eventTemple');

// =========================
// Events CRUD  (Mongo collection: eventTemple)
// =========================
app.post('/api/:_any/events', async (req, res) => {
  const payload = req.body;
  if (!payload.title || typeof payload.title !== 'string') {
    return res.status(400).json({ error: '제목(title)을 입력해주세요.' });
  }
  if (!Array.isArray(payload.images)) {
    return res.status(400).json({ error: 'images를 배열로 보내주세요.' });
  }

  try {
    /** ✅ content.blocks 정규화 */
    const content = payload.content || {};
    if (Array.isArray(content.blocks)) {
      content.blocks = normalizeBlocks(content.blocks);
    }

    const now = new Date();
    const doc = {
      mallId: MALL_ID,
      title: payload.title.trim(),
      content,                       // ← 보정된 content 저장
      images: payload.images,        // [{url, regions...}]
      gridSize: payload.gridSize || null,
      layoutType: payload.layoutType || 'none',
      classification: payload.classification || {},
      createdAt: now,
      updatedAt: now,
    };

    const result = await runDb(db => db.collection(EVENT_COLL).insertOne(doc));
    res.json({ _id: result.insertedId, ...doc });
  } catch (err) {
    console.error('[CREATE EVENT ERROR]', err);
    res.status(500).json({ error: '이벤트 생성에 실패했습니다.' });
  }
});

app.get('/api/:_any/events', async (req, res) => {
  try {
    const list = await runDb(db =>
      db.collection(EVENT_COLL)
        .find({ mallId: MALL_ID })
        .sort({ createdAt: -1 })
        .toArray()
    );
    res.json(list);
  } catch (err) {
    console.error('[GET EVENTS ERROR]', err);
    res.status(500).json({ error: '이벤트 목록 조회에 실패했습니다.' });
  }
});

app.get('/api/:_any/events/:id', async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
  }
  try {
    const ev = await runDb(db =>
      db.collection(EVENT_COLL).findOne({ _id: new ObjectId(id), mallId: MALL_ID })
    );
    if (!ev) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
    res.json(ev);
  } catch (err) {
    console.error('[GET EVENT ERROR]', err);
    res.status(500).json({ error: '이벤트 조회에 실패했습니다.' });
  }
});

app.put('/api/:_any/events/:id', async (req, res) => {
  const { id } = req.params;
  const payload = req.body;
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
  }
  if (!payload.title && !payload.content && !payload.images &&
      payload.gridSize === undefined && !payload.layoutType && !payload.classification) {
    return res.status(400).json({ error: '수정할 내용을 하나 이상 보내주세요.' });
  }

  /** ✅ update용 content 보정 */
  const update = { updatedAt: new Date() };
  if (payload.title) update.title = payload.title.trim();

  if (payload.content) {
    const content = payload.content;
    if (Array.isArray(content.blocks)) {
      content.blocks = normalizeBlocks(content.blocks);
    }
    update.content = content;
  }

  if (Array.isArray(payload.images)) update.images = payload.images;
  if (payload.gridSize !== undefined) update.gridSize = payload.gridSize;
  if (payload.layoutType) update.layoutType = payload.layoutType;
  if (payload.classification) update.classification = payload.classification;

  try {
    const result = await runDb(db =>
      db.collection(EVENT_COLL).updateOne(
        { _id: new ObjectId(id), mallId: MALL_ID },
        { $set: update }
      )
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
    }
    const updated = await runDb(db =>
      db.collection(EVENT_COLL).findOne({ _id: new ObjectId(id) })
    );
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[UPDATE EVENT ERROR]', err);
    res.status(500).json({ error: '이벤트 수정에 실패했습니다.' });
  }
});

app.delete('/api/:_any/events/:id', async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
  }
  const eventId = new ObjectId(id);
  const visitsColl = `visits_${MALL_ID}`;
  const clicksColl = `clicks_${MALL_ID}`;
  const prdClick   = `prdClick_${MALL_ID}`;

  try {
    const { deletedCount } = await runDb(db =>
      db.collection(EVENT_COLL).deleteOne({ _id: eventId, mallId: MALL_ID })
    );
    if (!deletedCount) {
      return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
    }

    // 연관 로그 제거
    await runDb(async db => {
      await Promise.all([
        db.collection(visitsColl).deleteMany({ pageId: id }),
        db.collection(clicksColl).deleteMany({ pageId: id }),
        db.collection(prdClick).deleteMany({ pageId: id })
      ]);
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE EVENT ERROR]', err);
    res.status(500).json({ error: '이벤트 삭제에 실패했습니다.' });
  }
});

// =========================
// 트래킹 (view/revisit/click)
// =========================
app.post('/api/:_any/track', async (req, res) => {
  try {
    const {
      pageId, pageUrl, visitorId, referrer,
      device, type, element, timestamp,
      productNo
    } = req.body;

    if (!pageId || !visitorId || !type || !timestamp) {
      return res.status(400).json({ error: '필수 필드 누락' });
    }
    if (!ObjectId.isValid(pageId)) return res.sendStatus(204);

    // 이벤트 존재 확인
    const exists = await runDb(db =>
      db.collection(EVENT_COLL).findOne(
        { _id: new ObjectId(pageId) },
        { projection: { _id: 1 } }
      )
    );
    if (!exists) return res.sendStatus(204);

    // KST 기반 dateKey
    const ts = new Date(timestamp);
    const kst = new Date(ts.getTime() + 9 * 60 * 60 * 1000);
    const dateKey = kst.toISOString().slice(0, 10);

    // URL path만 추출
    let pathOnly;
    try { pathOnly = new URL(pageUrl).pathname; } catch { pathOnly = pageUrl; }

    // 상품 클릭 → prdClick_yogibo 집계
    if (type === 'click' && element === 'product' && productNo) {
      let productName = null;
      try {
        const productRes = await apiRequest(
          'GET',
          `https://${MALL_ID}.cafe24api.com/api/v2/admin/products/${productNo}`,
          {},
          { shop_no: 1 }
        );
        const prod = productRes.product || productRes.products?.[0];
        productName = prod?.product_name || null;
      } catch (e) {
        console.error('[PRODUCT NAME FETCH ERROR]', e?.response?.data || e);
      }

      await runDb(db =>
        db.collection(`prdClick_${MALL_ID}`).updateOne(
          { pageId, productNo },
          {
            $inc: { clickCount: 1 },
            $setOnInsert: {
              productName,
              firstClickAt: kst,
              pageUrl: pathOnly,
              referrer: referrer || null,
              device: device || null
            },
            $set: { lastClickAt: kst }
          },
          { upsert: true }
        )
      );
      return res.sendStatus(204);
    }

    // 그 외 클릭 (URL / 쿠폰 등)
    if (type === 'click') {
      if (element === 'coupon') {
        const coupons = Array.isArray(productNo) ? productNo : [productNo];
        await runDb(async db => {
          await Promise.all(coupons.map(cpn =>
            db.collection(`clicks_${MALL_ID}`).insertOne({
              pageId, visitorId, dateKey, pageUrl: pathOnly,
              referrer: referrer || null, device: device || null,
              type, element, timestamp: kst, couponNo: cpn
            })
          ));
        });
        return res.sendStatus(204);
      }

      // element === 'url' or others
      await runDb(db =>
        db.collection(`clicks_${MALL_ID}`).insertOne({
          pageId, visitorId, dateKey, pageUrl: pathOnly,
          referrer: referrer || null, device: device || null,
          type, element, timestamp: kst
        })
      );
      return res.sendStatus(204);
    }

    // view / revisit → visits_yogibo upsert
    const filter2 = { pageId, visitorId, dateKey };
    const update2 = {
      $set: {
        lastVisit: kst,
        pageUrl: pathOnly,
        referrer: referrer || null,
        device: device || null
      },
      $setOnInsert: { firstVisit: kst },
      $inc: {}
    };
    if (type === 'view')    update2.$inc.viewCount = 1;
    if (type === 'revisit') update2.$inc.revisitCount = 1;

    await runDb(db =>
      db.collection(`visits_${MALL_ID}`).updateOne(filter2, update2, { upsert: true })
    );

    return res.sendStatus(204);
  } catch (err) {
    console.error('[TRACK ERROR]', err);
    return res.status(500).json({ error: '트래킹 실패' });
  }
});

// =========================
// 카테고리 / 쿠폰 / 상품 API (Cafe24)
// =========================
app.get('/api/:_any/categories/all', async (req, res) => {
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${MALL_ID}.cafe24api.com/api/v2/admin/categories`;
      const { categories = [] } = await apiRequest('GET', url, {}, { limit, offset });
      if (!categories.length) break;
      all.push(...categories);
      offset += categories.length;
    }
    res.json(all);
  } catch (err) {
    console.error('[CATEGORIES ERROR]', err);
    res.status(500).json({ message: '전체 카테고리 조회 실패', error: err.message });
  }
});

app.get('/api/:_any/coupons', async (req, res) => {
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
    const url = `https://${MALL_ID}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons = [] } = await apiRequest('GET', url, {}, { shop_no: 1, limit, offset });
      if (!coupons.length) break;
      all.push(...coupons);
      offset += coupons.length;
    }
    res.json(all);
  } catch (err) {
    console.error('[COUPONS ERROR]', err);
    res.status(500).json({ message: '쿠폰 조회 실패', error: err.message });
  }
});



// 쿠폰 통계
app.get('/api/:_any/analytics/:pageId/coupon-stats', async (req, res) => {
  const { coupon_no, start_date, end_date } = req.query;
  if (!coupon_no) return res.status(400).json({ error: 'coupon_no is required' });

  const shop_no = 1;
  const couponNos = coupon_no.split(',');
  const now = new Date();
  const results = [];

  try {
    for (const no of couponNos) {
      // 1) 쿠폰 이름
      let couponName = '(이름없음)';
      try {
        const nameRes = await apiRequest(
          'GET',
          `https://${MALL_ID}.cafe24api.com/api/v2/admin/coupons`,
          {},
          { shop_no, coupon_no: no, coupon_status: 'ALL', fields:'coupon_no,coupon_name', limit:1 }
        );
        couponName = nameRes.coupons?.[0]?.coupon_name || couponName;
      } catch {}

      // 2) 이슈 집계
      let issued = 0, used = 0, unused = 0, autoDel = 0;
      const pageSize = 500;
      for (let offset = 0; ; offset += pageSize) {
        const issuesRes = await apiRequest(
          'GET',
          `https://${MALL_ID}.cafe24api.com/api/v2/admin/coupons/${no}/issues`,
          {},
          { shop_no, limit: pageSize, offset, issued_start_date: start_date, issued_end_date: end_date }
        );
        const issues = issuesRes.issues || [];
        if (!issues.length) break;

        for (const item of issues) {
          issued++;
          if (item.used_coupon === 'T') used++;
          else {
            const exp = item.expiration_date ? new Date(item.expiration_date) : null;
            if (exp && exp < now) autoDel++; else unused++;
          }
        }
      }

      results.push({ couponNo: no, couponName, issuedCount: issued, usedCount: used, unusedCount: unused, autoDeletedCount: autoDel });
    }
    res.json(results);
  } catch (err) {
    console.error('[COUPON-STATS ERROR]', err);
    res.status(500).json({ error: '쿠폰 통계 조회 실패', message: err.response?.data?.message || err.message });
  }
})


// 카테고리별 상품 + 쿠폰혜택
app.get('/api/:_any/categories/:category_no/products', async (req, res) => {
  const { category_no } = req.params;
  try {
    const coupon_query = req.query.coupon_no || '';
    const coupon_nos   = coupon_query ? coupon_query.split(',') : [];
    const limit        = parseInt(req.query.limit, 10)  || 100;
    const offset       = parseInt(req.query.offset, 10) || 0;
    const shop_no      = 1;
    const display_group = 1;

    // 쿠폰 로드
    const coupons = await Promise.all(coupon_nos.map(async no => {
      const urlCoupon = `https://${MALL_ID}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons: arr } = await apiRequest('GET', urlCoupon, {}, {
        shop_no, coupon_no: no,
        fields: 'coupon_no,available_product,available_product_list,available_category,available_category_list,benefit_amount,benefit_percentage'
      });
      return arr?.[0] || null;
    }));
    const validCoupons = coupons.filter(Boolean);

    // 카테고리 매핑
    const urlCats = `https://${MALL_ID}.cafe24api.com/api/v2/admin/categories/${category_no}/products`;
    const catRes = await apiRequest('GET', urlCats, {}, { shop_no, display_group, limit, offset });
    const sorted = (catRes.products || []).slice().sort((a,b)=>a.sequence_no-b.sequence_no);
    const productNos = sorted.map(p=>p.product_no);
    if (!productNos.length) return res.json([]);

    // 1. 기본 상품 정보
    const urlProds = `https://${MALL_ID}.cafe24api.com/api/v2/admin/products`;
    const detailRes = await apiRequest('GET', urlProds, {}, {
      shop_no,
      product_no: productNos.join(','),
      limit: productNos.length,
      fields: 'product_no,product_name,price,summary_description,list_image,icons,product_tags'
    });
    const details = detailRes.products || [];
    const detailMap = details.reduce((m,p)=>{ m[p.product_no]=p; return m; },{});

    // 2. 각 상품의 '아이콘 꾸미기' 정보 병렬 호출 및 기간 확인
    const iconPromises = productNos.map(async (no) => {
      const iconsUrl = `https://${MALL_ID}.cafe24api.com/api/v2/admin/products/${no}/icons`;
      try {
        const iconsRes = await apiRequest('GET', iconsUrl, {}, { shop_no });
        const iconsData = iconsRes?.icons;
        
        let imageList = [];
        if (iconsData) {
          if (iconsData.use_show_date !== 'T') {
            imageList = iconsData.image_list || [];
          } else {
            const now = new Date();
            const start = new Date(iconsData.show_start_date);
            const end = new Date(iconsData.show_end_date);
            if (now >= start && now < end) {
              imageList = iconsData.image_list || [];
            }
          }
        }
        
        return {
          product_no: no,
          customIcons: imageList.map(icon => ({ icon_url: icon.path, icon_alt: icon.code }))
        };
      } catch (e) {
        return { product_no: no, customIcons: [] };
      }
    });
    const iconResults = await Promise.all(iconPromises);
    const iconsMap = iconResults.reduce((m, item) => {
      m[item.product_no] = item.customIcons;
      return m;
    }, {});

    // 즉시할인가
    const discountMap = {};
    await Promise.all(productNos.map(async no => {
      const urlDis = `https://${MALL_ID}.cafe24api.com/api/v2/admin/products/${no}/discountprice`;
      const { discountprice } = await apiRequest('GET', urlDis, {}, { shop_no });
      discountMap[no] = discountprice?.pc_discount_price != null ? parseFloat(discountprice.pc_discount_price) : null;
    }));

    const formatKRW = num => num!=null ? Number(num).toLocaleString('ko-KR') + '원' : null;

    // 쿠폰 계산 함수
    function calcCouponInfos(prodNo) {
      return validCoupons.map(coupon=>{
        const pList = coupon.available_product_list || [];
        const prodOk =
          coupon.available_product==='U' ||
          (coupon.available_product==='I' && pList.includes(prodNo)) ||
          (coupon.available_product==='E' && !pList.includes(prodNo));
        const cList = coupon.available_category_list || [];
        const catOk =
          coupon.available_category==='U' ||
          (coupon.available_category==='I' && cList.includes(parseInt(category_no,10))) ||
          (coupon.available_category==='E' && !cList.includes(parseInt(category_no,10)));
        if (!prodOk || !catOk) return null;

        const orig = parseFloat(detailMap[prodNo].price || 0);
        const pct  = parseFloat(coupon.benefit_percentage || 0);
        const amt  = parseFloat(coupon.benefit_amount || 0);
        let benefit_price = null;
        if (pct>0) benefit_price = +(orig*(100-pct)/100).toFixed(2);
        else if (amt>0) benefit_price = +(orig-amt).toFixed(2);
        if (benefit_price==null) return null;

        return { coupon_no: coupon.coupon_no, benefit_percentage: pct, benefit_price };
      }).filter(Boolean).sort((a,b)=>b.benefit_percentage-a.benefit_percentage);
    }

    const full = sorted.map(item => {
      const prod = detailMap[item.product_no];
      if (!prod) return null;
      return {
        product_no: item.product_no,
        product_name: prod.product_name,
        price: prod.price,
        summary_description: prod.summary_description,
        list_image: prod.list_image,
        sale_price: discountMap[item.product_no],
        couponInfos: calcCouponInfos(item.product_no),
        icons: prod.icons,
        additional_icons: iconsMap[item.product_no] || [],
        product_tags: prod.product_tags
      };
    }).filter(Boolean);

    const slim = full.map(p => {
      const infos = p.couponInfos || [];
      const first = infos.length ? infos[0] : null;
      return {
        product_no: p.product_no,
        product_name: p.product_name,
        price: formatKRW(parseFloat(p.price)),
        summary_description: p.summary_description,
        list_image: p.list_image,
        sale_price: (p.sale_price!=null && +p.sale_price!==+p.price) ? formatKRW(p.sale_price) : null,
        benefit_price: first ? formatKRW(first.benefit_price) : null,
        benefit_percentage: first ? first.benefit_percentage : null,
        couponInfos: infos.length ? infos : null,
        icons: p.icons,
        additional_icons: p.additional_icons || [],
        product_tags: p.product_tags
      };
    });

    res.json(slim);
  } catch (err) {
    console.error('[CATEGORY PRODUCTS ERROR]', err);
    res.status(err.response?.status || 500).json({ message: '카테고리 상품 조회 실패', error: err.message });
  }
});

// 전체 상품 조회
app.get('/api/:_any/products', async (req, res) => {
  try {
    const shop_no = 1;
    const limit   = parseInt(req.query.limit, 10) || 1000;
    const offset  = parseInt(req.query.offset,10) || 0;
    const q       = (req.query.q || '').trim();
    const url     = `https://${MALL_ID}.cafe24api.com/api/v2/admin/products`;

    const params = { shop_no, limit, offset };
    if (q) params['search[product_name]'] = q;

    const data = await apiRequest('GET', url, {}, params);
    const slim = (data.products || []).map(p => ({
      product_no: p.product_no,
      product_code: p.product_code,
      product_name: p.product_name,
      price: p.price,
      list_image: p.list_image
    }));

    res.json({ products: slim, total: data.total_count });
  } catch (err) {
    console.error('[GET PRODUCTS ERROR]', err);
    res.status(500).json({ error: '전체 상품 조회 실패' });
  }
});


// 단일 상품 조회
app.get('/api/:_any/products/:product_no', async (req, res) => {
  const { product_no } = req.params;
  try {
    const shop_no = 1;
    const coupon_query = req.query.coupon_no || '';
    const coupon_nos = coupon_query.split(',').filter(Boolean);

    // 1. 기본 상품 정보
    const prodUrl = `https://${MALL_ID}.cafe24api.com/api/v2/admin/products/${product_no}`;
    const prodData = await apiRequest('GET', prodUrl, {}, {
      shop_no,
      fields: 'product_no,product_code,product_name,price,summary_description,list_image,icons,product_tags'
    });
    const p = prodData.product || prodData.products?.[0];
    if (!p) return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });

    // 2. '아이콘 꾸미기' 정보 호출 및 기간 확인
    const iconsUrl = `https://${MALL_ID}.cafe24api.com/api/v2/admin/products/${product_no}/icons`;
    let customIcons = [];
    try {
      const iconsRes = await apiRequest('GET', iconsUrl, {}, { shop_no });
      const iconsData = iconsRes?.icons;
      
      // 기간 만료 아이콘 필터링 로직
      if (iconsData) {
        let imageList = [];
        if (iconsData.use_show_date !== 'T') {
          imageList = iconsData.image_list || [];
        } else {
          const now = new Date();
          const start = new Date(iconsData.show_start_date);
          const end = new Date(iconsData.show_end_date);
          if (now >= start && now < end) {
            imageList = iconsData.image_list || [];
          }
        }
        customIcons = imageList.map(icon => ({
          icon_url: icon.path,
          icon_alt: icon.code
        }));
      }

    } catch (iconErr) {
      console.warn(`[ICONS API WARN] product_no ${product_no}:`, iconErr.message);
    }
    
    // 즉시할인가 조회
    const disUrl = `https://${MALL_ID}.cafe24api.com/api/v2/admin/products/${product_no}/discountprice`;
    const disData = await apiRequest('GET', disUrl, {}, { shop_no });
    const rawSale = disData.discountprice?.pc_discount_price;
    const sale_price = rawSale != null ? parseFloat(rawSale) : null;
    
    // 쿠폰 관련 로직
    const coupons = await Promise.all(coupon_nos.map(async no => {
      const urlCoupon = `https://${MALL_ID}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons: arr } = await apiRequest('GET', urlCoupon, {}, {
        shop_no,
        coupon_no: no,
        fields: [
          'coupon_no',
          'available_product','available_product_list',
          'available_category','available_category_list',
          'benefit_amount','benefit_percentage'
        ].join(',')
      });
      return arr?.[0] || null;
    }));
    const validCoupons = coupons.filter(Boolean);

    let benefit_price = null, benefit_percentage = null;
    validCoupons.forEach(coupon => {
      const pList = coupon.available_product_list || [];
      const ok =
        coupon.available_product === 'U' ||
        (coupon.available_product === 'I' && pList.includes(parseInt(product_no,10))) ||
        (coupon.available_product === 'E' && !pList.includes(parseInt(product_no,10)));
      if (!ok) return;
      const orig = parseFloat(p.price);
      const pct  = parseFloat(coupon.benefit_percentage || 0);
      const amt  = parseFloat(coupon.benefit_amount || 0);
      let bPrice = null;
      if (pct>0) bPrice = +((orig*(100-pct))/100).toFixed(2);
      else if (amt>0) bPrice = +(orig-amt).toFixed(2);
      if (bPrice!=null && pct>(benefit_percentage||0)) {
        benefit_price = bPrice;
        benefit_percentage = pct;
      }
    });

    // 3. 최종 응답
    res.json({
      product_no,
      product_code: p.product_code,
      product_name: p.product_name,
      price: p.price,
      summary_description: p.summary_description || '',
      sale_price,
      benefit_price,
      benefit_percentage,
      list_image: p.list_image,
      icons: p.icons, 
      additional_icons: customIcons, // 필터링된 아이콘
      product_tags: p.product_tags
    });
  } catch (err) {
    console.error('[GET PRODUCT ERROR]', err);
    res.status(500).json({ error: '단일 상품 조회 실패' });
  }
});


// =========================
// Analytics (MongoDB)
// =========================
app.get('/api/:_any/analytics/:pageId/visitors-by-date', async (req, res) => {
  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });

  const startKey = start_date.slice(0, 10);
  const endKey   = end_date.slice(0, 10);
  const match    = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
  if (url) match.pageUrl = url;

  try {
    const stats = await runDb(db =>
      db.collection(`visits_${MALL_ID}`).aggregate([
        { $match: match },
        { $group: { _id: { date: '$dateKey', visitorId: '$visitorId' }, viewCount: { $sum: { $ifNull: ['$viewCount', 0] } }, revisitCount: { $sum: { $ifNull: ['$revisitCount', 0] } } } },
        { $group: { _id: '$_id.date', totalVisitors: { $sum: 1 }, newVisitors: { $sum: { $cond: [{ $gt: ['$viewCount', 0] }, 1, 0] } }, returningVisitors: { $sum: { $cond: [{ $gt: ['$revisitCount', 0] }, 1, 0] } } } },
        { $project: { _id: 0, date: '$_id', totalVisitors: 1, newVisitors: 1, returningVisitors: 1,
          revisitRate: { $concat: [ { $toString: { $round: [ { $multiply: [ { $cond: [ { $gt: ['$totalVisitors', 0] }, { $divide: ['$returningVisitors', '$totalVisitors'] }, 0 ] }, 100 ] }, 0 ] } }, ' %' ] } } },
        { $sort: { date: 1 } }
      ]).toArray()
    );
    res.json(stats);
  } catch (err) {
    console.error('[VISITORS-BY-DATE ERROR]', err);
    res.status(500).json({ error: '집계 중 오류가 발생했습니다.' });
  }
});

app.get('/api/:_any/analytics/:pageId/clicks-by-date', async (req, res) => {
  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });

  const startKey = start_date.slice(0,10);
  const endKey   = end_date.slice(0,10);
  const match = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
  if (url) match.pageUrl = url;

  try {
    const data = await runDb(db =>
      db.collection(`clicks_${MALL_ID}`).aggregate([
        { $match: match },
        { $group: { _id: { date: '$dateKey', element: '$element' }, count: { $sum: 1 } } },
        { $group: { _id: '$_id.date',
          url:     { $sum: { $cond: [ { $eq: ['$_id.element','url'] }, '$count', 0 ] } },
          product: { $sum: { $cond: [ { $eq: ['$_id.element','product'] }, '$count', 0 ] } },
          coupon:  { $sum: { $cond: [ { $eq: ['$_id.element','coupon'] }, '$count', 0 ] } } } },
        { $project: { _id: 0, date: '$_id', 'URL 클릭':'$url', 'URL 클릭(기존 product)':'$product', '쿠폰 클릭':'$coupon' } },
        { $sort: { date: 1 } }
      ]).toArray()
    );
    res.json(data);
  } catch (err) {
    console.error('[CLICKS-BY-DATE ERROR]', err);
    res.status(500).json({ error: '클릭 집계에 실패했습니다.' });
  }
});

// (참고용 단일 카운트 엔드포인트 – 프론트에서 사용 안 하면 무시 가능)
app.get('/api/:_any/analytics/:pageId/url-clicks', async (req, res) => {
  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });

  const match = { pageId, type:'click', element:'url', timestamp: { $gte: new Date(start_date), $lte: new Date(end_date) } };
  if (url) match.pageUrl = url;

  try {
    const count = await runDb(db => db.collection(`clicks_${MALL_ID}`).countDocuments(match));
    res.json({ count });
  } catch (err) {
    console.error('[URL CLICKS COUNT ERROR]', err);
    res.status(500).json({ error: 'URL 클릭 수 조회 실패' });
  }
});

app.get('/api/:_any/analytics/:pageId/coupon-clicks', async (req, res) => {
  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });

  const match = { pageId, type:'click', element:'coupon', timestamp: { $gte: new Date(start_date), $lte: new Date(end_date) } };
  if (url) match.pageUrl = url;

  try {
    const count = await runDb(db => db.collection(`clicks_${MALL_ID}`).countDocuments(match));
    res.json({ count });
  } catch (err) {
    console.error('[COUPON CLICKS COUNT ERROR]', err);
    res.status(500).json({ error: '쿠폰 클릭 수 조회 실패' });
  }
});

app.get('/api/:_any/analytics/:pageId/urls', async (req, res) => {
  const { pageId } = req.params;
  try {
    const urls = await runDb(db => db.collection(`visits_${MALL_ID}`).distinct('pageUrl', { pageId }));
    res.json(urls);
  } catch (err) {
    console.error('[URLS DISTINCT ERROR]', err);
    res.status(500).json({ error: 'URL 목록 조회 실패' });
  }
});

app.get('/api/:_any/analytics/:pageId/coupons-distinct', async (req, res) => {
  const { pageId } = req.params;
  try {
    const couponNos = await runDb(db =>
      db.collection(`clicks_${MALL_ID}`).distinct('couponNo', { pageId, element: 'coupon' })
    );
    res.json(couponNos);
  } catch (err) {
    console.error('[COUPONS-DISTINCT ERROR]', err);
    res.status(500).json({ error: '쿠폰 목록 조회 실패' });
  }
});

app.get('/api/:_any/analytics/:pageId/devices', async (req, res) => {
  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });

  const startKey = start_date.slice(0,10), endKey = end_date.slice(0,10);
  const match = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
  if (url) match.pageUrl = url;

  try {
    const data = await runDb(db =>
      db.collection(`visits_${MALL_ID}`).aggregate([
        { $match: match },
        { $group: { _id: '$device', count: { $sum: { $add: [ { $ifNull: ['$viewCount',0] }, { $ifNull: ['$revisitCount',0] } ] } } } },
        { $project: { _id:0, device_type:'$_id', count:1 } }
      ]).toArray()
    );
    res.json(data);
  } catch (err) {
    console.error('[ANALYTICS DEVICES ERROR]', err);
    res.status(500).json({ error: '디바이스 분포 집계 실패' });
  }
});

app.get('/api/:_any/analytics/:pageId/devices-by-date', async (req, res) => {
  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });

  const startKey = start_date.slice(0,10), endKey = end_date.slice(0,10);
  const match = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
  if (url) match.pageUrl = url;

  try {
    const data = await runDb(db =>
      db.collection(`visits_${MALL_ID}`).aggregate([
        { $match: match },
        { $group: { _id: { date:'$dateKey', device:'$device', visitor:'$visitorId' } } },
        { $group: { _id: { date:'$_id.date', device:'$_id.device' }, count: { $sum:1 } } },
        { $project: { _id:0, date:'$_id.date', device:'$_id.device', count:1 } },
        { $sort: { date:1, device:1 } }
      ]).toArray()
    );
    res.json(data);
  } catch (err) {
    console.error('[ANALYTICS DEVICES-BY-DATE ERROR]', err);
    res.status(500).json({ error: '날짜별 고유 디바이스 집계 실패' });
  }
});

app.get('/api/:_any/analytics/:pageId/product-clicks', async (req, res) => {
  const { pageId } = req.params;
  const { start_date, end_date } = req.query;

  const filter = { pageId };
  if (start_date && end_date) filter.lastClickAt = { $gte: new Date(start_date), $lte: new Date(end_date) };

  try {
    const docs = await runDb(db =>
      db.collection(`prdClick_${MALL_ID}`).find(filter).sort({ clickCount: -1 }).toArray()
    );
    res.json(docs.map(d => ({ productNo: d.productNo, clicks: d.clickCount })));
  } catch (err) {
    console.error('[PRODUCT-CLICKS ERROR]', err);
    res.status(500).json({ error: '상품 클릭 랭킹 조회 실패' });
  }
});

app.get('/api/:_any/analytics/:pageId/product-performance', async (req, res) => {
  try {
    const clicks = await runDb(db =>
      db.collection(`prdClick_${MALL_ID}`).aggregate([
        { $match: { pageId: req.params.pageId } },
        { $group: { _id: '$productNo', clicks: { $sum: '$clickCount' } } }
      ]).toArray()
    );
    if (!clicks.length) return res.json([]);

    const productNos = clicks.map(c => c._id);
    const urlProds = `https://${MALL_ID}.cafe24api.com/api/v2/admin/products`;
    const prodRes = await apiRequest('GET', urlProds, {}, {
      shop_no: 1,
      product_no: productNos.join(','),
      limit: productNos.length,
      fields: 'product_no,product_name'
    });
    const detailMap = (prodRes.products || []).reduce((m,p) => { m[p.product_no]=p.product_name; return m; }, {});

    const performance = clicks
      .map(c => ({ productNo: c._id, productName: detailMap[c._id] || '이름없음', clicks: c.clicks }))
      .sort((a,b)=>b.clicks-a.clicks);

    res.json(performance);
  } catch (err) {
    console.error('[PRODUCT PERFORMANCE ERROR]', err);
    res.status(500).json({ error: '상품 퍼포먼스 집계 실패' });
  }//서버 데이터
});



// ========== [서버 실행 및 프롬프트 초기화] ==========
(async function initialize() {
  try {
    console.log("🟡 서버 시작 중...");

    // 토큰 불러오기
    await getTokensFromDB();
    await initializeEventData();
    // 2. [추가] DB 인덱스(중복 방지) 자동 설정
    await ensureIndexes(); 
    //실시간 판매 데이터 
    await initializeOfflineSalesData()
    startSalesScheduler();

    // 시스템 프롬프트 한 번만 초기화
    combinedSystemPrompt = await initializeChatPrompt();


    console.log("✅ 시스템 프롬프트 초기화 완료");

    // 서버 실행
    app.listen(PORT, () => {
      console.log(`🚀 서버 실행 완료! 포트: ${PORT}`);
    });

  } catch (err) {
    console.error("❌ 서버 초기화 오류:", err.message);
    process.exit(1);
  }
})();
