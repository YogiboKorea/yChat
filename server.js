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

let accessToken = process.env.ACCESS_TOKEN || 'pPhbiZ29IZ9kuJmZ3jr15C';
let refreshToken = process.env.REFRESH_TOKEN || 'CMLScZx0Bh3sIxlFTHDeMD';
const CAFE24_CLIENT_ID = process.env.CAFE24_CLIENT_ID;
const CAFE24_CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET;
const DB_NAME = process.env.DB_NAME;
const MONGODB_URI = process.env.MONGODB_URI;
const CAFE24_MALLID = process.env.CAFE24_MALLID;
const OPEN_URL = process.env.OPEN_URL; // OpenAI API URL
const CAFE24_API_VERSION = process.env.CAFE24_API_VERSION || '2024-06-01';

const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const companyData = JSON.parse(fs.readFileSync("./json/companyData.json", "utf-8"));
const tokenCollectionName = "tokens";

function containsOrderNumber(input) {
  return /\d{8}-\d{7}/.test(input);
}

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

// refreshAccessToken 함수 제거됨

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
      console.log('Access Token 만료. MongoDB에서 토큰을 다시 가져옵니다.');
      // 토큰 만료 시 MongoDB에서 다시 토큰을 로드 후 재시도
      await getTokensFromDB();
      return apiRequest(method, url, data, params);
    } else {
      console.error('API 요청 오류:', error.response ? error.response.data : error.message);
      throw error;
    }
  }
}

// 나머지 함수들은 그대로 유지
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
    return response;
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

async function findAnswer(userInput, memberId) {
  const normalizedUserInput = normalizeSentence(userInput);

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
              text: `고객님이 주문하신 상품은 ${shippingCompany}를 통해 배송완료되었으며, 운송장 번호는 ${trackingNo} 입니다.`,
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

  return {
    text: "질문을 이해하지 못했어요. 좀더 자세히 입력 해주시겠어요",
    videoHtml: null,
    description: null,
    imageUrl: null,
  };
}

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

app.post("/chat", async (req, res) => {
  const userInput = req.body.message;
  const memberId = req.body.memberId;
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

(async function initialize() {
  await getTokensFromDB();
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
})();
