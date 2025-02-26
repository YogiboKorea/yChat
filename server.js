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
let accessToken = process.env.ACCESS_TOKEN || null;
let refreshToken = process.env.REFRESH_TOKEN || null;
const CAFE24_CLIENT_ID = process.env.CAFE24_CLIENT_ID;
const CAFE24_CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET;
const DB_NAME = process.env.DB_NAME;
const MONGODB_URI = process.env.MONGODB_URI;
const CAFE24_MALLID = process.env.CAFE24_MALLID;
const CAFE24_API_VERSION = process.env.CAFE24_API_VERSION || "2024-12-01";
const OPEN_URL = process.env.OPEN_URL; // OpenAI API URL

// MongoDB 컬렉션명 (토큰 저장용)
const tokenCollectionName = "cafe24Tokens";

// Express 앱 초기화
const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// 예제용 JSON 데이터 (필요 시)
const companyData = JSON.parse(fs.readFileSync("./json/companyData.json", "utf-8"));

/**
 * MongoDB에서 토큰을 불러오는 함수
 */
async function getTokensFromDB() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(tokenCollectionName);
    const tokens = await collection.findOne({ name: 'cafe24Tokens' });
    if (tokens) {
      accessToken = tokens.accessToken;
      refreshToken = tokens.refreshToken;
      console.log('MongoDB에서 토큰 로드 성공:', tokens);
    } else {
      console.log('MongoDB에 저장된 토큰이 없습니다.');
    }
  } catch (error) {
    console.error('토큰 로드 중 오류:', error);
  } finally {
    await client.close();
  }
}

/**
 * MongoDB에 토큰을 저장하는 함수
 */
async function saveTokensToDB(newAccessToken, newRefreshToken) {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(tokenCollectionName);
    await collection.updateOne(
      { name: 'cafe24Tokens' },
      {
        $set: {
          name: 'cafe24Tokens',
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
 * Cafe24 주문 정보 조회 함수  
 * memberId를 기준으로 주문 내역을 조회합니다.
 */
async function getOrderInfo(memberId) {
  const API_URL = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`;
  // 날짜 범위는 필요에 따라 수정하세요.
  const params = {
    member_id: memberId,
    start_date: '2020-01-01',
    end_date: '2025-12-31',
    limit: 10,
  };
  try {
    const response = await apiRequest("GET", API_URL, {}, params);
    const orders = response.orders;
    if (!orders || orders.length === 0) {
      return "주문 정보가 없습니다.";
    }
    let orderNumbers = orders.map(order => order.order_id).join(", ");
    return `회원님의 주문번호: ${orderNumbers}`;
  } catch (error) {
    console.error("Error fetching order info:", error.message);
    return "주문 정보를 가져오는 데 실패했습니다.";
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
 * 챗봇 메인 로직 함수  
 * userInput과 함께 memberId가 전달되며,
 * "주문정보 확인" 문구가 포함되면 해당 회원의 주문 정보를 조회합니다.
 */
async function findAnswer(userInput, memberId) {
  const normalizedUserInput = normalizeSentence(userInput);

  // 주문 정보 조회 예제
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

  // 기타 질문 처리 로직은 필요에 따라 추가할 수 있습니다.
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
