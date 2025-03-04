// server.js
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const compression = require("compression");
const axios = require("axios");
const { MongoClient } = require("mongodb");
const levenshtein = require("fast-levenshtein");
require("dotenv").config();

// .env 변수 사용
let accessToken = process.env.ACCESS_TOKEN || 'pPhbiZ29IZ9kuJmZ3jr15C';
let refreshToken = process.env.REFRESH_TOKEN || 'CMLScZx0Bh3sIxlFTHDeMD';
const CAFE24_CLIENT_ID = process.env.CAFE24_CLIENT_ID;
const CAFE24_CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET;
const DB_NAME = process.env.DB_NAME;
const MONGODB_URI = process.env.MONGODB_URI;
const CAFE24_MALLID = process.env.CAFE24_MALLID;
const OPEN_URL = process.env.OPEN_URL; // OpenAI API URL

// Cafe24 API 버전 (환경변수나 기본값 사용)
const CAFE24_API_VERSION = process.env.CAFE24_API_VERSION || '2024-06-01';

// Express 앱 초기화
const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// 예제용 JSON 데이터 (필요 시)
const companyData = JSON.parse(fs.readFileSync("./json/companyData.json", "utf-8"));
// 컬렉션명을 "tokens"로 사용
const tokenCollectionName = "tokens";

/**
 * 주문번호 패턴 검사 함수 (예: "20240920-0000167")
 */
function containsOrderNumber(input) {
  return /\d{8}-\d{7}/.test(input);
}

// MongoDB에서 토큰을 불러오는 함수 (전체 문서를 가져옴)
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
      console.log('MongoDB에서 토큰 로드 성공:', tokensDoc);
    } else {
      console.log('MongoDB에 저장된 토큰이 없습니다. 초기 토큰을 저장합니다.');
      await saveTokensToDB(accessToken, refreshToken);
    }
  } catch (error) {
    console.error('토큰 로드 중 오류:', error);
  } finally {
    await client.close();
  }
}

// MongoDB에 토큰을 저장하는 함수
async function saveTokensToDB(newAccessToken, newRefreshToken) {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(tokenCollectionName);
    await collection.updateOne(
      {},
      {
        $set: {
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
    console.log('MongoDB에 토큰 저장 완료');
  } catch (error) {
    console.error('토큰 저장 중 오류:', error);
  } finally {
    await client.close();
  }
}

/**
 * Access Token 갱신 함수 (MongoDB에서 토큰 정보 갱신)
 * 401 에러 발생 시 MongoDB에서 최신 토큰을 가져옵니다.
 */
async function refreshAccessToken() {
  console.log('401 에러 발생: MongoDB에서 토큰 정보 가져오는 중...');
  await getTokensFromDB();
  console.log('MongoDB에서 토큰 갱신 완료:', accessToken, refreshToken);
  return accessToken;
}

/**
 * API 요청 함수 (자동 토큰 갱신 포함)
 */
async function apiRequest(method, url, data = {}, params = {}) {
  console.log(`Request: ${method} ${url}`);
  console.log("Params:", params);
  console.log("Data:", data);
  try {
    const response = await axios({
      method,
      url,
      data,
      params,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Cafe24-Api-Version': CAFE24_API_VERSION
      },
    });
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 401) {
      console.log('Access Token 만료. 갱신 중...');
      await refreshAccessToken();
      return apiRequest(method, url, data, params);
    } else {
      console.error('API 요청 오류:', error.response ? error.response.data : error.message);
      throw error;
    }
  }
}

/**
 * Cafe24 주문 배송 정보 조회 함수 (전체 주문 목록 조회)
 * 지정된 기간(2024-08-31 ~ 2024-09-31) 내의 주문 정보를 가져옵니다.
 */
async function getOrderShippingInfo(memberId) {
  const API_URL = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`;
  const params = {
    member_id: memberId,
    start_date: '2024-08-31',
    end_date: '2024-09-31',
    limit: 10,
  };
  try {
    const response = await apiRequest("GET", API_URL, {}, params);
    return response; // 응답 내 orders 배열 포함
  } catch (error) {
    console.error("Error fetching order shipping info:", error.message);
    throw error;
  }
}

/**
 * 주문번호에 대한 배송 상세 정보 조회 함수
 * GET https://{mallid}.cafe24api.com/api/v2/admin/orders/{order_id}/shipments
 * 해당 URL을 호출하면 shipments 배열이 반환되며, 첫 번째 항목의 정보를 사용합니다.
 */
async function getShipmentDetail(orderId) {
  const API_URL = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders/${orderId}/shipments`;
  const params = { shop_no: 1 };
  try {
    const response = await apiRequest("GET", API_URL, {}, params);
    if (response.shipments && response.shipments.length > 0) {
      const shipment = response.shipments[0];
      
      // shipping_company_code가 "0019"이면 "롯데 택배"로 매핑
      if (shipment.shipping_company_code === "0019") {
        shipment.shipping_company_name = "롯데 택배";
      } else {
        // 다른 코드 처리 (예: DB나 매핑 테이블을 사용하거나, 기본적으로 코드만 표시)
        shipment.shipping_company_name = shipment.shipping_company_code || "정보 없음";
      }
      return shipment;
    } else {
      throw new Error("배송 정보를 찾을 수 없습니다.");
    }
  } catch (error) {
    console.error("Error fetching shipment detail:", error.message);
    throw error;
  }
}

/**
 * 유틸 함수들
 */
function normalizeSentence(sentence) {
  return sentence
    .replace(/[?!！？]/g, "")
    .replace(/없나요/g, "없어요")
    .trim();
}
//일반 교육 JSON코드 읽어오는 코드

function getAdditionalBizComment() {
  const comments = [
    "추가로 궁금하신 사항이 있으시면 언제든 말씀해주세요.",
    "이 정보가 도움이 되길 바랍니다.",
    "더 자세한 정보가 필요하시면 문의해 주세요.",
    "고객님의 선택에 도움이 되었으면 좋겠습니다."
  ];
  return comments[Math.floor(Math.random() * comments.length)];
}

function summarizeHistory(text, maxLength = 300) {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + "...";
}

// ============ 메인 로직: findAnswer ============
async function findAnswer(userInput) {
  const normalizedUserInput = normalizeSentence(userInput);

  // =========================
  // [A] 커버링 컨텍스트 확인
  // =========================
  if (pendingCoveringContext) {
    const coveringTypes = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
    if (coveringTypes.includes(normalizedUserInput)) {
      const key = `${normalizedUserInput} 커버링 방법을 알고 싶어`;
      if (companyData.covering && companyData.covering[key]) {
        const videoUrl = companyData.covering[key].videoUrl;
        pendingCoveringContext = false; // 사용 후 해제
        return {
          text: companyData.covering[key].answer,
          videoHtml: videoUrl
            ? `<iframe width="100%" height="auto" src="${videoUrl}" frameborder="0" allowfullscreen style="margin-top:20px;"></iframe>`
            : null,
          description: null,
          imageUrl: null
        };
      }
      pendingCoveringContext = false;
    }
  }

  // =========================
  // [B] 세탁(washing) 
  // =========================
  if (pendingWashingContext) {
    // 세탁 종류(키워드) 매핑
    const washingMap = {
      "요기보": "요기보 세탁방법을 알고 싶어요",
      "줄라": "줄라 세탁방법을 알고 싶어요",
      "럭스": "럭스 세탁방법을 알고 싶어요",
      "모듀": "모듀 세탁방법을 알고 싶어요"
    };
    // 사용자 입력에 위 키워드가 있는지 확인
    for (let key in washingMap) {
      if (normalizedUserInput.includes(key)) {
        const dataKey = washingMap[key];
        if (companyData.washing && companyData.washing[dataKey]) {
          pendingWashingContext = false; // 해제
          return {
            text: companyData.washing[dataKey].description,
            videoHtml: null,
            description: null,
            imageUrl: null
          };
        }
      }
    }
    // 못 찾은 경우
    pendingWashingContext = false;
    return {
      text: "해당 커버 종류를 찾지 못했어요. (요기보, 줄라, 럭스, 모듀, 메이트 중 하나를 입력해주세요.)",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }

  // =========================
  // [C] 세탁방법 입력 감지
  // =========================
  if (
    normalizedUserInput.includes("세탁방법") ||
    (normalizedUserInput.includes("세탁") && normalizedUserInput.includes("방법"))
  ) {
    // 세탁 컨텍스트 활성화
    pendingWashingContext = true;
    return {
      text: "어떤 커버(제품) 세탁 방법이 궁금하신가요? (요기보, 줄라, 럭스, 모듀, 메이트 중 택1)",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }

  // =========================
  // Step 1: 사이즈 관련
  // =========================
  if (
    normalizedUserInput.includes("소파 사이즈") ||
    normalizedUserInput.includes("빈백 사이즈") ||
    normalizedUserInput.includes("상품 사이즈")
  ) {
    return {
      text: "어떤 빈백 사이즈가 궁금하신가요? 예를 들어, 맥스, 더블, 프라임, 피라미드 등 상품명을 입력해주세요.",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }
  const sizeTypes = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
  for (let sizeType of sizeTypes) {
    // "커버링"이 포함되면 사이즈 로직 건너뛰기
    if (normalizedUserInput.includes(sizeType) && !normalizedUserInput.includes("커버링")) {
      const key = sizeType + " 사이즈 또는 크기.";
      if (companyData.sizeInfo && companyData.sizeInfo[key]) {
        return {
          text: companyData.sizeInfo[key].description,
          videoHtml: null,
          description: companyData.sizeInfo[key].description,
          imageUrl: companyData.sizeInfo[key].imageUrl
        };
      }
    }
  }

  // =========================
  // Step 2: 제품 커버 관련 조건 (교체/사용 관련)
  // =========================
  if (
    normalizedUserInput.includes("커버") &&
    normalizedUserInput.includes("교체") &&
    (normalizedUserInput.includes("사용") || normalizedUserInput.includes("교체해서 사용"))
  ) {
    return {
      text: "해당 제품 전용 커버라면 모두 사용 가능해요. 요기보, 럭스, 믹스, 줄라 등 다양한 커버를 사용해보세요. 예를 들어, 맥스 제품을 사용 중이시라면 요기보 맥스 커버, 럭스 맥스 커버, 믹스 맥스 커버, 줄라 맥스 커버로 교체하여 사용 가능합니다.",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }

  // =========================
  // Step 3: 커버링 관련 조건 (확장)
  // =========================
  const coveringTypes2 = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
  if (
    coveringTypes2.some(type => normalizedUserInput.includes(type)) &&
    normalizedUserInput.includes("커버링")
  ) {
    const foundType = coveringTypes2.find(type => normalizedUserInput.includes(type));
    const key = `${foundType} 커버링 방법을 알고 싶어`;
    if (companyData.covering && companyData.covering[key]) {
      const videoUrl = companyData.covering[key].videoUrl;
      return {
        text: companyData.covering[key].answer,
        videoHtml: videoUrl
          ? `<iframe width="100%" height="auto" src="${videoUrl}" frameborder="0" allowfullscreen style="margin-top:20px;"></iframe>`
          : null,
        description: null,
        imageUrl: null
      };
    }
  }
  if (
    normalizedUserInput.includes("커버링") &&
    normalizedUserInput.includes("방법") &&
    !coveringTypes2.some(type => normalizedUserInput.includes(type))
  ) {
    pendingCoveringContext = true;
    return {
      text: "어떤 커버링인가요? 예를 들어, '맥스', '프라임', '더블', '피라미드' 등을 입력해주세요.",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }
  if (normalizedUserInput === "커버링 방법 알려줘") {
    pendingCoveringContext = true;
    return {
      text: "어떤 커버링인가요? 예를 들어, '맥스', '프라임', '더블', '피라미드' 등을 입력해주세요.",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }

  // =========================
  // Step 4: 비즈 관련 조건
  // =========================
  const bizTypes = ["프리미엄 플러스", "프리미엄", "스탠다드"];
  if (normalizedUserInput.includes("비즈") && !bizTypes.some((type) => normalizedUserInput.includes(type))) {
    return {
      text: "어떤 비즈에 대해 궁금하신가요? 예를 들어, '스탠다드 비즈', '프리미엄 비즈', '프리미엄 플러스 비즈' 등을 입력해주세요.",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }
  if (normalizedUserInput === "비즈 알려줘" || normalizedUserInput === "비즈 방법 알려줘") {
    return {
      text: "어떤 비즈에 대해 궁금하신가요? 예를 들어, '스탠다드 비즈', '프리미엄 비즈', '프리미엄 플러스 비즈' 등을 입력해주세요.",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }
  // 특정 비즈
  if (bizTypes.includes(normalizedUserInput)) {
    const key = `${normalizedUserInput} 비즈 에 대해 알고 싶어`;
    if (companyData.biz && companyData.biz[key]) {
      return {
        text: companyData.biz[key].description + " " + getAdditionalBizComment(),
        videoHtml: null,
        description: companyData.biz[key].description,
        imageUrl: null
      };
    }
  }
  for (let bizType of bizTypes) {
    if (normalizedUserInput.includes(bizType)) {
      const key = `${bizType} 비즈 에 대해 알고 싶어`;
      if (companyData.biz && companyData.biz[key]) {
        return {
          text: companyData.biz[key].description + " " + getAdditionalBizComment(),
          videoHtml: null,
          description: companyData.biz[key].description,
          imageUrl: null
        };
      }
    }
  }

  // =========================
  // Step 5: 요기보 history
  // =========================
  if (
    normalizedUserInput.includes("요기보") &&
    (normalizedUserInput.includes("역사") ||
      normalizedUserInput.includes("알려줘") ||
      normalizedUserInput.includes("란") ||
      normalizedUserInput.includes("탄생") ||
      normalizedUserInput.includes("에 대해"))
  ) {
    const key = "요기보 에 대해 알고 싶어";
    if (companyData.history && companyData.history[key]) {
      const fullHistory = companyData.history[key].description;
      const summary = summarizeHistory(fullHistory, 300);
      return {
        text: summary,
        videoHtml: null,
        description: fullHistory,
        imageUrl: null
      };
    }
  }

  // =========================
  // Step 6: goodsInfo (Levenshte인)
  // =========================
  let bestGoodsMatch = null;
  let bestGoodsDistance = Infinity;
  if (companyData.goodsInfo) {
    for (let question in companyData.goodsInfo) {
      const normalizedQuestion = normalizeSentence(question);
      const distance = levenshtein.get(normalizedUserInput, normalizedQuestion);
      if (distance < bestGoodsDistance) {
        bestGoodsDistance = distance;
        bestGoodsMatch = companyData.goodsInfo[question];
      }
    }
  }
  const goodsThreshold = 8;
  if (bestGoodsMatch && bestGoodsDistance <= goodsThreshold) {
    return {
      text: bestGoodsMatch.description,
      videoHtml: null,
      description: bestGoodsMatch.description,
      imageUrl: bestGoodsMatch.imageUrl ? bestGoodsMatch.imageUrl : null
    };
  }

  // =========================
  // Step 7: 회원가입 관련 조건
  // =========================
  if (
    normalizedUserInput.includes("회원가입") ||
    normalizedUserInput.includes("회원 등록") ||
    normalizedUserInput.includes("가입 방법")
  ) {
    const key = "회원 가입 방법";
    if (companyData.homePage && companyData.homePage[key]) {
      return {
        text: companyData.homePage[key].description,
        videoHtml: null,
        description: companyData.homePage[key].description,
        imageUrl: companyData.homePage[key].imageUrl ? companyData.homePage[key].imageUrl : null
      };
    }
  }

  // =========================
  // Step 8: 배송정보(deliveryInfo) (Levenshte인)
  // =========================
  let deliveryPageMatch = null;
  let deliveryPageDistance = Infinity;
  if (companyData.deliveryInfo) {
    for (let question in companyData.deliveryInfo) {
      const normalizedQuestion = normalizeSentence(question);
      const distance = levenshtein.get(normalizedUserInput, normalizedQuestion);
      if (distance < deliveryPageDistance) {
        deliveryPageDistance = distance;
        deliveryPageMatch = companyData.deliveryInfo[question];
      }
    }
  }
  const deliveryPageThreshold = 8;
  if (deliveryPageMatch && deliveryPageDistance <= deliveryPageThreshold) {
    return {
      text: deliveryPageMatch.description,
      videoHtml: null,
      description: deliveryPageMatch.description,
      imageUrl: deliveryPageMatch.imageUrl ? deliveryPageMatch.imageUrl : null
    };
  }

  // =========================
  // Step 9: homePage (Levenshte인)
  // =========================
  let homePageMatch = null;
  let homePageDistance = Infinity;
  if (companyData.homePage) {
    for (let question in companyData.homePage) {
      // "회원 가입 방법"은 위에서 처리
      if (question.includes("회원 가입 방법")) continue;

      const normalizedQuestion = normalizeSentence(question);
      const distance = levenshtein.get(normalizedUserInput, normalizedQuestion);
      if (distance < homePageDistance) {
        homePageDistance = distance;
        homePageMatch = companyData.homePage[question];
      }
    }
  }
  const homePageThreshold = 6;
  if (homePageMatch && homePageDistance <= homePageThreshold) {
    return {
      text: homePageMatch.description,
      videoHtml: null,
      description: homePageMatch.description,
      imageUrl: homePageMatch.imageUrl ? homePageMatch.imageUrl : null
    };
  }

  // =========================
  // Step 10: covering / biz 최종 비교
  // =========================
  let bestMatch = null;
  let bestDistance = Infinity;
  let bestCategory = null;

  if (companyData.covering) {
    for (let question in companyData.covering) {
      const normalizedQuestion = normalizeSentence(question);
      const distance = levenshtein.get(normalizedUserInput, normalizedQuestion);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestMatch = companyData.covering[question];
        bestCategory = "covering";
      }
    }
  }
  if (companyData.biz) {
    for (let question in companyData.biz) {
      const normalizedQuestion = normalizeSentence(question);
      const distance = levenshtein.get(normalizedUserInput, normalizedQuestion);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestMatch = companyData.biz[question];
        bestCategory = "biz";
      }
    }
  }
  const finalThreshold = 7;
  if (bestDistance > finalThreshold) {
    return {
      text: "질문을 이해하지 못했어요. 좀더 자세히 입력 해주시겠어요",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }
  if (bestCategory === "covering") {
    const videoUrl = bestMatch.videoUrl ? bestMatch.videoUrl : null;
    return {
      text: bestMatch.answer,
      videoHtml: videoUrl
        ? `<iframe width="100%" height="auto" src="${videoUrl}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`
        : null,
      description: null,
      imageUrl: null
    };
  } else if (bestCategory === "biz") {
    return {
      text: bestMatch.description + " " + getAdditionalBizComment(),
      videoHtml: null,
      description: bestMatch.description,
      imageUrl: null
    };
  }

  // 기본 fallback
  return {
    text: "알 수 없는 오류가 발생했습니다.",
    videoHtml: null,
    description: null,
    imageUrl: null
  };
}


/**
 * 챗봇 메인 로직 함수 (async)  
 * 1. 회원 아이디 조회  
 * 2. "주문번호" → 주문번호 목록  
 * 3. "배송번호" → 최신 주문의 배송번호  
 * 4. 주문번호가 포함된 경우 → 해당 주문번호의 배송 상세 정보 조회  
 * 5. "주문정보 확인" → 주문번호 목록 제공  
 * 6. "주문상태 확인"/"배송 상태 확인"/"배송정보 확인"(주문번호 미포함) → 최신 주문의 배송 상세 정보 조회  
 * 7. 그 외 → 기본 응답
 */
async function findAnswer(userInput, memberId) {
  const normalizedUserInput = normalizeSentence(userInput);

  // 1. 회원 아이디 조회
  if (
    normalizedUserInput.includes("내 아이디") ||
    normalizedUserInput.includes("나의 아이디") ||
    normalizedUserInput.includes("아이디 조회") ||
    normalizedUserInput.includes("아이디 알려줘")
  ) {
    if (memberId && memberId !== "null") {
      return {
        text: `안녕하세요 ${memberId} 고객님, 궁금하신 사항을 남겨주세요.`,
        videoHtml: null,
        description: null,
        imageUrl: null,
      };
    } else {
      return {
        text: "안녕하세요 고객님, 궁금하신 사항을 남겨주세요.",
        videoHtml: null,
        description: null,
        imageUrl: null,
      };
    }
  }

  // 2. "주문번호"라고 입력하면 → 해당 멤버의 주문번호 목록 제공
  if (normalizedUserInput.includes("주문번호")) {
    if (memberId && memberId !== "null") {
      try {
        const orderData = await getOrderShippingInfo(memberId);
        if (orderData.orders && orderData.orders.length > 0) {
          let orderNumbers = orderData.orders.map(order => order.order_id).join(", ");
          return {
            text: `고객님의 주문번호는 ${orderNumbers} 입니다.`,
            videoHtml: null,
            description: null,
            imageUrl: null,
          };
        } else {
          return { text: "주문 정보가 없습니다." };
        }
      } catch (error) {
        return { text: "주문번호를 가져오는 데 오류가 발생했습니다." };
      }
    } else {
      return { text: "회원 정보가 확인되지 않습니다. 로그인 후 다시 시도해주세요." };
    }
  }

  // 3. "배송번호"라고 입력하면 → 최신 주문의 배송번호 제공
  if (normalizedUserInput.includes("배송번호")) {
    if (memberId && memberId !== "null") {
      try {
        const orderData = await getOrderShippingInfo(memberId);
        if (orderData.orders && orderData.orders.length > 0) {
          const targetOrder = orderData.orders[0];
          const shipment = await getShipmentDetail(targetOrder.order_id);
          if (shipment && shipment.shipping_code) {
            return {
              text: `최신 주문의 배송번호는 ${shipment.shipping_code} 입니다.`,
              videoHtml: null,
              description: null,
              imageUrl: null,
            };
          } else {
            return { text: "배송번호를 찾을 수 없습니다." };
          }
        } else {
          return { text: "주문 정보가 없습니다." };
        }
      } catch (error) {
        return { text: "배송번호를 가져오는 데 오류가 발생했습니다." };
      }
    } else {
      return { text: "회원 정보가 확인되지 않습니다. 로그인 후 다시 시도해주세요." };
    }
  }

  // 4. 질문에 주문번호(패턴: 20240920-0000167)가 포함된 경우 → 해당 주문번호의 배송 상세 정보 조회
  if (containsOrderNumber(normalizedUserInput)) {
    if (memberId && memberId !== "null") {
      try {
        const match = normalizedUserInput.match(/\d{8}-\d{7}/);
        const targetOrderNumber = match ? match[0] : "";
        const shipment = await getShipmentDetail(targetOrderNumber);
        if (shipment) {
          let status = shipment.status || "정보 없음";
          let trackingNo = shipment.tracking_no || "정보 없음";
          let shippingCompany = shipment.shipping_company_name || "정보 없음";
          return {
            text: `주문번호 ${targetOrderNumber}의 배송 상태는 ${status}이며, 송장번호는 ${trackingNo}, 택배사는 ${shippingCompany} 입니다.`,
            videoHtml: null,
            description: null,
            imageUrl: null,
          };
        } else {
          return {
            text: "해당 주문번호에 대한 배송 정보를 찾을 수 없습니다.",
            videoHtml: null,
            description: null,
            imageUrl: null,
          };
        }
      } catch (error) {
        return {
          text: "배송 정보를 확인하는 데 오류가 발생했습니다.",
          videoHtml: null,
          description: null,
          imageUrl: null,
        };
      }
    } else {
      return { text: "회원 정보가 확인되지 않습니다. 로그인 후 다시 시도해주세요." };
    }
  }

  // 5. "주문정보 확인" → 주문번호 목록 제공
  if (normalizedUserInput.includes("주문정보 확인")) {
    if (memberId && memberId !== "null") {
      try {
        const orderResult = await getOrderShippingInfo(memberId);
        if (orderResult.orders && orderResult.orders.length > 0) {
          let orderNumbers = orderResult.orders.map(order => order.order_id).join(", ");
          return { text: `고객님의 주문번호는 ${orderNumbers} 입니다.` };
        } else {
          return { text: "주문 정보가 없습니다." };
        }
      } catch (error) {
        return { text: "주문 정보를 가져오는 데 오류가 발생했습니다." };
      }
    } else {
      return { text: "회원 정보가 확인되지 않습니다. 로그인 후 다시 시도해주세요." };
    }
  }

  // 6. "주문상태 확인", "배송 상태 확인", 또는 "배송정보 확인"(주문번호 미포함) → 최신 주문의 배송 상세 정보 제공
  if (
    (normalizedUserInput.includes("주문상태 확인") ||
      normalizedUserInput.includes("배송 상태 확인") ||
      normalizedUserInput.includes("배송상태 확인") ||
      normalizedUserInput.includes("배송정보 확인")) &&
    !containsOrderNumber(normalizedUserInput)
  ) {
    if (memberId && memberId !== "null") {
      try {
        const orderData = await getOrderShippingInfo(memberId);
        if (orderData.orders && orderData.orders.length > 0) {
          const targetOrder = orderData.orders[0];
          const shipment = await getShipmentDetail(targetOrder.order_id);
          if (shipment) {
            let status = shipment.status || "배송완료";
            let trackingNo = shipment.tracking_no || "정보 없음";
            let shippingCompany = shipment.shipping_company_name || "정보 없음";
            return {
              text: `고객님이 주문하신 상품의 경우 ${shippingCompany}를 통해 배송완료 되었으며, 운송장 번호는 ${trackingNo} 입니다.`,
              videoHtml: null,
              description: null,
              imageUrl: null,
            };
          } else {
            return { text: "해당 주문에 대한 배송 상세 정보를 찾을 수 없습니다." };
          }
        } else {
          return { text: "고객님의 주문 정보가 없습니다." };
        }
      } catch (error) {
        return { text: "배송 정보를 가져오는 데 오류가 발생했습니다." };
      }
    } else {
      return { text: "회원 정보가 확인되지 않습니다. 로그인 후 다시 시도해주세요." };
    }
  }

  // 7. 그 외 → 기본 응답
  return {
    text: "질문을 이해하지 못했어요. 좀더 자세히 입력 해주시겠어요",
    videoHtml: null,
    description: null,
    imageUrl: null,
  };
}

// server.js의 getGPT3TurboResponse 예시
async function getGPT3TurboResponse(userInput) {
  try {
    const response = await axios.post(
      OPEN_URL,
      {
        model: process.env.FINETUNED_MODEL || "gpt-3.5-turbo",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: userInput }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    const gptAnswer = response.data.choices[0].message.content;
    return gptAnswer;
  } catch (error) {
    console.error("Error calling OpenAI:", error.message);
    return "GPT fallback response";
  }
}

/**
 * Express 라우팅
 */
app.post("/chat", async (req, res) => {
  const userInput = req.body.message;
  const memberId = req.body.memberId; // 프론트에서 전달한 회원 ID
  if (!userInput) {
    return res.status(400).json({ error: "Message is required" });
  }
  try {
    const answer = await findAnswer(userInput, memberId);
    if (answer.text === "질문을 이해하지 못했어요. 좀더 자세히 입력 해주시겠어요") {
      const gptResponse = await getGPT3TurboResponse(userInput);
      return res.json({
        text: gptResponse,
        videoHtml: null,
        description: null,
        imageUrl: null
      });
    }
    return res.json(answer);
  } catch (error) {
    console.error("Error in /chat endpoint:", error.message);
    return res.status(500).json({
      text: "질문을 이해하지 못했어요. 좀더 자세히 입력 해주시겠어요",
      videoHtml: null,
      description: null,
      imageUrl: null
    });
  }
});

// 서버 시작 전 MongoDB에서 토큰 로드 후 실행
(async function initialize() {
  await getTokensFromDB();
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
})();
