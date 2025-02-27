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
 * Access Token 갱신 함수  
 */
async function refreshAccessToken() {
  try {
    const basicAuth = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
    const response = await axios.post(
      `https://${CAFE24_MALLID}.cafe24api.com/api/v2/oauth/token`,
      `grant_type=refresh_token&refresh_token=${refreshToken}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${basicAuth}`,
        },
      }
    );
    const newAccessToken = response.data.access_token;
    const newRefreshToken = response.data.refresh_token;
    console.log('Access Token 갱신 성공:', newAccessToken);
    console.log('Refresh Token 갱신 성공:', newRefreshToken);
    await saveTokensToDB(newAccessToken, newRefreshToken);
    accessToken = newAccessToken;
    refreshToken = newRefreshToken;
    return newAccessToken;
  } catch (error) {
    if (error.response && error.response.data && error.response.data.error === 'invalid_grant') {
      console.error('Refresh Token이 만료되었습니다. 인증 단계를 다시 수행해야 합니다.');
    } else {
      console.error('Access Token 갱신 실패:', error.response ? error.response.data : error.message);
    }
    throw error;
  }
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
      
      // shipping_company_code가 "19"이면 "롯데 택배"로 매핑
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

/**
 * 챗봇 메인 로직 함수 (async)  
 * 1. 회원 아이디 조회
 * 2. "주문번호" → 주문번호 목록
 * 3. "배송번호" → 최신 주문의 배송번호
 * 4. 주문번호가 포함 → 해당 주문번호의 배송 상세 정보(status, tracking_no, 택배사)
 * 5. "주문정보 확인" → 주문번호 목록
 * 6. "주문상태 확인"/"배송 상태 확인"/"배송정보 확인"(주문번호 미포함) → 최신 주문의 배송 상세 정보
 * 7. 기본 응답
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

  // 4. 주문번호가 포함된 경우 → 해당 주문번호의 배송 상세 정보 조회
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

  // 6. "주문상태 확인", "배송 상태 확인", 또는 "배송정보 확인" (주문번호 미포함)
  if (
    (normalizedUserInput.includes("주문상태 확인") ||
      normalizedUserInput.includes("배송 상태 확인") ||
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
              text: `주문번호 ${targetOrder.order_id}의 배송 상태는 ${status}이며, 송장번호는 ${trackingNo}, 택배사는 ${shippingCompany} 입니다.`,
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

/**
 * GPT API 연동 함수 (fallback)
 */
async function getGPT3TurboResponse(userInput) {
  try {
    const response = await axios.post(
      OPEN_URL,
      {
        model: "gpt-3.5-turbo",
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
