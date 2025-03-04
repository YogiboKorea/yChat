/******************************************************
 * server.js - JSON FAQ + 주문배송 로직 + ChatGPT fallback
 ******************************************************/

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

// ========== [1] 환경변수 및 기본 설정 ==========

let accessToken = process.env.ACCESS_TOKEN || 'pPhbiZ29IZ9kuJmZ3jr15C';
let refreshToken = process.env.REFRESH_TOKEN || 'CMLScZx0Bh3sIxlFTHDeMD';
const CAFE24_CLIENT_ID = process.env.CAFE24_CLIENT_ID;
const CAFE24_CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET;
const DB_NAME = process.env.DB_NAME;
const MONGODB_URI = process.env.MONGODB_URI;
const CAFE24_MALLID = process.env.CAFE24_MALLID;
const OPEN_URL = process.env.OPEN_URL;  // 예: "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.API_KEY;    // OpenAI API 키
const FINETUNED_MODEL = process.env.FINETUNED_MODEL || "gpt-3.5-turbo";
const CAFE24_API_VERSION = process.env.CAFE24_API_VERSION || '2024-06-01';

// **Yogibo 브랜드 맥락(시스템 프롬프트)**
const YOGIBO_SYSTEM_PROMPT = `
You are a helpful assistant for the "Yogibo" brand.
Yogibo is known for comfortable bean bag furniture and accessories.
Answer user questions specifically about Yogibo products, shipping, and brand information.
If you are unsure or the question is out of scope, ask for clarification or provide a fallback response.
`;

// Express 앱
const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ========== [2] JSON 데이터 로드 (FAQ/제품 안내 등) ==========
// companyData.json 파일에 covering, washing, sizeInfo, biz, goodsInfo 등 추가 가능
const companyDataPath = path.join(__dirname, "json", "companyData.json");
const companyData = JSON.parse(fs.readFileSync(companyDataPath, "utf-8"));

// 간단한 맥락 변수 (서버 메모리에 저장: 실제 운영 시 세션/DB로 관리 권장)
let pendingCoveringContext = false;
let pendingWashingContext = false;

// MongoDB에서 토큰을 저장할 컬렉션명
const tokenCollectionName = "tokens";

// ========== [3] MongoDB 토큰 관리 함수 ==========
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

async function refreshAccessToken() {
  console.log('401 에러 발생: MongoDB에서 토큰 정보 다시 가져오기...');
  await getTokensFromDB();
  console.log('MongoDB에서 토큰 갱신 완료:', accessToken, refreshToken);
  return accessToken;
}

// ========== [4] Cafe24 API 요청 함수 ==========

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

// ========== [5] Cafe24 주문/배송 관련 함수 ==========

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
      // 간단한 택배사 코드 매핑
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

// ========== [6] 기타 유틸 함수 ==========

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

function containsOrderNumber(input) {
  return /\d{8}-\d{7}/.test(input);
}

// ========== [7] OpenAI GPT (fallback) - 맥락(컨텍스트) 주입 ==========

async function getGPT3TurboResponse(userInput) {
  try {
    const response = await axios.post(
      OPEN_URL,
      {
        model: FINETUNED_MODEL,
        messages: [
          {
            role: "system",
            content: `
              You are a helpful assistant for the "Yogibo" brand.
              Yogibo is known for comfortable bean bag furniture and accessories.
              Answer user questions in Korean, specifically about Yogibo products, shipping, and brand information.
              If you are unsure or the question is out of scope, ask for clarification or provide a fallback response in Korean.
              If you ask for an answer that goes against the request, you can check it through the customer center
          `
          },
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
    // 에러 시에도 한국어 메시지
    return "요기보 챗봇 오류가 발생했습니다. 다시 시도 부탁드립니다.";
  }
}

// ========== [8] 메인 로직: findAnswer ==========

async function findAnswer(userInput, memberId) {
  const normalizedUserInput = normalizeSentence(userInput);

  /************************************************
   * A. JSON 기반 FAQ / 제품 안내 로직
   ************************************************/

  // (1) 세탁 방법 맥락 처리
  if (pendingWashingContext) {
    const washingMap = {
      "요기보": "요기보",
      "줄라": "줄라",
      "럭스": "럭스",
      "모듀": "모듀",
      "메이트": "메이트"
    };
    for (let key in washingMap) {
      if (normalizedUserInput.includes(key)) {
        if (companyData.washing && companyData.washing[key]) {
          pendingWashingContext = false;
          return {
            text: companyData.washing[key].description,
            videoHtml: null,
            description: null,
            imageUrl: null
          };
        }
      }
    }
    pendingWashingContext = false;
    return {
      text: "해당 커버 종류를 찾지 못했어요. (요기보, 줄라, 럭스, 모듀, 메이트 중 하나를 입력해주세요.)",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }

  if (
    normalizedUserInput.includes("세탁방법") ||
    (normalizedUserInput.includes("세탁") && normalizedUserInput.includes("방법"))
  ) {
    pendingWashingContext = true;
    return {
      text: "어떤 커버(제품) 세탁 방법이 궁금하신가요? (요기보, 줄라, 럭스, 모듀, 메이트 등)",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }

  // (2) 커버링 방법 맥락 처리
  if (pendingCoveringContext) {
    const coveringTypes = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
    if (coveringTypes.includes(normalizedUserInput)) {
      const key = `${normalizedUserInput} 커버링 방법을 알고 싶어`;
      if (companyData.covering && companyData.covering[key]) {
        const videoUrl = companyData.covering[key].videoUrl;
        pendingCoveringContext = false;
        return {
          text: companyData.covering[key].answer,
          videoHtml: videoUrl
            ? `<iframe width="100%" height="auto" src="${videoUrl}" frameborder="0" allowfullscreen></iframe>`
            : null,
          description: null,
          imageUrl: null
        };
      }
      pendingCoveringContext = false;
    }
  }

  if (
    normalizedUserInput.includes("커버링") &&
    normalizedUserInput.includes("방법") &&
    !normalizedUserInput.includes("주문")
  ) {
    const coveringTypes2 = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
    const foundType = coveringTypes2.find(type => normalizedUserInput.includes(type));
    if (foundType) {
      const key = `${foundType} 커버링 방법을 알고 싶어`;
      if (companyData.covering && companyData.covering[key]) {
        const videoUrl = companyData.covering[key].videoUrl;
        return {
          text: companyData.covering[key].answer,
          videoHtml: videoUrl
            ? `<iframe width="100%" height="auto" src="${videoUrl}" frameborder="0" allowfullscreen></iframe>`
            : null,
          description: null,
          imageUrl: null
        };
      }
    } else {
      pendingCoveringContext = true;
      return {
        text: "어떤 커버링을 알고 싶으신가요? (맥스, 더블, 프라임, 슬림, 미니, etc.)",
        videoHtml: null,
        description: null,
        imageUrl: null
      };
    }
  }

  // (3) 사이즈 안내
  const sizeTypes = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
  if (
    normalizedUserInput.includes("사이즈") ||
    normalizedUserInput.includes("크기")
  ) {
    for (let sizeType of sizeTypes) {
      if (normalizedUserInput.includes(sizeType)) {
        const key = sizeType + " 사이즈 또는 크기.";
        if (companyData.sizeInfo && companyData.sizeInfo[key]) {
          return {
            text: companyData.sizeInfo[key].description,
            videoHtml: null,
            description: null,
            imageUrl: companyData.sizeInfo[key].imageUrl
          };
        }
      }
    }
  }

  // (4) 비즈 안내
  const bizKeywords = ["스탠다드", "프리미엄", "프리미엄 플러스", "비즈"];
  if (bizKeywords.some(bw => normalizedUserInput.includes(bw))) {
    // 어떤 비즈인지 구분
    // "스탠다드" / "프리미엄" / "프리미엄 플러스" 중 어떤 단어가 들어있는지 확인
    let matchedType = null;
    if (normalizedUserInput.includes("스탠다드")) matchedType = "스탠다드";
    else if (normalizedUserInput.includes("프리미엄 플러스")) matchedType = "프리미엄 플러스";
    else if (normalizedUserInput.includes("프리미엄")) matchedType = "프리미엄";
    // 만약 "비즈"만 포함하고 구체적 타입은 없을 수도 있으니 처리
    if (matchedType) {
      // "스탠다드 비즈 에 대해 알고 싶어" 같은 JSON 키
      const key = `${matchedType} 비즈 에 대해 알고 싶어`;
      if (companyData.biz && companyData.biz[key]) {
        return {
          text: companyData.biz[key].description,
          videoHtml: null,
          description: null,
          imageUrl: null
        };
      } else {
        // JSON에 해당 키가 없으면 fallback
        return {
          text: `${matchedType} 비즈 정보가 없습니다. (JSON에 등록되어 있는지 확인해주세요)`,
          videoHtml: null,
          description: null,
          imageUrl: null
        };
      }
    } else {
      // "비즈"라는 단어만 포함되었을 때
      return {
        text: "어떤 비즈가 궁금하신가요? (스탠다드, 프리미엄, 프리미엄 플러스 등)",
        videoHtml: null,
        description: null,
        imageUrl: null
      };
    }
  }


  // (6) goodsInfo (유사도 매칭)
  if (companyData.goodsInfo) {
    let bestGoodsMatch = null;
    let bestGoodsDistance = Infinity;
    for (let question in companyData.goodsInfo) {
      const distance = levenshtein.get(normalizedUserInput, normalizeSentence(question));
      if (distance < bestGoodsDistance) {
        bestGoodsDistance = distance;
        bestGoodsMatch = companyData.goodsInfo[question];
      }
    }
    if (bestGoodsDistance < 6 && bestGoodsMatch) {
      return {
        text: Array.isArray(bestGoodsMatch.description)
          ? bestGoodsMatch.description.join("\n")
          : bestGoodsMatch.description,
        videoHtml: null,
        description: null,
        imageUrl: bestGoodsMatch.imageUrl || null
      };
    }
  }

  // (7) homePage 등
  if (companyData.homePage) {
    let bestHomeMatch = null;
    let bestHomeDist = Infinity;
    for (let question in companyData.homePage) {
      const distance = levenshtein.get(normalizedUserInput, normalizeSentence(question));
      if (distance < bestHomeDist) {
        bestHomeDist = distance;
        bestHomeMatch = companyData.homePage[question];
      }
    }
    if (bestHomeDist < 5 && bestHomeMatch) {
      return {
        text: bestHomeMatch.description,
        videoHtml: null,
        description: null,
        imageUrl: null
      };
    }
  }

 // (8) asInfo
if (companyData.asInfoList) {
  let asInfoMatch = null;
  let asInfoDist = Infinity;
  for (let question in companyData.asInfo) {
    const distance = levenshtein.get(normalizedUserInput, normalizeSentence(question));
    if (distance < asInfoDist) {
      asInfoDist = distance;
      asInfoMatch = companyData.asInfo[question];
    }
  }
  if (asInfoDist < 8 && asInfoMatch) {
    return {
      text: asInfoMatch.description,
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }
}



    
  /************************************************
   * B. Café24 주문/배송 로직
   ************************************************/

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

  // 주문번호 패턴 (ex: 20240920-0000167)
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

  // "주문상태 확인", "배송 상태 확인", "배송정보 확인" (주문번호 미포함)
  if (
    (normalizedUserInput.includes("주문상태 확인") ||
      normalizedUserInput.includes("배송 상태 확인") ||
      normalizedUserInput.includes("상품 배송정보") ||
      normalizedUserInput.includes("배송상태 확인") ||
      normalizedUserInput.includes("주문정보 확인") ||
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
              text: `고객님이 주문하신 상품의 경우 ${shippingCompany}를 통해 ${status} 되었으며, 운송장 번호는 ${trackingNo} 입니다.`,
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
        return { text: "고객님의 주문 정보를 찾을 수 없습니다. 주문 여부를 확인해주세요." };
      }
    } else {
      return { text: "회원 정보가 확인되지 않습니다. 로그인 후 다시 시도해주세요." };
    }
  }

  /************************************************
   * C. 최종 fallback
   ************************************************/
  return {
    text: "질문을 이해하지 못했어요. 좀더 자세히 입력 해주시겠어요",
    videoHtml: null,
    description: null,
    imageUrl: null,
  };
}

// ========== [9] /chat 라우팅 ==========

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

// ========== [10] 서버 시작 ==========

(async function initialize() {
  await getTokensFromDB();  // MongoDB에서 토큰 불러오기
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
})();
