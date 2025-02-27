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

// MongoDB에서 토큰을 불러오는 함수 (전체 문서를 가져옴)
async function getTokensFromDB() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(tokenCollectionName);
    // 컬렉션 내 첫 번째 문서를 가져옵니다.
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

// MongoDB에 토큰을 저장하는 함수 (업데이트 시 필터를 {}로 사용)
async function saveTokensToDB(newAccessToken, newRefreshToken) {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(tokenCollectionName);
    // 빈 필터 {}로 문서를 업데이트(없으면 새 문서 생성)
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
 * 401 에러 발생 시 refreshToken을 사용하여 토큰을 갱신하고 DB에 저장합니다.
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
  try {
    const response = await axios({
      method,
      url,
      data,
      params,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
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
 * 주문 배송 정보 조회 함수: 회원의 주문 데이터를 원본 형태로 반환
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
    return response; // API의 원본 응답(JSON 형태)
  } catch (error) {
    console.error("Error fetching order shipping info:", error.message);
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
 * 주문 객체(order)의 배송 상태에 따라 메시지를 생성하는 함수
 */
function processOrderShippingStatus(order) {
  let message = "";
  if (order.shipping_status === "N40") {
    // 배송완료: 배송 시작일(shipbegin_date)과 배송 완료일(shipend_date)을 표시
    const shipBegin = order.shipbegin_date || "정보 없음";
    const shipEnd = order.shipend_date || "정보 없음";
    message = `고객님이 주문하신 상품은 배송완료 처리되었습니다. 배송 시작일: ${shipBegin}, 배송 완료일: ${shipEnd}.`;
  } else if (order.shipping_status === "N30") {
    // 배송중: 송장번호(invoice_number)를 함께 표시
    const invoiceNumber = order.invoice_number || "정보 없음";
    message = `해당 상품은 배송중에 있습니다. 송장번호: ${invoiceNumber}.`;
  } else {
    message = "배송 상태를 확인할 수 없습니다.";
  }
  return message;
}

/**
 * API 응답 데이터 내 orders 배열을 처리하여 각 주문별 배송 상태 메시지를 생성하는 함수
 */
function processOrdersResponse(apiResponse) {
  if (apiResponse.orders && Array.isArray(apiResponse.orders)) {
    return apiResponse.orders.map(order => {
      const shippingMessage = processOrderShippingStatus(order);
      return {
        order_id: order.order_id,
        shipping_status: order.shipping_status,
        message: shippingMessage
      };
    });
  } else {
    return [];
  }
}

// 주문번호 패턴 검사 (예: 20170710-0000013 형태)
function containsOrderNumber(input) {
  return /\d{8}-\d{7}/.test(input);
}

/**
 * 챗봇 메인 로직 함수  
 * userInput과 memberId가 전달되며, 아래와 같이 처리합니다.
 * 
 * 1. "내 아이디", "나의 아이디", "아이디 조회", "아이디 알려줘" 문의 시 회원 아이디를 응답.
 * 2. "주문정보 확인" 문의 시 주문번호 목록을 제공.
 * 3. "주문상태 확인" 또는 "배송 상태 확인" 문의 시,
 *    - 주문번호가 포함되어 있지 않으면 주문번호 목록을 안내하고 주문번호 입력 요청.
 *    - 주문번호가 포함되어 있으면 해당 주문의 배송 상태 정보를 응답.
 * 4. 그 외 문의는 기본 메시지로 응답.
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
        text: `안녕하세요 ${memberId} 고객님 반갑습니다. 채팅창에 요기보에 대해 궁금하신 사항을 남겨주세요.`,
        videoHtml: null,
        description: null,
        imageUrl: null,
      };
    } else {
      return {
        text: "안녕하세요 고객님, 채팅창에 요기보에 대해 궁금하신 사항을 남겨주세요.",
        videoHtml: null,
        description: null,
        imageUrl: null,
      };
    }
  }

  // 2. 주문정보 확인
  if (normalizedUserInput.includes("주문정보 확인")) {
    if (memberId && memberId !== "null") {
      const orderResult = await getOrderInfo(memberId);
      return {
        text: orderResult,
        videoHtml: null,
        description: null,
        imageUrl: null,
      };
    } else {
      return {
        text: "회원 정보가 확인되지 않습니다. 로그인 후 다시 시도해주세요.",
        videoHtml: null,
        description: null,
        imageUrl: null,
      };
    }
  }

  // 3. 주문상태/배송 상태 확인
  if (normalizedUserInput.includes("주문상태 확인") || normalizedUserInput.includes("배송 상태 확인")) {
    if (memberId && memberId !== "null") {
      // 주문번호가 포함되어 있지 않으면 주문번호 목록 안내
      if (!containsOrderNumber(normalizedUserInput)) {
        try {
          const orderData = await getOrderShippingInfo(memberId);
          if (orderData.orders && orderData.orders.length > 0) {
            const orderNumbers = orderData.orders.map(order => order.order_id);
            return {
              text: `주문상태를 확인하시려면 주문 번호나 관련 정보를 제공해주셔야 합니다. 고객님의 주문 번호는 ${orderNumbers.join(
                ", "
              )} 입니다. 원하시는 주문 번호를 입력해주세요.`,
              videoHtml: null,
              description: null,
              imageUrl: null,
            };
          } else {
            return {
              text: "고객님의 주문 정보가 없습니다.",
              videoHtml: null,
              description: null,
              imageUrl: null,
            };
          }
        } catch (error) {
          return {
            text: "주문 정보를 가져오는 데 오류가 발생했습니다.",
            videoHtml: null,
            description: null,
            imageUrl: null,
          };
        }
      } else {
        // 주문번호가 포함되어 있는 경우
        try {
          const orderData = await getOrderShippingInfo(memberId);
          const match = normalizedUserInput.match(/\d{8}-\d{7}/);
          const targetOrderNumber = match ? match[0] : "";
          const targetOrder = orderData.orders.find(order => order.order_id.includes(targetOrderNumber));
          if (targetOrder) {
            const shippingMessage = processOrderShippingStatus(targetOrder);
            return {
              text: `주문번호 ${targetOrder.order_id}: ${shippingMessage}`,
              videoHtml: null,
              description: null,
              imageUrl: null,
            };
          } else {
            return {
              text: "해당 주문 번호에 해당하는 주문 정보를 찾을 수 없습니다.",
              videoHtml: null,
              description: null,
              imageUrl: null,
            };
          }
        } catch (error) {
          return {
            text: "주문 상태를 확인하는 데 오류가 발생했습니다.",
            videoHtml: null,
            description: null,
            imageUrl: null,
          };
        }
      }
    } else {
      return {
        text: "회원 정보가 확인되지 않습니다. 로그인 후 다시 시도해주세요.",
        videoHtml: null,
        description: null,
        imageUrl: null,
      };
    }
  }

  // 4. 그 외 문의에 대한 기본 응답
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
    // fallback: 기본 응답이 fallback 메시지면 GPT API 호출
    if (answer.text === "질문을 이해하지 못했어요. 좀더 자세히 입력 해주시겠어요") {
      const gptResponse = await getGPT3TurboResponse(userInput);
      return res.json({
        text: gptResponse,
        videoHtml: null,
        description: null,
        imageUrl: null,
      });
    }
    return res.json(answer);
  } catch (error) {
    console.error("Error in /chat endpoint:", error.message);
    return res.status(500).json({
      text: "질문을 이해하지 못했어요. 좀더 자세히 입력 해주시겠어요",
      videoHtml: null,
      description: null,
      imageUrl: null,
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
