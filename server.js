/******************************************************
 * server.js
 ******************************************************/
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const compression = require("compression");
const axios = require("axios");
const { MongoClient } = require("mongodb");
const levenshtein = require("fast-levenshtein"); // 필요하다면 유사 매칭용
require("dotenv").config();

// ======== 환경변수(.env)에서 가져올 값들 ========
let accessToken = process.env.ACCESS_TOKEN || 'pPhbiZ29IZ9kuJmZ3jr15C';
let refreshToken = process.env.REFRESH_TOKEN || 'CMLScZx0Bh3sIxlFTHDeMD';
const CAFE24_CLIENT_ID = process.env.CAFE24_CLIENT_ID;
const CAFE24_CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET;
const DB_NAME = process.env.DB_NAME;
const MONGODB_URI = process.env.MONGODB_URI;
const CAFE24_MALLID = process.env.CAFE24_MALLID;
const OPEN_URL = process.env.OPEN_URL; // 예: "https://api.openai.com/v1/chat/completions"
const CAFE24_API_VERSION = process.env.CAFE24_API_VERSION || '2024-06-01';
const API_KEY = process.env.API_KEY; // OpenAI API 키
const FINETUNED_MODEL = process.env.FINETUNED_MODEL || "gpt-3.5-turbo"; 

// ======== Express 앱 초기화 ========
const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ======== JSON 파일 로드 (회사 데이터, FAQ 등) ========
const companyDataPath = path.join(__dirname, "json", "companyData.json");
const companyData = JSON.parse(fs.readFileSync(companyDataPath, "utf-8"));

// ======== MongoDB 토큰 컬렉션 관련 ========
const tokenCollectionName = "tokens";

/**
 * 주문번호 패턴 검사 함수 (예: "20240920-0000167")
 */
function containsOrderNumber(input) {
  return /\d{8}-\d{7}/.test(input);
}

// ======== MongoDB에서 토큰 불러오기/저장하기 ========
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
 * Access Token 갱신 함수 (401 에러 시 MongoDB에서 최신 토큰 가져옴)
 */
async function refreshAccessToken() {
  console.log('401 에러 발생: MongoDB에서 토큰 정보 다시 가져오기...');
  await getTokensFromDB();
  console.log('MongoDB에서 토큰 갱신 완료:', accessToken, refreshToken);
  return accessToken;
}

/**
 * Cafe24 API 요청 함수 (자동 토큰 갱신 포함)
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

// ======== Cafe24 주문 관련 예시 함수들 ========
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
    return response; // 응답 내 orders 배열
  } catch (error) {
    console.error("Error fetching order shipping info:", error.message);
    throw error;
  }
}

async function getShipmentDetail(orderId) {
  const API_URL = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders/${orderId}/shipments`;
  const params = { shop_no: 1 };
  try {
    const response = await apiRequest("GET", API_URL, {}, params);
    if (response.shipments && response.shipments.length > 0) {
      const shipment = response.shipments[0];
      // 간단한 택배사 코드 매핑 예시
      if (shipment.shipping_company_code === "0019") {
        shipment.shipping_company_name = "롯데 택배";
      } else {
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

// ======== 유틸 함수들 ========
function normalizeSentence(sentence) {
  return sentence
    .replace(/[?!！？]/g, "")
    .replace(/없나요/g, "없어요")
    .trim();
}

/**
 * companyData.json 내 여러 카테고리(covering, sizeInfo, biz, history, goodsInfo, homePage, washing 등)
 * 질문과 일치하는 항목을 찾는 함수
 */
function findMatchingAnswer(normalizedUserInput) {
  // 이 배열에 JSON 파일에 있는 주요 카테고리 키를 추가
  const categories = ["covering", "sizeInfo", "biz", "history", "goodsInfo", "homePage", "washing"];

  for (const cat of categories) {
    const catData = companyData[cat];
    if (!catData) continue;

    // catData는 예: { "더블 커버링 방법을 알고 싶어": { answer: "...", videoUrl: "..." }, ... }
    for (const question in catData) {
      // 단순히 'includes'로 비교 (필요하다면 정교한 매칭 로직을 추가)
      // normalizeSentence(question)도 적용하면 좋을 수 있음
      if (normalizedUserInput.includes(question.replace(/[?!！？]/g, ""))) {
        const data = catData[question];
        // answer 혹은 description을 우선으로 사용
        const text = data.answer || data.description || "";
        const videoUrl = data.videoUrl || "";
        const imageUrl = data.imageUrl || "";

        // 매칭되면 즉시 결과 반환
        return { text, videoUrl, imageUrl };
      }
    }
  }

  // 여기까지 못 찾으면 null
  return null;
}

// ======== GPT API 연동 (fallback) ========
async function getGPT3TurboResponse(userInput) {
  try {
    const response = await axios.post(
      OPEN_URL,
      {
        model: FINETUNED_MODEL,  // 파인 튜닝 모델명 or 기본 gpt-3.5-turbo
        messages: [
          { role: "system", content: "You are a helpful assistant." },
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
    return gptAnswer;
  } catch (error) {
    console.error("Error calling OpenAI:", error.message);
    return "GPT fallback response";
  }
}

/**
 * 메인 챗봇 로직
 * 1) companyData.json 매칭
 * 2) Cafe24 주문/배송 로직
 * 3) 매칭 안 되면 GPT fallback
 */
async function findAnswer(userInput, memberId) {
  const normalizedUserInput = normalizeSentence(userInput);

  // A. 먼저 companyData.json 내에서 매칭 시도
  const matched = findMatchingAnswer(normalizedUserInput);
  if (matched) {
    // 동영상 URL이 있으면 iframe HTML을 만들어서 videoHtml 필드로 넘길 수도 있음
    // 여기서는 예시로 text만 넘기고, videoHtml은 null 처리
    return {
      text: matched.text,
      videoHtml: matched.videoUrl ? `<iframe width="560" height="315" src="${matched.videoUrl}" frameborder="0" allowfullscreen></iframe>` : null,
      description: null,
      imageUrl: matched.imageUrl || null
    };
  }

  // B. 기존 Cafe24 주문/배송 로직
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

  // 2. "주문번호"라고 입력하면 → 해당 멤버의 주문번호 목록
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

  // 3. "배송번호"라고 입력하면 → 최신 주문의 배송번호
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

  // 4. 주문번호 패턴(예: 20240920-0000167)이 포함된 경우
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

  // 5. "주문정보 확인"
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

  // 6. "주문상태 확인", "배송 상태 확인", "배송정보 확인" (주문번호 미포함)
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

  // C. 모든 조건 미매칭 → GPT fallback
  return {
    text: "질문을 이해하지 못했어요. 좀더 자세히 입력 해주시겠어요",
    videoHtml: null,
    description: null,
    imageUrl: null,
  };
}

// ======== Express 라우팅 ========
app.post("/chat", async (req, res) => {
  const userInput = req.body.message;
  const memberId = req.body.memberId; // 프론트에서 전달한 회원 ID
  if (!userInput) {
    return res.status(400).json({ error: "Message is required" });
  }
  try {
    const answer = await findAnswer(userInput, memberId);
    // 만약 answer.text가 특정 문구(예: "질문을 이해하지 못했어요")라면, GPT에게 fallback
    if (answer.text === "질문을 이해하지 못했어요. 좀더 자세히 입력 해주시겠어요") {
      const gptResponse = await getGPT3TurboResponse(userInput);
      return res.json({
        text: gptResponse,
        videoHtml: null,
        description: null,
        imageUrl: null
      });
    }
    // 매칭되었거나, Cafe24 로직에서 처리된 경우
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

// ======== 서버 시작 전 MongoDB에서 토큰 로드 후 실행 ========
(async function initialize() {
  await getTokensFromDB();
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
})();
