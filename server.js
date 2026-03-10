const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const compression = require("compression");
const axios = require("axios");
const { MongoClient, ObjectId } = require("mongodb");
const ExcelJS = require("exceljs");
const multer = require('multer');
const ftp = require('basic-ftp');
const dayjs = require('dayjs');
const pdfParse = require('pdf-extraction');

// .env 설정 로드
require("dotenv").config({ path: path.join(__dirname, ".env") });
const staticFaqList = require("./faq");

const {
  ACCESS_TOKEN, REFRESH_TOKEN, CAFE24_CLIENT_ID, CAFE24_CLIENT_SECRET,
  DB_NAME, MONGODB_URI, CAFE24_MALLID, OPEN_URL, API_KEY,
  FINETUNED_MODEL = "gpt-4o-mini", CAFE24_API_VERSION = "2025-12-01",
  PORT = 5000, FTP_PUBLIC_BASE, YOGIBO_FTP, YOGIBO_FTP_ID, YOGIBO_FTP_PW
} = process.env;

let accessToken = ACCESS_TOKEN;
let refreshToken = REFRESH_TOKEN;

const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ✅ 파일 업로드 설정 (Multer)
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
        filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`)
    }),
    limits: { fileSize: 50 * 1024 * 1024 }
});
if (!fs.existsSync(path.join(__dirname, 'uploads'))) fs.mkdirSync(path.join(__dirname, 'uploads'));

// ✅ 상품 데이터 (Cafe24 API로 동기화됨)
let yogiboProducts = [];

// ✅ 전역 변수
let pendingCoveringContext = false;
let allSearchableData = []; 

// ★ [시스템 프롬프트]
let currentSystemPrompt = `
1. 역할: 당신은 '요기보(Yogibo)'의 AI 상담원입니다.

2. ★ 중요 임무:
- 사용자 질문에 대해 아래 제공되는 [참고 정보]들을 꼼꼼히 읽고 답변을 작성하세요.
- [참고 정보]는 FAQ, 제품 매뉴얼, 회사 규정 등이 섞여 있습니다. 이 중에서 질문과 가장 관련 있는 내용을 찾아내세요.
- 답변은 반드시 [참고 정보]에서 근거가 확인되는 내용만 안내하세요.
- [참고 정보]에 동일한 문장이 없더라도, 여러 근거를 종합하면 논리적으로 답할 수 있는 경우에는
  "참고 정보 기준으로 종합하면" 형태로 설명하는 것은 허용합니다.
- 단, [참고 정보]에 없는 사실(전화번호/주소/정책/가격/기간/효과 등)을 새로 만들어내거나 추측하면 안 됩니다.
- 만약 (a) 관련 근거가 전혀 없거나, (b) 요기보와 무관한 내용(코딩/주식/날씨 등)이라면,
  절대 지어내지 말고 오직 "NO_CONTEXT"라고만 출력하세요.

3. 답변 스타일:
- 친절하고 전문적인 톤으로 답변하세요.
- 가능한 경우 (1) 핵심 답변 → (2) 근거 요약 → (3) 고객에게 확인할 질문 순서로 작성하세요.
- 링크는 [버튼명](URL) 형식으로, 이미지는 <img src="..."> 태그를 그대로 유지하세요.
`;

// ========== HTML 템플릿 ==========
const COUNSELOR_LINKS_HTML = `
<div class="consult-container">
  <p style="font-weight:bold; margin-bottom:8px; font-size:14px; color:#e74c3c;">
    <i class="fa-solid fa-triangle-exclamation"></i> 정확한 정보 확인이 필요합니다.
  </p>
  <p style="font-size:13px; color:#555; margin-bottom:15px; line-height:1.4;">
    죄송합니다. 현재 데이터베이스에서 정확한 답변을 찾지 못했습니다.<br>
    사람의 확인이 필요한 내용일 수 있으니, 아래 버튼을 눌러 <b>상담사</b>에게 문의해주세요.
  </p>
  <a href="javascript:void(0)" onclick="window.open('http://pf.kakao.com/_lxmZsxj/chat','kakao','width=500,height=600,scrollbars=yes');" class="consult-btn kakao">
     <i class="fa-solid fa-comment"></i> 카카오톡 상담원으로 연결
  </a>
  <a href="javascript:void(0)" onclick="window.open('https://talk.naver.com/ct/wc4u67?frm=psf','naver','width=500,height=600,scrollbars=yes');" class="consult-btn naver">
     <i class="fa-solid fa-comments"></i> 네이버 톡톡 상담원으로 연결
  </a>
</div>
`;

const FALLBACK_MESSAGE_HTML = `<div style="margin-top: 10px;">${COUNSELOR_LINKS_HTML}</div>`;
const LOGIN_BTN_HTML = `<div style="margin-top:15px;"><a href="/member/login.html" class="consult-btn" style="background:#58b5ca; color:#fff; justify-content:center;">로그인 하러 가기 →</a></div>`;

// JSON 데이터 로드
const companyDataPath = path.join(__dirname, "json", "companyData.json");
let companyData = {};
try { 
    if (fs.existsSync(companyDataPath)) {
        companyData = JSON.parse(fs.readFileSync(companyDataPath, "utf-8")); 
    }
} catch (e) { console.error("companyData load error:", e); }

// MongoDB 연결 및 토큰 관리
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

// Cafe24 API 공통
async function apiRequest(method, url, data = {}, params = {}) {
    try {
      const res = await axios({ method, url, data, params, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Cafe24-Api-Version': CAFE24_API_VERSION } });
      return res.data;
    } catch (error) {
      if (error.response?.status === 401) { await refreshAccessToken(); return apiRequest(method, url, data, params); }
      throw error;
    }
}

// ★ Cafe24 추천 상품 동기화 함수
async function fetchProductsFromCafe24() {
  try {
    console.log("🟡 Cafe24에서 추천 상품 데이터를 동기화하는 중...");
    const response = await apiRequest("GET", `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products`, {}, {
      display: "T", selling: "T", limit: 100 
    });

    if (response && response.products) {
      yogiboProducts = response.products.map(prod => {
        let category = "소파";
        if (prod.product_name.includes("서포트") || prod.product_name.includes("롤") || prod.product_name.includes("쿠션")) {
          category = "악세서리";
        }
        const rawDescription = prod.summary_description || prod.simple_description || "";
        const keywords = rawDescription.split(",").map(k => k.trim()).filter(k => k);

        return {
          id: prod.product_code || prod.product_no.toString(),
          name: prod.product_name,
          category: category,
          price: parseInt(prod.price || 0),
          features: keywords.length > 0 ? keywords : ["편안함", "빈백"],
          useCase: keywords.length > 0 ? keywords : ["휴식", "인테리어"],
          productUrl: `https://yogibo.kr/product/detail.html?product_no=${prod.product_no}`
        };
      });
      console.log(`✅ [상품 동기화 완료] Cafe24에서 총 ${yogiboProducts.length}개의 상품 캐싱 완료.`);
    }
  } catch (error) {
    console.error("❌ Cafe24 상품 데이터 동기화 실패:", error.message);
  }
}

// ★ [신규/수정] 422 에러 방지를 위한 3개월 단위 분할 매출 스케줄러
async function syncCafe24Orders() {
  console.log("🔄 [매출 스케줄러] Cafe24 온라인 매출 집계를 시작합니다...");
  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    const db = client.db(DB_NAME);

    // 로그에 남겨주신 2025-11-01 부터 오늘까지 조회합니다.
    let currentStart = dayjs('2025-11-01');
    const finalEnd = dayjs(); 
    let totalFetched = 0;

    // 현재 시작일이 최종 종료일보다 이전이거나 같을 때까지 반복
    while (currentStart.isBefore(finalEnd) || currentStart.isSame(finalEnd, 'day')) {
      
      // 시작일로부터 2개월 뒤 말일까지만 끊어서 조회 (안전하게 90일 제한 회피)
      let currentEnd = currentStart.add(2, 'month').endOf('month'); 
      if (currentEnd.isAfter(finalEnd)) {
        currentEnd = finalEnd;
      }

      const params = {
        shop_no: 1,
        order_status: 'N40', 
        start_date: currentStart.format('YYYY-MM-DD'),
        end_date: currentEnd.format('YYYY-MM-DD'),
        limit: 100,
        offset: 0
      };

      console.log(`📡 [매출 스케줄러] 데이터 요청 구간: ${params.start_date} ~ ${params.end_date}`);

      const response = await apiRequest("GET", `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`, {}, params);
      
      if (response && response.orders && response.orders.length > 0) {
        totalFetched += response.orders.length;
        
        // MongoDB에 업데이트 (upsert로 중복 주문 덮어쓰기)
        for (const order of response.orders) {
            await db.collection("cafe24Orders").updateOne(
                { order_id: order.order_id },
                { $set: { ...order, updatedAt: new Date() } },
                { upsert: true }
            );
        }
      }
      // 다음 턴의 시작일은 현재 종료일의 다음 날
      currentStart = currentEnd.add(1, 'day');
    }
    
    console.log(`✅ [매출 스케줄러] 총 ${totalFetched}건의 주문 데이터를 성공적으로 동기화했습니다.`);
  } catch (error) {
    // 422 등 상세 에러 메시지 출력
    console.error("❌ [매출 스케줄러] 오류 발생:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
  } finally {
    await client.close();
  }
}

// ★ 모든 데이터를 '검색 가능한 형태'로 통합하는 함수 (RAG)
async function updateSearchableData() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    
    const notes = await db.collection("postItNotes").find({}).toArray();
    const dbData = notes.map(n => ({ 
        source: "DB", category: n.category || "general", q: n.question, a: n.answer 
    }));

    const faqData = staticFaqList.map(f => ({
        source: "FAQ", category: "faq", q: f.q, a: f.a
    }));

    let jsonData = [];
    if (companyData.covering) {
        Object.keys(companyData.covering).forEach(key => {
            jsonData.push({ source: "JSON", category: "covering", q: key, a: companyData.covering[key].answer });
        });
    }
    if (companyData.sizeInfo) {
        Object.keys(companyData.sizeInfo).forEach(key => {
            jsonData.push({ source: "JSON", category: "size", q: key, a: companyData.sizeInfo[key].description });
        });
    }

    allSearchableData = [...faqData, ...dbData, ...jsonData];
    
    const prompts = await db.collection("systemPrompts").find({}).sort({createdAt: -1}).limit(1).toArray();
    if (prompts.length > 0) currentSystemPrompt = prompts[0].content; 
    
    console.log(`✅ [데이터 로드 완료] 총 ${allSearchableData.length}개의 지식 데이터가 준비되었습니다.`);
  } catch (err) { console.error("데이터 갱신 실패:", err); } finally { await client.close(); }
}

function findAllRelevantContent(msg) {
  const kws = msg.split(/\s+/).filter(w => w.length > 1);
  if (!kws.length && msg.length < 2) return [];

  const scored = allSearchableData.map(item => {
    let score = 0;
    const q = (item.q || "").toLowerCase().replace(/\s+/g, "");
    const a = (item.a || "").toLowerCase();
    const cleanMsg = msg.toLowerCase().replace(/\s+/g, "");
    
    if (q === cleanMsg) score += 100;
    else if (q.includes(cleanMsg) || cleanMsg.includes(q)) score += 50;
    
    kws.forEach(w => {
      const cleanW = w.toLowerCase();
      if (item.q.toLowerCase().includes(cleanW)) score += 20;
      if (item.a.toLowerCase().includes(cleanW)) score += 5;
    });

    return { ...item, score };
  });

   return scored.filter(i => i.score >= 12).sort((a, b) => b.score - a.score).slice(0, 6);
}

async function getLLMResponse(input, context = []) {
  const txt = context.map(i => `Q: ${i.q}\nA: ${i.a}`).join("\n\n");
  const system = `${currentSystemPrompt}

[운영 규칙 - 매우 중요]
- 답변은 반드시 아래 [참고 정보]에서 근거가 확인되는 내용만 안내하세요.
- [참고 정보]에 없는 내용은 절대 추측하지 말고, "정확한 확인이 필요합니다"라고 말하세요.
- 고객에게 추가 확인이 필요한 정보(주문번호/구매처/제품명 등)가 있으면 먼저 요청하세요.

[참고 정보]
${txt || "정보 없음."}`;

  try {
    const res = await axios.post(
      OPEN_URL,
      {
        model: FINETUNED_MODEL,
        temperature: 0.2,
        top_p: 0.9,
        messages: [
          { role: "system", content: system },
          { role: "user", content: input }
        ]
      },
      { headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" } }
    );
    return res.data.choices?.[0]?.message?.content || "답변을 생성하지 못했습니다.";
  } catch (e) {
    return "답변 생성 중 문제가 발생했습니다.";
  }
}

// 유틸 함수들
function formatResponseText(text) { return text || ""; }
function normalizeSentence(s) { return s.replace(/[?!！？]/g, "").replace(/없나요/g, "없어요").trim(); }
function containsOrderNumber(s) { return /\d{8}-\d{7}/.test(s); }
function isUserLoggedIn(id) { return id && id !== "null" && id !== "undefined" && String(id).trim() !== ""; }

// 배송 조회 API
async function getOrderShippingInfo(id) {
  const today = new Date(); const start = new Date(); start.setDate(today.getDate() - 14);
  return apiRequest("GET", `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`, {}, {
    member_id: id, start_date: start.toISOString().split('T')[0], end_date: today.toISOString().split('T')[0], limit: 10
  });
}
async function getShipmentDetail(orderId) {
  const API_URL = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders/${orderId}/shipments`;
  try {
    const response = await apiRequest("GET", API_URL, {}, { shop_no: 1 });
    if (response.shipments && response.shipments.length > 0) {
      const shipment = response.shipments[0];
      const carrierMap = { "0019": { name: "롯데 택배" }, "0039": { name: "경동 택배" }, "0023": { name: "경동 택배" } };
      const carrierInfo = carrierMap[shipment.shipping_company_code] || { name: shipment.shipping_company_name || "지정 택배사" };
      shipment.shipping_company_name = carrierInfo.name;
      return shipment;
    } return null;
  } catch (error) { throw error; }
}

// 회원 구매 이력 조회 (최근 2개월)
async function getMemberPurchaseHistory(memberId) {
    if (!memberId || memberId === "null") return null;
    try {
        const today = new Date();
        const twoMonthsAgo = new Date();
        twoMonthsAgo.setMonth(today.getMonth() - 2); 

        const response = await apiRequest("GET", `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`, {}, {
            member_id: memberId, start_date: twoMonthsAgo.toISOString().split('T')[0], end_date: today.toISOString().split('T')[0], limit: 20, embed: "items" 
        });

        if (!response.orders) return null;

        const history = { categories: [], products: [], colors: [] };
        response.orders.forEach(order => {
            order.items.forEach(item => {
                history.products.push(item.product_name);
                if (item.product_name.includes("맥스") || item.product_name.includes("미디") || item.product_name.includes("빈백")) history.categories.push("sofa");
                if (item.product_name.includes("서포트") || item.product_name.includes("롤")) history.categories.push("accessory");
                if (item.option_value) history.colors.push(item.option_value); 
            });
        });
        return history;
    } catch (e) {
        console.error("구매이력 조회 실패:", e.message); return null;
    }
}

// AI 상품 추천 엔진
async function recommendProducts(userMsg, memberId) {
    const keywords = userMsg.toLowerCase();
    const purchaseHistory = await getMemberPurchaseHistory(memberId);
    
    const scored = yogiboProducts.map(p => {
        let score = 0;
        let reasons = [];

        if (keywords.includes("게임") && p.useCase.includes("게임")) { score += 30; reasons.push("🎮 게임할 때 편해요"); }
        if (keywords.includes("잠") && p.useCase.includes("수면")) { score += 30; reasons.push("😴 꿀잠 보장"); }
        if (keywords.includes("원룸") && p.features.includes("원룸")) { score += 30; reasons.push("🏠 좁은 공간 활용 굿"); }
        if (keywords.includes("가족") && p.features.includes("2인용")) { score += 30; reasons.push("👨‍👩‍👧 가족과 함께"); }

        if (purchaseHistory) {
            const boughtSofa = purchaseHistory.categories.includes("sofa");
            const boughtAccessory = purchaseHistory.categories.includes("accessory");

            if (boughtSofa && !boughtAccessory && p.category === "악세서리") {
                score += 50; reasons.push("✨ 구매하신 빈백과 함께 쓰면 편안함이 2배!");
            }
            if (!boughtSofa && boughtAccessory && p.category === "소파") {
                score += 40; reasons.push("✨ 가지고 계신 쿠션과 잘 어울리는 소파예요");
            }
        }

        if (p.name.includes("맥스") || p.name.includes("서포트")) score += 10;
        return { ...p, score, reasons };
    });

    const top3 = scored.sort((a, b) => b.score - a.score).slice(0, 3);
    
    if(top3.length === 0) return "원하시는 조건에 맞는 상품을 찾지 못했어요. 조금 더 구체적으로 말씀해주시겠어요?";

    const prompt = `
    당신은 요기보 세일즈 매니저입니다.
    고객 질문: "${userMsg}"
    구매 이력: ${purchaseHistory ? JSON.stringify(purchaseHistory.products) : "없음"}
    추천 상품 목록:
    ${top3.map(p => `- ${p.name} (${p.price}원): ${p.reasons.join(", ")}`).join("\n")}
    
    위 정보를 바탕으로 고객에게 자연스럽게 상품을 추천하는 멘트를 작성해주세요.
    구매 이력이 있다면 "지난번 구매하신 OO과 함께 쓰시면 좋아요" 같은 멘트를 꼭 넣어주세요.
    `;

    try {
      const gptRes = await axios.post(OPEN_URL, {
        model: FINETUNED_MODEL,
        temperature: 0.5,
        messages: [
          { role: "system", content: "당신은 요기보 상담원입니다. 근거 없는 단정/과장 표현은 피하고, 제공된 정보 범위에서만 추천 멘트를 작성하세요." },
          { role: "user", content: prompt }
        ]
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });
      
        let answer = gptRes.data.choices[0].message.content;
        const buttons = top3.map(p => `<a href="${p.productUrl}" 
          target="_blank" class="consult-btn" style="background:#58b5ca; color:#fff; display:inline-block; margin:5px; text-decoration:none;">🛍️ ${p.name} 보러가기</a>`).join("");
        return answer + "<br><br>" + buttons;
    } catch (e) { return "추천 상품을 불러오는 중 오류가 발생했습니다."; }
}

const COUNSELOR_BUTTONS_ONLY_HTML = `
<div class="consult-container">
    <p style="font-weight:bold; margin-bottom:8px; font-size:14px; color:#e74c3c;">
    <i class="fa-solid fa-triangle-exclamation"></i> 상담사 연결을 진행하겠습니다.
  </p>
  <a href="javascript:void(0)" onclick="window.open('http://pf.kakao.com/_lxmZsxj/chat','kakao','width=500,height=600,scrollbars=yes');" class="consult-btn kakao">
     <i class="fa-solid fa-comment"></i> 카카오톡 상담원으로 연결
  </a>
  <a href="javascript:void(0)" onclick="window.open('https://talk.naver.com/ct/wc4u67?frm=psf','naver','width=500,height=600,scrollbars=yes');" class="consult-btn naver">
     <i class="fa-solid fa-comments"></i> 네이버 톡톡 상담원으로 연결
  </a>
</div>
`;

const counselorTriggers = ["상담사", "상담원", "상담사 연결", "상담원 연결", "사람 상담", "직원 연결", "카톡 상담", "카카오 상담", "네이버 상담", "톡톡 상담"];

async function findAnswer(userInput, memberId) {
  const normalized = normalizeSentence(userInput);

  if (counselorTriggers.some(t => normalized.includes(t))) return { text: COUNSELOR_BUTTONS_ONLY_HTML };

  const recommendKeywords = ["추천", "뭐가 좋", "어떤게 좋", "골라", "선택", "뭐 사"];
  if (recommendKeywords.some(k => normalized.includes(k))) {
    const recommendResult = await recommendProducts(userInput, memberId);
    return { text: recommendResult };
  }

  if (containsOrderNumber(normalized)) {
    if (isUserLoggedIn(memberId)) {
      try {
        const orderId = normalized.match(/\d{8}-\d{7}/)[0];
        const ship = await getShipmentDetail(orderId);
        if (ship) return { text: `주문번호 <strong>${orderId}</strong>의 배송 상태는 <strong>${ship.status || "배송 준비중"}</strong>입니다.` };
        return { text: "해당 주문번호의 정보를 찾을 수 없습니다." };
      } catch (e) { return { text: "조회 중 오류가 발생했습니다." }; }
    }
    return { text: `조회를 위해 로그인이 필요합니다.${LOGIN_BTN_HTML}` };
  }

  const isTracking = (normalized.includes("배송") || normalized.includes("주문")) && (normalized.includes("조회") || normalized.includes("확인") || normalized.includes("언제") || normalized.includes("어디"));
  if (isTracking) {
    if (isUserLoggedIn(memberId)) {
      try {
        const data = await getOrderShippingInfo(memberId);
        if (data.orders?.[0]) return { text: `최근 주문(<strong>${data.orders[0].order_id}</strong>)을 확인했습니다.` };
        return { text: "최근 주문 내역이 없습니다." };
      } catch (e) { return { text: "조회 실패." }; }
    }
    return { text: `배송정보 확인을 위해 로그인이 필요합니다.${LOGIN_BTN_HTML}` };
  }
  return null;
}

async function saveConversationLog(mid, uMsg, bRes) {
    const client = new MongoClient(MONGODB_URI);
    try { 
        await client.connect(); 
        await client.db(DB_NAME).collection("conversationLogs").updateOne(
            { memberId: mid || null, date: new Date().toISOString().split("T")[0] }, 
            { $push: { conversation: { userMessage: uMsg, botResponse: bRes, createdAt: new Date() } } }, 
            { upsert: true }
        ); 
    } catch(e) { console.error(e); } finally { await client.close(); }
}

app.post("/chat", async (req, res) => {
  const { message, memberId } = req.body;
  if (!message) return res.status(400).json({ error: "No message" });

  try {
    const ruleAnswer = await findAnswer(message, memberId);
    if (ruleAnswer) {
      await saveConversationLog(memberId, message, ruleAnswer.text);
      return res.json(ruleAnswer);
    }

    const docs = findAllRelevantContent(message);
    const bestScore = docs.length > 0 ? docs[0].score : 0;

    if (!docs || docs.length === 0 || bestScore < 12) {
      const fallback = `정확한 정보 확인이 필요합니다.${FALLBACK_MESSAGE_HTML}`;
      await saveConversationLog(memberId, message, fallback);
      return res.json({ text: fallback });
    }

    let gptAnswer = await getLLMResponse(message, docs); 
    gptAnswer = formatResponseText(gptAnswer);

    if (gptAnswer.includes("NO_CONTEXT")) {
      const fallback = `정확한 정보 확인이 필요합니다.${FALLBACK_MESSAGE_HTML}`;
      await saveConversationLog(memberId, message, fallback);
      return res.json({ text: fallback });
    }

    await saveConversationLog(memberId, message, gptAnswer);
    return res.json({ text: gptAnswer });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ text: "오류가 발생했습니다." });
  }
});

// 파일 및 데이터 관리 API들
app.post("/chat_send", upload.single('file'), async (req, res) => {
    const { role, content } = req.body;
    const client = new MongoClient(MONGODB_URI);
    try {
        await client.connect(); const db = client.db(DB_NAME);
        if (req.file) {
            req.file.originalname = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
            if (req.file.mimetype === 'application/pdf') {
                const dataBuffer = fs.readFileSync(req.file.path); 
                const data = await pdfParse(dataBuffer);
                const cleanText = data.text.replace(/\n\n+/g, '\n').replace(/\s+/g, ' ').trim();
                const chunks = []; 
                for (let i = 0; i < cleanText.length; i += 500) chunks.push(cleanText.substring(i, i + 500));
                const docs = chunks.map((chunk, index) => ({ category: "pdf-knowledge", question: `[PDF 학습데이터] ${req.file.originalname} (Part ${index + 1})`, answer: chunk, createdAt: new Date() }));
                if (docs.length > 0) await db.collection("postItNotes").insertMany(docs);
                fs.unlink(req.file.path, () => {}); 
                await updateSearchableData(); 
                return res.json({ message: `PDF 분석 완료! 총 ${docs.length}개의 데이터로 학습되었습니다.` });
            }
        }
        if (role && content) {
            const fullPrompt = `역할: ${role}\n지시사항: ${content}`;
            await db.collection("systemPrompts").insertOne({ role, content: fullPrompt, createdAt: new Date() });
            currentSystemPrompt = fullPrompt;
            return res.json({ message: "LLM 역할 설정이 완료되었습니다." });
        }
        res.status(400).json({ error: "파일이나 내용이 없습니다." });
    } catch (e) { if (req.file) fs.unlink(req.file.path, () => {}); res.status(500).json({ error: e.message }); } finally { await client.close(); }
});

app.post("/upload_knowledge_image", upload.single('image'), async (req, res) => {
    const { keyword } = req.body;
    const client = new MongoClient(MONGODB_URI);
    const ftpClient = new ftp.Client();
    if (!req.file || !keyword) return res.status(400).json({ error: "필수 정보 누락" });
    
    req.file.originalname = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    try {
        const cleanFtpHost = YOGIBO_FTP.replace(/^(http:\/\/|https:\/\/|ftp:\/\/)/, '').replace(/\/$/, '');
        await ftpClient.access({ host: cleanFtpHost, user: YOGIBO_FTP_ID, password: YOGIBO_FTP_PW, secure: false });
        try { await ftpClient.ensureDir("web"); await ftpClient.ensureDir("chat"); } catch (dirErr) { await ftpClient.cd("/"); await ftpClient.ensureDir("www"); await ftpClient.ensureDir("chat"); }
        const safeFilename = `${Date.now()}_${Math.floor(Math.random()*1000)}.jpg`;
        await ftpClient.uploadFrom(req.file.path, safeFilename);
        const remotePath = "web/chat"; const publicBase = FTP_PUBLIC_BASE || `http://${cleanFtpHost}`;
        const imageUrl = `${publicBase}/${remotePath}/${safeFilename}`.replace(/([^:]\/)\/+/g, '$1');
        await client.connect(); await client.db(DB_NAME).collection("postItNotes").insertOne({ category: "image-knowledge", question: keyword, answer: `<img src="${imageUrl}" style="max-width:100%; border-radius:10px; margin-top:10px;">`, createdAt: new Date() });
        fs.unlink(req.file.path, () => {}); ftpClient.close(); await updateSearchableData();
        res.json({ message: "이미지 지식 등록 완료" });
    } catch (e) { if (req.file) fs.unlink(req.file.path, () => {}); ftpClient.close(); res.status(500).json({ error: e.message }); } finally { await client.close(); }
});

app.put("/postIt/:id", upload.single('image'), async (req, res) => {
    const { id } = req.params; const { question, answer } = req.body; const file = req.file;
    const client = new MongoClient(MONGODB_URI); const ftpClient = new ftp.Client();
    try {
        await client.connect(); const db = client.db(DB_NAME); let newAnswer = answer;
        if (file) {
            file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
            const safeFilename = `${Date.now()}_edit.jpg`;
            const cleanFtpHost = YOGIBO_FTP.replace(/^(http:\/\/|https:\/\/|ftp:\/\/)/, '').replace(/\/$/, '');
            await ftpClient.access({ host: cleanFtpHost, user: YOGIBO_FTP_ID, password: YOGIBO_FTP_PW, secure: false });
            try { await ftpClient.ensureDir("web"); await ftpClient.ensureDir("chat"); } catch (dirErr) { await ftpClient.cd("/"); await ftpClient.ensureDir("www"); await ftpClient.ensureDir("chat"); }
            await ftpClient.uploadFrom(file.path, safeFilename);
            const remotePath = "web/chat"; const publicBase = FTP_PUBLIC_BASE || `http://${cleanFtpHost}`;
            const imageUrl = `${publicBase}/${remotePath}/${safeFilename}`.replace(/([^:]\/)\/+/g, '$1');
            newAnswer = `<img src="${imageUrl}" style="max-width:100%; border-radius:10px; margin-top:10px;">`;
            fs.unlink(file.path, () => {}); ftpClient.close();
        }
        await db.collection("postItNotes").updateOne({ _id: new ObjectId(id) }, { $set: { question, answer: newAnswer, updatedAt: new Date() } });
        await updateSearchableData(); res.json({ message: "수정 완료" });
    } catch (e) { if (file) fs.unlink(file.path, () => {}); ftpClient.close(); res.status(500).json({ error: e.message }); } finally { await client.close(); }
});

app.delete("/postIt/:id", async(req, res) => { 
    const { id } = req.params; const client = new MongoClient(MONGODB_URI); const ftpClient = new ftp.Client();
    try {
        await client.connect(); const db = client.db(DB_NAME);
        const targetPost = await db.collection("postItNotes").findOne({ _id: new ObjectId(id) });
        if (targetPost) {
            const imgMatch = targetPost.answer && targetPost.answer.match(/src="([^"]+)"/);
            if (imgMatch) {
                const fullUrl = imgMatch[1]; const filename = fullUrl.split('/').pop();
                if (filename) {
                    try {
                        const cleanFtpHost = YOGIBO_FTP.replace(/^(http:\/\/|https:\/\/|ftp:\/\/)/, '').replace(/\/$/, '');
                        await ftpClient.access({ host: cleanFtpHost, user: YOGIBO_FTP_ID, password: YOGIBO_FTP_PW, secure: false });
                        await ftpClient.remove(`web/chat/${filename}`).catch(async () => { await ftpClient.remove(`www/chat/${filename}`).catch(() => {}); });
                        ftpClient.close();
                    } catch (ftpErr) { ftpClient.close(); }
                }
            }
        }
        await db.collection("postItNotes").deleteOne({ _id: new ObjectId(id) }); 
        await updateSearchableData(); res.json({ message: "OK" });
    } catch(e) { res.status(500).json({ error: e.message }); } finally { await client.close(); }
});

app.get("/postIt", async (req, res) => {
    const p = parseInt(req.query.page)||1; const l=300;
    try { const c=new MongoClient(MONGODB_URI); await c.connect(); const f = req.query.category?{category:req.query.category}:{}; const n = await c.db(DB_NAME).collection("postItNotes").find(f).sort({_id:-1}).skip((p-1)*l).limit(l).toArray(); await c.close(); res.json({notes:n, currentPage:p}); } catch(e){res.status(500).json({error:e.message})}
});

app.post("/postIt", async(req,res)=>{ try{const c=new MongoClient(MONGODB_URI);await c.connect(); await c.db(DB_NAME).collection("postItNotes").insertOne({...req.body,createdAt:new Date()}); await c.close(); await updateSearchableData(); res.json({message:"OK"})}catch(e){res.status(500).json({error:e.message})} });

app.get('/chatConnet', async(req,res)=>{ try{const c=new MongoClient(MONGODB_URI);await c.connect();const d=await c.db(DB_NAME).collection("conversationLogs").find({}).toArray();await c.close(); const wb=new ExcelJS.Workbook();const ws=wb.addWorksheet('Log');ws.columns=[{header:'ID',key:'m'},{header:'Date',key:'d'},{header:'Log',key:'c'}]; d.forEach(r=>ws.addRow({m:r.memberId||'Guest',d:r.date,c:JSON.stringify(r.conversation)})); res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");res.setHeader("Content-Disposition","attachment; filename=log.xlsx"); await wb.xlsx.write(res);res.end();}catch(e){res.status(500).send("Err")} });

// ★ 서버 실행 로직
(async function initialize() {
  try { 
      console.log("🟡 서버 시작..."); 
      
      // 1. DB에서 토큰부터 불러옵니다.
      await getTokensFromDB(); 
      
      // 2. 검색에 사용할 데이터와 추천 상품을 미리 로드합니다.
      await fetchProductsFromCafe24();
      await updateSearchableData(); 

      // 3. 앱 실행
      app.listen(PORT, () => console.log(`🚀 실행 완료: ${PORT}`)); 

      // ★ [신규 추가] 10분마다 분할 조회 스케줄러 실행
      // 바로 한 번 실행하고 싶다면 syncCafe24Orders(); 주석을 풀어주세요.
      syncCafe24Orders(); 
      setInterval(syncCafe24Orders, 10 * 60 * 1000); 

  } catch (err) { 
      console.error("❌ 초기화 오류:", err.message); 
      process.exit(1); 
  }
})();