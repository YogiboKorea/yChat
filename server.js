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
let combinedSystemPrompt = null;
let pendingCoveringContext = false;

// ========== [시스템 프롬프트 설정] ==========
function convertPromptLinks(promptText) {
  return promptText
    .replace(/\[카카오플친 연결하기\]/g, '<a href="http://pf.kakao.com/_lxmZsxj/chat" target="_blank">카카오플친 연결하기</a>')
    .replace(/\[네이버톡톡 연결하기\]/g, '<a href="https://talk.naver.com/ct/wc4u67?frm=psf" target="_blank">네이버톡톡 연결하기</a>');
}

const basePrompt = `
1. 역할 및 말투  
전문가 역할: 요기보 브랜드에 대한 전문 지식을 가진 전문가로 행동합니다.  
존대 및 공손: 고객에게 항상 존댓말과 공손한 말투를 사용합니다.  
이모티콘 활용: 대화 중 적절히 이모티콘을 사용합니다.  
문단 띄어쓰기: 각 문단이 끝날 때마다 한 줄 이상의 공백을 넣어 가독성을 높여 주세요.
맞춤법 다음문장에서는 문단 공백을 통해 가독성을 높여 주세요.

2. 고객 응대 지침  
정확한 답변: 웹상의 모든 요기보 관련 데이터를 숙지하고, 고객 문의에 대해 명확하고 이해하기 쉬운 답변을 제공해 주세요.  
아래 JSON 데이터는 참고용 포스트잇 Q&A 데이터입니다. 이 데이터를 참고하여 적절한 답변을 생성해 주세요.

3. 항상 모드 대화의 마지막엔 추가 궁금한 사항이 있으실 경우, 상담사 연결을 채팅창에 입력 해주시면 보다 정확한 정보를 제공해 드릴수 있습니다. 
`;
const YOGIBO_SYSTEM_PROMPT = convertPromptLinks(basePrompt);

// ========== [데이터 로딩] ==========
const companyDataPath = path.join(__dirname, "json", "companyData.json");
const companyData = JSON.parse(fs.readFileSync(companyDataPath, "utf-8"));

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


async function findAnswer(userInput, memberId) {
  const normalized = normalizeSentence(userInput);

  // 1. FAQ 예시 처리
  if (normalized.includes("사이즈")) {
    return {
      text: "요기보 사이즈는 모델에 따라 다릅니다. 예) 맥스는 170cm x 70cm 크기예요 😊",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }

  // 2. 배송 상태 요청
  if (normalized.includes("배송")) {
    if (!memberId) {
      return {
        text: "비회원은 배송 상태를 확인할 수 없습니다. 로그인을 해주세요!",
        videoHtml: null,
        description: null,
        imageUrl: null
      };
    }
    // 배송 조회 로직 들어가는 자리...
    return {
      text: "주문하신 상품은 현재 배송 중입니다 🚚",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }

  // 3. fallback
  return {
    text: "질문을 이해하지 못했어요. 좀더 자세히 입력 해주시겠어요",
    videoHtml: null,
    description: null,
    imageUrl: null
  };
}

// ========== [5] Cafe24 주문/배송 관련 함수 ==========
async function getOrderShippingInfo(memberId) {
  const API_URL = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`;
  const today = new Date();
  const end_date = today.toISOString().split('T')[0];
  const twoWeeksAgo = new Date(today);
  twoWeeksAgo.setDate(today.getDate() - 14);
  const start_date = twoWeeksAgo.toISOString().split('T')[0];
  const params = {
    member_id: memberId,
    start_date: start_date,
    end_date: end_date,
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
      // 배송사 코드에 따른 이름과 링크 매핑
      const shippingCompanies = {
        "0019": { name: "롯데 택배", url: "https://www.lotteglogis.com/home/reservation/tracking/index" },
        "0039": { name: "경동 택배", url: "https://kdexp.com/index.do" }
      };
      if (shippingCompanies[shipment.shipping_company_code]) {
        shipment.shipping_company_name = shippingCompanies[shipment.shipping_company_code].name;
        shipment.shipping_company_url = shippingCompanies[shipment.shipping_company_code].url;
      } else {
        shipment.shipping_company_name = shipment.shipping_company_code || "물류 창고";
        shipment.shipping_company_url = null;
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


// ========== [10] 대화 로그 저장 함수 (당일 동일 아이디 대화는 배열로 업데이트) ==========
async function saveConversationLog(memberId, userMessage, botResponse) {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection("conversationLogs");
    // 오늘 날짜 (YYYY-MM-DD)
    const today = new Date().toISOString().split("T")[0];
    const query = {
      memberId: (memberId && memberId !== "null") ? memberId : null,
      date: today
    };
    const existingLog = await collection.findOne(query);
    const logEntry = {
      userMessage,
      botResponse,
      createdAt: new Date()
    };
    if (existingLog) {
      await collection.updateOne(query, { $push: { conversation: logEntry } });
      console.log("대화 로그 업데이트 성공");
    } else {
      await collection.insertOne({
        memberId: (memberId && memberId !== "null") ? memberId : null,
        date: today,
        conversation: [logEntry]
      });
      console.log("새 대화 로그 생성 및 저장 성공");
    }
  } catch (error) {
    console.error("대화 로그 저장 중 오류:", error.message);
  } finally {
    await client.close();
  }
}

// ========== [GPT 호출 함수] ==========
async function getGPT3TurboResponse(userInput) {
  if (!combinedSystemPrompt) {
    throw new Error("System prompt가 초기화되지 않았습니다.");
  }

  try {
    const response = await axios.post(
      OPEN_URL,
      {
        model: FINETUNED_MODEL,
        messages: [
          { role: "system", content: combinedSystemPrompt },
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

  }  catch (error) {
    //에러
    if (error.response) {
      console.error("Status:", error.response.status);        
      console.error("Response body:", error.response.data);  
    }
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

// ========== [시스템 프롬프트 생성 - Post-it 포함] ==========
async function initializeChatPrompt() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const postItNotes = await db.collection("postItNotes").find({}).limit(100).toArray();

    let postItContext = "\n아래는 참고용 포스트잇 Q&A 데이터입니다:\n";
    postItNotes.forEach(note => {
      if (note.question && note.answer) {
        postItContext += `\n질문: ${note.question}\n답변: ${note.answer}\n`;
      }
    });

    return YOGIBO_SYSTEM_PROMPT + postItContext;
  } catch (err) {
    console.error("Post-it 로딩 오류:", err);
    return YOGIBO_SYSTEM_PROMPT;
  } finally {
    await client.close();
  }
}


// ========== [대화 로그 저장] ==========
async function saveConversationLog(memberId, userMessage, botResponse) {
  const client = new MongoClient(MONGODB_URI);
  const today = new Date().toISOString().split("T")[0];
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const logs = db.collection("conversationLogs");

    const logEntry = {
      userMessage,
      botResponse,
      createdAt: new Date()
    };

    await logs.updateOne(
      { memberId: memberId || null, date: today },
      { $push: { conversation: logEntry } },
      { upsert: true }
    );
  } finally {
    await client.close();
  }
}


// ========== [11] 메인 로직: findAnswer ==========
async function findAnswer(userInput, memberId) {
  const normalizedUserInput = normalizeSentence(userInput);

  /************************************************
   * A. JSON 기반 FAQ / 제품 안내 로직
   ************************************************/
  // (2) 커버링 방법 맥락 처리
  if (pendingCoveringContext) {
    const coveringTypes = ["더블", "맥스", "프리미엄", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
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
    const coveringTypes2 = ["더블", "맥스", "프리미엄", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
    const foundType = coveringTypes2.find(type => normalizedUserInput.includes(type));
    if (foundType) {
      const key = `${foundType} 커버링 방법을 알고 싶어`;
      console.log("커버링 key:", key);
      if (companyData.covering && companyData.covering[key]) {
        const videoUrl = companyData.covering[key].videoUrl;
        console.log("videoUrl:", videoUrl);
        return {
          text: companyData.covering[key].answer,
          videoHtml: videoUrl
            ? `<iframe width="100%" height="auto" src="${videoUrl}" frameborder="0" allowfullscreen></iframe>`
            : null,
          description: null,
          imageUrl: null
        };
      } else {
        console.warn(`companyData.covering 에 "${key}" 키가 없습니다.`);
      }
    } else {
      pendingCoveringContext = true;
      return {
        text: "어떤 커버링을 알고 싶으신가요? (맥스, 더블, 프라임, 슬림, 미니 등)",
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
    let matchedType = null;
    if (normalizedUserInput.includes("스탠다드")) matchedType = "스탠다드";
    else if (normalizedUserInput.includes("프리미엄 플러스")) matchedType = "프리미엄 플러스";
    else if (normalizedUserInput.includes("프리미엄")) matchedType = "프리미엄";
    if (matchedType) {
      const key = `${matchedType} 비즈 에 대해 알고 싶어`;
      if (companyData.biz && companyData.biz[key]) {
        return {
          text: companyData.biz[key].description,
          videoHtml: null,
          description: null,
          imageUrl: null
        };
      } else {
        return {
          text: `${matchedType} 비즈 정보가 없습니다. (JSON에 등록되어 있는지 확인해주세요)`,
          videoHtml: null,
          description: null,
          imageUrl: null
        };
      }
    } else {
      return {
        text: "어떤 비즈가 궁금하신가요? (스탠다드, 프리미엄, 프리미엄 플러스 등)",
        videoHtml: null,
        description: null,
        imageUrl: null
      };
    }
  }

  // (5) goodsInfo (유사도 매칭)
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

  // (6) homePage 유사도 매칭
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

  // (7) asInfo 정보
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
  if (
    normalizedUserInput.includes("상담사 연결") ||
    normalizedUserInput.includes("상담원 연결") ||
    normalizedUserInput.includes("고객센터 연결")
  ) {
    return {
      text: `상담사와 연결을 도와드릴게요.
      <a href="http://pf.kakao.com/_lxmZsxj/chat" target="_blank" rel="noopener noreferrer">카카오플친 연결하기</a>
      <a href="https://talk.naver.com/ct/wc4u67?frm=psf" target="_blank" rel="noopener noreferrer">네이버톡톡 연결하기</a>
      `,
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }

  if (
    normalizedUserInput.includes("오프라인 매장")||
    normalizedUserInput.includes("매장안내")
  ) {
    return {
      text: `오프라인 매장안내 페이지를 통해 고객님의 위치와 가까운 매장을 안내해 드리고 있습니다. .
      <a href="/why.stroe.html" target="_blank" rel="noopener noreferrer">매장안내</a>
      `,
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }


  /************************************************
   * B. Café24 주문/배송 로직
   ************************************************/
  // (8) 회원 아이디 조회
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
        text: `안녕하세요 고객님 회원가입을 통해 요기보의 다양한 이벤트 혜택을 만나보실수 있어요! <a href="/member/login.html" target="_blank">회원가입 하러가기</a>`,
        videoHtml: null,
        description: null,
        imageUrl: null,
      };
    }
  }

  // (9) 주문번호가 포함된 경우 처리
  if (containsOrderNumber(normalizedUserInput)) {
    if (memberId && memberId !== "null") {
      try {
        const match = normalizedUserInput.match(/\d{8}-\d{7}/);
        const targetOrderNumber = match ? match[0] : "";
        const shipment = await getShipmentDetail(targetOrderNumber);
        if (shipment) {
          console.log("Shipment 전체 데이터:", shipment);
          console.log("shipment.status 값:", shipment.status);
          console.log("shipment.items 값:", shipment.items);
          const shipmentStatus =
            shipment.status || (shipment.items && shipment.items.length > 0 ? shipment.items[0].status : undefined);
          const itemStatusMap = {
            standby: "배송대기",
            shipping: "배송중",
            shipped: "배송완료",
            shipready:"배송준비중" 
          };
          const statusText = itemStatusMap[shipmentStatus] || shipmentStatus || "배송 완료";
          const trackingNo = shipment.tracking_no || "정보 없음";
          const shippingCompany = shipment.shipping_company_name || "정보 없음";
          return {
            text: `주문번호 ${targetOrderNumber}의 배송 상태는 ${statusText}이며, 송장번호는 ${trackingNo}, 택배사는 ${shippingCompany} 입니다.`,
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
      return { 
        text: `배송은 제품 출고 후 1~3 영업일 정도 소요되며, 제품별 출고 시 소요되는 기간은 아래 내용을 확인해주세요.
        - 소파 및 바디필로우: 주문 확인 후 제작되는 제품으로, 3~7 영업일 이내에 출고됩니다.
        - 모듀(모듈러) 소파: 주문 확인일로부터 1~3 영업일 이내에 출고됩니다.
        - 그 외 제품: 주문 확인일로부터 1~3 영업일 이내에 출고됩니다.
        일부 제품은 오후 1시 이전에 구매를 마쳐주시면 당일 출고될 수 있어요.
        개별 배송되는 제품을 여러 개 구매하신 경우 제품이 여러 차례로 나눠 배송될 수 있습니다.
        주문 폭주 및 재난 상황이나 천재지변, 택배사 사정 등에 의해 배송 일정이 일부 변경될 수 있습니다.
        추가 문의사항이 있으신 경우 Yogibo 고객센터로 문의해주세요.`,
        videoHtml: null,
        description: null,
        imageUrl: null
      };
    }
  }

  // (10) 주문번호 없이 주문상태 확인 처리
  if (
    (normalizedUserInput.includes("주문상태 확인") ||
      normalizedUserInput.includes("배송") ||
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
            const shipmentStatus =
              shipment.status || (shipment.items && shipment.items.length > 0 ? shipment.items[0].status : undefined);
            const itemStatusMap = {
              standby: "배송대기",
              shipping: "배송중",
              shipped: "배송완료",
              shipready:"배송준비중",
            };
            const statusText = itemStatusMap[shipmentStatus] || shipmentStatus || "배송완료";
            const trackingNo = shipment.tracking_no || "등록전";
            let shippingCompany = shipment.shipping_company_name || "등록전";
    
            if (shippingCompany === "롯데 택배") {
              shippingCompany = `<a href="https://www.lotteglogis.com/home/reservation/tracking/index" target="_blank">${shippingCompany}</a>`;
            } else if (shippingCompany === "경동 택배") {
              shippingCompany = `<a href="https://kdexp.com/index.do" target="_blank">${shippingCompany}</a>`;
            }
    
            return {
              text: `고객님께서 주문하신 상품은 ${shippingCompany}를 통해 ${statusText} 이며, 운송장 번호는 ${trackingNo} 입니다.`,
              videoHtml: null,
              description: null,
              imageUrl: null
            };
          } else {
            return { text: "해당 주문에 대한 배송 상세 정보를 찾을 수 없습니다." };
          }
        } else {
          return { 
            text: `배송은 제품 출고 후 1~3 영업일 정도 소요되며, 제품별 출고 시 소요되는 기간은 아래 내용을 확인해주세요.
            - 소파 및 바디필로우: 주문 확인 후 제작되는 제품으로, 3~7 영업일 이내에 출고됩니다.
            - 모듀(모듈러) 소파: 주문 확인일로부터 1~3 영업일 이내에 출고됩니다.
            - 그 외 제품: 주문 확인일로부터 1~3 영업일 이내에 출고됩니다.
            일부 제품은 오후 1시 이전에 구매를 마쳐주시면 당일 출고될 수 있어요.
            개별 배송되는 제품을 여러 개 구매하신 경우 제품이 여러 차례로 나눠 배송될 수 있습니다.
            주문 폭주 및 재난 상황이나 천재지변, 택배사 사정 등에 의해 배송 일정이 일부 변경될 수 있습니다.
            추가 문의사항이 있으신 경우 Yogibo 고객센터로 문의해주세요.`,
            videoHtml: null,
            description: null,
            imageUrl: null
          };
        }
      } catch (error) {
        return { text: "고객님의 주문 정보를 찾을 수 없습니다. 주문 여부를 확인해주세요." };
      }
    } else {
      return { 
        text: `배송은 제품 출고 후 1~3 영업일 정도 소요되며, 제품별 출고 시 소요되는 기간은 아래 내용을 확인해주세요.
        - 소파 및 바디필로우: 주문 확인 후 제작되는 제품으로, 3~7 영업일 이내에 출고됩니다.
        - 모듀(모듈러) 소파: 주문 확인일로부터 1~3 영업일 이내에 출고됩니다.
        - 그 외 제품: 주문 확인일로부터 1~3 영업일 이내에 출고됩니다.
        일부 제품은 오후 1시 이전에 구매를 마쳐주시면 당일 출고될 수 있어요.
        개별 배송되는 제품을 여러 개 구매하신 경우 제품이 여러 차례로 나눠 배송될 수 있습니다.
        주문 폭주 및 재난 상황이나 천재지변, 택배사 사정 등에 의해 배송 일정이 일부 변경될 수 있습니다.
        추가 문의사항이 있으신 경우 Yogibo 고객센터로 문의해주세요.`,
        videoHtml: null,
        description: null,
        imageUrl: null
      };
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

// ========== [Chat 요청 처리] ==========
app.post("/chat", async (req, res) => {
  const userInput = req.body.message;
  const memberId = req.body.memberId;

  if (!userInput) {
    return res.status(400).json({ error: "Message is required." });
  }

  try {
    const normalizedInput = normalizeSentence(userInput);

    let responseText;

    // 👉 FAQ, 주문/배송, PostIt 기반 응답 시도
    const answer = await findAnswer(normalizedInput, memberId);

    // fallback 응답일 경우 GPT 호출
    if (answer?.text === "질문을 이해하지 못했어요. 좀더 자세히 입력 해주시겠어요") {
      const gptText = await getGPT3TurboResponse(userInput);
      responseText = {
        text: gptText,
        videoHtml: null,
        description: null,
        imageUrl: null
      };
    } else {
      responseText = answer;
    }

    // 내 아이디 요청은 로그 저장 안함
    if (normalizedInput !== "내 아이디") {
      await saveConversationLog(memberId, userInput, responseText.text);
    }

    return res.json(responseText);

  } catch (error) {
    console.error("/chat 처리 중 오류:", error);
    return res.status(500).json({
      text: "질문을 이해하지 못했어요. 좀더 자세히 입력 해주시겠어요",
      videoHtml: null,
      description: null,
      imageUrl: null
    });
  }
});


// ========== [13] 대화 내용 Excel 다운로드 라우팅 ==========
app.get('/chatConnet', async (req, res) => {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection("conversationLogs");
    const data = await collection.find({}).toArray();

    // 새로운 Excel 워크북과 워크시트 생성
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('ConversationList');

    // 워크시트 컬럼 헤더 설정
    worksheet.columns = [
      { header: '회원아이디', key: 'memberId', width: 15 },
      { header: '날짜', key: 'date', width: 15 },
      { header: '대화내용', key: 'conversation', width: 50 },
    ];

    // 각 문서마다 한 행씩 추가 (conversation 배열은 JSON 문자열로 변환)
    data.forEach(doc => {
      worksheet.addRow({
        memberId: doc.memberId || '비회원',
        date: doc.date,
        conversation: JSON.stringify(doc.conversation, null, 2)
      });
    });

    // 응답 헤더 설정 후 워크북을 스트림으로 전송 (Excel 다운로드)
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", "attachment; filename=conversationLogs.xlsx");

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Excel 파일 생성 중 오류:", error.message);
    res.status(500).send("Excel 파일 생성 중 오류가 발생했습니다.");
  } finally {
    await client.close();
  }
});


// ========== [14] 포스트잇 노트 CRUD ==========
function convertHashtagsToLinks(text) {
  const hashtagLinks = {
    '홈페이지': 'https://yogibo.kr/',
    '매장': 'https://yogibo.kr/why/store.html',
    '카카오플친':'http://pf.kakao.com/_lxmZsxj/chat',
    '네이버톡톡':'https://talk.naver.com/ct/wc4u67?frm=psf'
  };
  return text.replace(/@([\w가-힣]+)/g, (match, keyword) => {
    const url = hashtagLinks[keyword];
    // 반환 시 keyword만 사용하여 '@' 제거
    return `<a href="${url}" target="_blank">${keyword}</a>`;
  });
}

app.get("/postIt", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const PAGE_SIZE = 300;
  const category = req.query.category;
  const queryFilter = category ? { category } : {};

  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection("postItNotes");
    const totalCount = await collection.countDocuments(queryFilter);
    const totalPages = Math.ceil(totalCount / PAGE_SIZE);
    let currentPage = page;
    if (currentPage < 1) currentPage = 1;
    if (totalPages > 0 && currentPage > totalPages) currentPage = totalPages;
    const skipCount = (currentPage - 1) * PAGE_SIZE;
    const notes = await collection
      .find(queryFilter)
      .sort({ _id: -1 })
      .skip(skipCount)
      .limit(PAGE_SIZE)
      .toArray();
    notes.forEach(doc => {
      doc._id = doc._id.toString();
    });
    await client.close();
    return res.json({
      notes,
      currentPage,
      totalPages,
      totalCount,
      pageSize: PAGE_SIZE
    });
  } catch (error) {
    console.error("GET /postIt 오류:", error.message);
    return res.status(500).json({ error: "포스트잇 목록 조회 중 오류가 발생했습니다." });
  }
});

app.post("/postIt", async (req, res) => {
  const { question, answer, category } = req.body;
  if (!question && !answer) {
    return res.status(400).json({ error: "질문 또는 답변이 비어있습니다." });
  }

  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection("postItNotes");

    const convertedAnswer = answer ? convertHashtagsToLinks(answer) : answer;
    const newNote = {
      question,
      answer: convertedAnswer,
      category: category || "uncategorized",
      createdAt: new Date()
    };

    await collection.insertOne(newNote);
    await client.close();

    // ✅ 프롬프트 즉시 갱신
    combinedSystemPrompt = await initializeChatPrompt();

    return res.json({
      message: "포스트잇 등록 성공 및 프롬프트 갱신 완료 ✅",
      note: newNote
    });
  } catch (error) {
    console.error("POST /postIt 오류:", error.message);
    return res.status(500).json({ error: "포스트잇 등록 중 오류가 발생했습니다." });
  }
});

app.put("/postIt/:id", async (req, res) => {
  try {
    const noteId = req.params.id;
    const { question, answer, category } = req.body;
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection("postItNotes");

    const filter = { _id: new ObjectId(noteId) };
    const updateData = {
      ...(question && { question }),
      ...(answer && { answer: convertHashtagsToLinks(answer) }),
      ...(category && { category }),
      updatedAt: new Date()
    };

    const result = await collection.findOneAndUpdate(
      filter,
      { $set: updateData },
      { returnDocument: "after" }
    );
    await client.close();

    if (!result.value) {
      return res.status(404).json({ error: "해당 포스트잇을 찾을 수 없습니다." });
    }

    // ✅ 프롬프트 즉시 갱신
    combinedSystemPrompt = await initializeChatPrompt();

    return res.json({
      message: "포스트잇 수정 성공 및 프롬프트 갱신 완료 ✅",
      note: result.value
    });
  } catch (error) {
    console.error("PUT /postIt 오류:", error.message);
    return res.status(500).json({ error: "포스트잇 수정 중 오류가 발생했습니다." });
  }
});


app.delete("/postIt/:id", async (req, res) => {
  const noteId = req.params.id;
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection("postItNotes");
    const { ObjectId } = require("mongodb");
    const filter = { _id: new ObjectId(noteId) };
    const result = await collection.deleteOne(filter);
    await client.close();
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "삭제할 포스트잇을 찾지 못했습니다." });
    }
    return res.json({ message: "포스트잇 삭제 성공" });
  } catch (error) {
    console.error("DELETE /postIt 오류:", error.message);
    return res.status(500).json({ error: "포스트잇 삭제 중 오류가 발생했습니다." });
  }
});



//=========nodemailer =//
const multer    = require('multer');  
// Multer 설정: uploads/ 디렉토리에 원본 파일명으로 저장

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      cb(null, path.join(__dirname, 'uploads'));
    },
    filename(req, file, cb) {
      cb(null, `${Date.now()}_${file.originalname}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 최대 5MB
});

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}


// Nodemailer transporter
const transporter = nodemailer.createTransport({
  host:    process.env.SMTP_HOST,
  port:    Number(process.env.SMTP_PORT),
  secure:  process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// (선택) 연결 확인
transporter.verify(err => {
  if (err) console.error('SMTP 연결 실패:', err);
  else     console.log('SMTP 연결 성공');
});

// 파일 + 폼 데이터를 다 받는 엔드포인트
app.post(
  '/send-email',
  upload.single('attachment'),   // React에서 FormData.append('attachment', file) 로 보냄
  async (req, res) => {
    try {
      // 프론트에서 보내는 필드 이름과 일치시킵니다.
      const { companyEmail, companyName, message } = req.body;
      if (!companyEmail) {
        return res.status(400).json({ error: 'Company Email이 필요합니다.' });
      }

      // 첨부파일이 있으면 attachments 배열에 추가
      const attachments = [];
      if (req.file) {
        attachments.push({
          filename: req.file.originalname,
          path:     req.file.path,
        });
      }

      // 메일 옵션 구성
      const mailOptions = {
        from: {
          name:    companyName,          // 보이는 이름
          address: process.env.SMTP_USER // 실제 보내는 주소
        },
        to:   'contact@yogico.kr',       // 받는 사람
        replyTo: companyEmail,            // 답장 시 사용될 이메일
        subject: `Contact 요청: ${companyName || companyEmail}`,
        text:
          `Company Email: ${companyEmail}\n` +
          `Company Name:  ${companyName}\n\n` +
          `Message:\n${message}`,
        html:
          `<h2>새 Contact 요청</h2>` +
          `<p><strong>Company Email:</strong> ${companyEmail}</p>` +
          `<p><strong>Company Name:</strong> ${companyName}</p>` +
          `<hr/>` +
          `<p>${message.replace(/\n/g, '<br/>')}</p>`,
        attachments
      };

      // 메일 전송
      const info = await transporter.sendMail(mailOptions);
      return res.json({ success: true, messageId: info.messageId });
    } catch (error) {
      console.error('메일 전송 오류:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);



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






/**🎁 블랙프라이데이 확률 기반 이벤트 참여 API**/

async function initializeEventData() {
  const client = new MongoClient(MONGODB_URI);
  console.log("🟡 블랙프라이데이 이벤트 데이터 확인 중...");

  try {
      await client.connect();
      const db = client.db(DB_NAME);
      const eventConfigsCollection = db.collection('eventBlackF');

      // 컬렉션에 데이터가 하나라도 있는지 확인합니다.
      const count = await eventConfigsCollection.countDocuments();

      if (count > 0) {
          // 데이터가 이미 있으면 아무것도 하지 않고 종료합니다.
          console.log("✅ 이벤트 데이터가 이미 존재합니다. 초기화를 건너뜁니다.");
      } else {
          // 데이터가 없으면, 기본 데이터를 삽입합니다.
          console.log("⚠️ 이벤트 데이터가 없습니다. 3주치 기본 데이터를 생성합니다...");

          const initialEventData = [
            {
              "week": 1,
              "startDate": new Date("2025-11-09T15:00:00.000Z"), // KST: 2025-11-03 00:00
              "endDate": new Date("2025-11-16T14:59:59.999Z"),   // KST: 2025-11-09 23:59
              "probabilities": { "day1_4": 0.0001, "day5_6": 0.05 },
              "day7NthWinner": 100,
              "winner": { "userId": null, "winDate": null },
              "winnerUrl": "https://yogibo.kr/surl/P/2478"
            },
            {
              "week": 2,
              "startDate": new Date("2025-11-16T15:00:00.000Z"), // KST: 2025-11-10 00:00
              "endDate": new Date("2025-11-23T14:59:59.999Z"),   // KST: 2025-11-16 23:59
              "probabilities": { "day1_4": 0.000005, "day5_6": 0.000005 },
              "day7NthWinner": 100,
              "winner": { "userId": null, "winDate": null },
              "winnerUrl": "https://yogibo.kr/surl/P/2479"
            },
            {
              "week": 3,
              "startDate": new Date("2025-11-23T15:00:00.000Z"), // KST: 2025-11-17 00:00
              "endDate": new Date("2025-11-30T14:59:59.999Z"),   // KST: 2025-11-23 23:59
              "probabilities": { "day1_4": 0.0001, "day5_6": 0.05 },
              "day7NthWinner": 100,
              "winner": { "userId": null, "winDate": null },
              "winnerUrl": "https://yogibo.kr/surl/P/2480"
            }
          ];

          await eventConfigsCollection.insertMany(initialEventData);
          console.log("✅ 이벤트 기본 데이터가 DB에 성공적으로 저장되었습니다.");
      }
  } catch (error) {
      console.error("❌ 이벤트 데이터 초기화 중 오류 발생:", error);
  } finally {
      await client.close();
  }
}

async function ensureIndexes() {
  const client = new MongoClient(MONGODB_URI);
  console.log("🟡 DB 인덱스(중복 방지 규칙) 확인 및 적용 중...");

  try {
      await client.connect();
      const db = client.db(DB_NAME);
      const participantsCollection = db.collection('eventBlackEntry'); // 정확한 컬렉션 이름

      // 이게 핵심: { eventWeek: 1, userId: 1 } 조합을 unique로 만듦
      await participantsCollection.createIndex(
          { "eventWeek": 1, "userId": 1 },
          { "unique": true }
      );
      console.log("✅ 'eventBlackEntry' 컬렉션에 중복 방지 규칙(Unique Index)이 적용되었습니다.");

  } catch (error) {
      // 만약 1단계(데이터 삭제)를 건너뛰어서 DB에 이미 중복 데이터가 있다면 이 에러가 발생합니다.
      if (error.code === 11000) {
          console.error("❌ [심각한 오류] DB에 이미 중복 데이터가 있어 중복 방지 규칙을 만들 수 없습니다!");
          console.error("❌ [조치 필요] 'eventBlackEntry' 컬렉션의 중복 데이터를 모두 삭제한 후 서버를 재시작하세요!");
      } else {
          console.error("❌ 인덱스 생성 중 오류 발생:", error.message);
      }
  } finally {
      await client.close();
  }
}
/**
 * 🎁 [수정] 이벤트 참여 상태 '확인' API (읽기 전용)
 * [GET] /api/event/status?userId=...
 * '진행 전', '참여 가능', '참여 완료', '종료'를 구분하여 반환
 */
app.get('/api/event/status', async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
      return res.json({ status: 'not_running' }); // ID가 없으면 '실행중 아님'으로 간주
  }

  const client = new MongoClient(MONGODB_URI);
  try {
      await client.connect();
      const db = client.db(DB_NAME);
      const eventConfigsCollection = db.collection('eventBlackF');
      const participantsCollection = db.collection('eventBlackEntry');

      const now = new Date();

      // 1. 현재 진행 중인 이벤트가 있는지 확인
      const currentEvent = await eventConfigsCollection.findOne({
          startDate: { $lte: now },
          endDate: { $gte: now }
      });

      if (currentEvent) {
          // 2. 이벤트 진행 중 -> '이번 주' 참여 이력 확인
          const currentWeekRecord = await participantsCollection.findOne({
              eventWeek: currentEvent.week,
              userId: userId
          });

          if (currentWeekRecord) {
              // '이번 주'에 이미 참여함
              return res.json({
                  status: 'participated',
                  result: currentWeekRecord.result,
                  week: currentEvent.week,
                  url: currentWeekRecord.result === 'win' ? currentEvent.winnerUrl : null
              });
          } else {
              // '이번 주' 참여 가능
              return res.json({ 
                  status: 'not_participated',
                  week: currentEvent.week 
              });
          }
      }
      
      // 3. 진행 중인 이벤트 없음 -> '진행 전'인지 '종료'인지 확인
      //    (DB에서 1주차 데이터를 찾음)
      const firstEvent = await eventConfigsCollection.findOne({ week: 1 });
      if (firstEvent && now < firstEvent.startDate) {
          // ⭐ [핵심] 1주차 시작일보다 현재가 빠르면 '진행 전'
          return res.json({ status: 'not_started_yet', message: '아직 이벤트 진행전입니다.' });
      }

      // 4. 1주차 시작일이 지났는데도 진행 중 이벤트가 없으면 '종료'
      return res.json({ status: 'not_running', message: '이벤트가 종료되었습니다.' });

  } catch (error) {
      console.error('이벤트 상태 확인 중 오류:', error);
      res.status(500).json({ status: 'error', message: '서버 오류' });
  } finally {
      await client.close();
  }
});

/**
 * 🎁 [수정] 블랙프라이데이 확률 기반 이벤트 참여 API
 * [POST] /api/event/check
 */
app.post('/api/event/check', async (req, res) => {
  const { userId } = req.body;
  if (!userId) {
      return res.status(400).json({ error: '회원 아이디(userId)가 필요합니다.' });
  }

  const client = new MongoClient(MONGODB_URI);

  try {
      await client.connect();
      const db = client.db(DB_NAME);
      
      const eventConfigsCollection = db.collection('eventBlackF'); 
      const participantsCollection = db.collection('eventBlackEntry'); 
      
      const now = new Date();

      // 1. 현재 날짜에 해당하는 이벤트 주차 정보 찾기
      const currentEvent = await eventConfigsCollection.findOne({
          startDate: { $lte: now },
          endDate: { $gte: now }
      });

      if (!currentEvent) {
          // 2. [수정] 진행 중인 이벤트가 없을 때, '진행 전'인지 확인
          const firstEvent = await eventConfigsCollection.findOne({ week: 1 });
          if (firstEvent && now < firstEvent.startDate) {
              return res.status(404).json({ message: '아직 이벤트 진행전입니다.' });
          }
          // 그 외에는 '종료'로 간주
          return res.status(404).json({ message: '이벤트가 종료되었습니다.' });
      }
      
      // --- 이하 로직은 동일 ---
      
      // 2. 해당 주차에 이미 당첨자가 나왔는지 먼저 확인
      if (currentEvent.winner && currentEvent.winner.userId) {
          await participantsCollection.insertOne({
              eventWeek: currentEvent.week,
              userId: userId,
              participationDate: new Date(),
              result: 'lose'
          }).catch(err => { /* 중복 무시 */ });
          return res.json({ result: 'lose', week: currentEvent.week, url: null });
      }

      // 3. (당첨자가 없는 경우) 이번 주에 이미 참여했는지 확인
      const existingParticipant = await participantsCollection.findOne({
          eventWeek: currentEvent.week,
          userId: userId
      });

      if (existingParticipant) {
          return res.status(409).json({ message: '이번 주 이벤트에 이미 참여하셨습니다.' });
      }

      // 4. 이벤트 경과일 계산
      const dayDifference = Math.floor((now - new Date(currentEvent.startDate)) / (1000 * 60 * 60 * 24)) + 1;
      let isWinner = false;

      // 5. 당첨 로직 적용
      if (dayDifference === 7) {
          const todayKST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
          const todayStart = new Date(todayKST);
          todayStart.setHours(0, 0, 0, 0);
          const todayEnd = new Date(todayKST);
          todayEnd.setHours(23, 59, 59, 999);
          
          const todayParticipantCount = await participantsCollection.countDocuments({
              eventWeek: currentEvent.week,
              participationDate: { $gte: todayStart, $lte: todayEnd }
          });

          if (todayParticipantCount === currentEvent.day7NthWinner - 1) { isWinner = true; }
      } else {
          let probability = (dayDifference <= 4) ? currentEvent.probabilities.day1_4 : currentEvent.probabilities.day5_6;
          isWinner = Math.random() < probability;
      }

      // 6. 참여 결과 DB에 기록
      await participantsCollection.insertOne({
          eventWeek: currentEvent.week,
          userId: userId,
          participationDate: new Date(),
          result: isWinner ? 'win' : 'lose'
      });

      // 7. 당첨 시, 당첨자 정보 기록
      if (isWinner) {
          await eventConfigsCollection.updateOne(
              { _id: currentEvent._id },
              { $set: { 'winner.userId': userId, 'winner.winDate': new Date() } }
          );
      }

      // 8. 최종 결과 전송
      res.json({ 
          result: isWinner ? 'win' : 'lose', 
          week: currentEvent.week,
          url: isWinner ? currentEvent.winnerUrl : null
      });

  } catch (error) {
      if (error.code === 11000) {
          return res.status(409).json({ message: '이번 주 이벤트에 이미 참여하셨습니다.' });
      }
      console.error('이벤트 참여 처리 중 오류 발생:', error);
      res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
  } finally {
      await client.close();
  }
});

/**
 * 🛡️ [수정] 당첨자 본인 확인 API
 * [GET] /api/event/check-page-access?userId=...&objectId=...
 */
app.get('/api/event/check-page-access', async (req, res) => {
  const { userId, objectId } = req.query; // 프론트에서 보낸 memberId가 여기 userId로 들어옵니다.

  // 1. 필수 값 체크
  if (!userId || !objectId) {
      return res.json({ canAccess: false });
  }

  const client = new MongoClient(MONGODB_URI);
  try {
      await client.connect();
      const db = client.db(DB_NAME);
      const eventConfigsCollection = db.collection('eventBlackF');

      // 2. DB에서 해당 주차의 당첨 데이터를 가져옵니다.
      const eventData = await eventConfigsCollection.findOne({ 
          _id: new ObjectId(objectId) 
      });

      // 3. [핵심 비교 로직]
      // DB에 있는 당첨자(winner.userId) === 현재 접속한 사람(userId) 인지 확인
      if (eventData && eventData.winner && eventData.winner.userId === userId) {
          console.log(`✅ 당첨자 확인 성공! (접속자: ${userId})`);
          return res.json({ canAccess: true });
      } else {
          console.log(`🚫 접근 차단 (접속자: ${userId} / 실제 당첨자: ${eventData?.winner?.userId})`);
          return res.json({ canAccess: false });
      }

  } catch (error) {
      console.error('검증 오류:', error);
      res.status(500).json({ canAccess: false, error: '서버 오류' });
  } finally {
      await client.close();
  }
});


/**
 * [HELPER] 날짜 객체를 KST 문자열(YYYY. MM. DD. 오후 H:mm:ss)로 변환
 */
function formatKST(date) {
  if (!date) return '';
  return new Date(date).toLocaleString('ko-KR', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true // '오전/오후' 형식 사용
  });
}

/**
* 🎁 [추가] 블랙프라이데이 이벤트 참여자 엑셀 다운로드 API
* [GET] /api/event/download
*/
app.get('/api/event/download', async (req, res) => {
  const client = new MongoClient(MONGODB_URI);

  try {
      await client.connect();
      const db = client.db(DB_NAME);
      const participantsCollection = db.collection('eventBlackEntry');

      // 1. DB에서 모든 참여자 데이터를 가져옵니다 (최신순 정렬)
      const allParticipants = await participantsCollection.find({}).sort({ participationDate: -1 }).toArray();

      // 2. Excel 워크북 및 워크시트 생성
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('블랙프라이데이 참여자');

      // 3. 엑셀 컬럼 설정 (요청사항 반영)
      worksheet.columns = [
          { header: '참여날짜', key: 'kstDate', width: 25 },
          { header: '고객아이디', key: 'userId', width: 30 },
          { header: '당첨여부', key: 'resultText', width: 15 }
      ];

      // 4. 데이터를 순회하며 엑셀 행 추가
      allParticipants.forEach(doc => {
          worksheet.addRow({
              // participationDate (UTC)를 한국 시간(KST) 문자열로 변환
              kstDate: formatKST(doc.participationDate), 
              userId: doc.userId,
              // 'win' -> '성공', 'lose' -> '탈락'
              resultText: doc.result === 'win' ? '성공' : '탈락' 
          });
      });

      // 5. 엑셀 파일로 응답 전송
      res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
          'Content-Disposition',
          'attachment; filename="BlackFriday_Participants.xlsx"'
      );

      await workbook.xlsx.write(res);
      res.end();

  } catch (error) {
      console.error('엑셀 다운로드 생성 중 오류:', error);
      res.status(500).json({ error: '엑셀 파일 생성 중 오류가 발생했습니다.' });
  } finally {
      await client.close();
  }
});

// 중복 제거 ip중복  입력 유입 



//실시간 판매 데이터 로직 추가하기
// ========== [블랙 프라이데이 누적 매출 로직] ==========

// ⬇️ [수정 1] 온라인 매출 집계 시작일을 '2025-11-10'로 변경
const EVENT_START_DATE = '2025-11-08'; // 🎁 온라인 매출 집계 시작일
const SALES_STATUS_DB = 'blackSalesStatus'; // ⭐️ 온라인/오프라인 상태 통합 저장 컬렉션
const OFFLINE_TARGET_DB = 'blackOffData'; // 일별 오프라인 '목표액' 저장 컬렉션

// 🎁 오프라인 연출용 증분 리스트 (가중치 부여)
const OFFLINE_INCREMENTS = [
  311200, 35040, 23840, 255200, 263200, 143200, 215200, 135200, 136200,
  14240, // <- 기본 1개
  14240, 14240, 14240, 14240, 14240, 14240, 14240, 14240, 14240, 14240 // <- 10개 추가
];

// ⬇️ [수정 2] 오프라인 특별 첫날 설정을 '11월 10일' 00:00 ~ 10:00 KST로 변경
const SPECIAL_DAY_CONFIG = {
  // 2025년 11월 10일 00:00:00 KST (UTC: 11/09 15:00)
  startUTC: Date.UTC(2025, 10, 9, 15, 0, 0),
  // 2025년 11월 10일 10:00:00 KST (UTC: 11/10 01:00)
  endUTC: Date.UTC(2025, 10, 10, 1, 0, 0),
  target: 30000000 // 목표액 3,000만원
};

/**
 * [초기화] 'blackOffData' 컬렉션에 오프라인 목표액 데이터를 'Upsert'
 */
async function initializeOfflineSalesData() {
  console.log("🟡 오프라인 일일 매출 목표 데이터 확인 및 초기화 중...");

  // ⬇️ [수정 3] 이벤트가 10일부터 시작하므로, 7, 8, 9일 데이터는 불필요 (삭제 또는 0원)
  const offlineSalesData = [
    // (11/5, 6, 7, 8, 9일 데이터는 0원이므로 생략)
    { "dateString": "2025-11-10", "targetAmount": 37204660 }, // 11/10 10:00 ~ 11/11 10:00 목표
    { "dateString": "2025-11-11", "targetAmount": 9632530 },
    { "dateString": "2025-11-12", "targetAmount": 11561770 },
    { "dateString": "2025-11-13", "targetAmount": 5114950 },
    { "dateString": "2025-11-14", "targetAmount": 8659800 },
    { "dateString": "2025-11-15", "targetAmount": 10000000 },
    { "dateString": "2025-11-16", "targetAmount": 10000000 },
    { "dateString": "2025-11-17", "targetAmount": 12266780 },
    { "dateString": "2025-11-18", "targetAmount": 8785110 },
    { "dateString": "2025-11-19", "targetAmount": 13078460 },
    { "dateString": "2025-11-20", "targetAmount": 4172020},
    { "dateString": "2025-11-21", "targetAmount": 5300000 },
    { "dateString": "2025-11-22", "targetAmount": 5300000 },
    { "dateString": "2025-11-23", "targetAmount": 5300000 },
    { "dateString": "2025-11-24", "targetAmount": 5300000 },
    { "dateString": "2025-11-25", "targetAmount": 5300000 },
    { "dateString": "2025-11-26", "targetAmount": 5300000 },
    { "dateString": "2025-11-27", "targetAmount": 5300000 },
    { "dateString": "2025-11-28", "targetAmount": 5300000 },
    { "dateString": "2025-11-29", "targetAmount": 5300000 },
    { "dateString": "2025-11-30", "targetAmount": 5300000 },
  ];

  if (offlineSalesData.length === 0) {
    console.log("ℹ️ 오프라인 매출 데이터가 정의되지 않았습니다. 건너뜁니다.");
    return;
  }

  try {
    const results = await runDb(async (db) => {
      const collection = db.collection(OFFLINE_TARGET_DB); // 'blackOffData'
      await collection.createIndex({ "dateString": 1 }, { "unique": true });

      const bulkOps = offlineSalesData.map(item => ({
        updateOne: {
          filter: { dateString: item.dateString }, 
          update: { $setOnInsert: { dateString: item.dateString, targetAmount: item.targetAmount } },
          upsert: true 
        }
      }));
      return await collection.bulkWrite(bulkOps);
    });
    console.log(`✅ 오프라인 매출 데이터 초기화 완료. (신규 ${results.upsertedCount}건, 기존 ${results.matchedCount}건)`);
  
  } catch (error) {
    if (error.code === 11000) { console.log("ℹ️ 오프라인 매출 데이터가 이미 존재합니다. (정상)"); }
    else { console.error("❌ 오프라인 매출 데이터 초기화 중 심각한 오류:", error.message); }
  }
}

/**
 * [HELPER] KST Date 객체를 'YYYY-MM-DD' 문자열로 변환
 */
function toDateString(kstDate) {
  return kstDate.toISOString().split('T')[0]; // YYYY-MM-DD
}

/**
 * [스케줄러 1: 온라인] Cafe24 API에서 '결제완료(N40)'된 모든 주문을 집계
 */
async function updateOnlineSales() {
  console.log('🔄 [온라인 스케줄러] Cafe24 매출 집계를 시작합니다...');
  
  let totalSales = 0, totalOrders = 0, offset = 0;
  const limit = 1000;
  const kstNow = new Date(new Date().getTime() + (9 * 60 * 60 * 1000));
  const today = toDateString(kstNow);

  try {
    const cafe24Url = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`;
    while (true) {
      const response = await apiRequest('GET', cafe24Url, {}, {
          shop_no: 1, order_status: 'N10,N20,N30,N40',
          start_date: EVENT_START_DATE, // '2025-11-10'부터 집계
          end_date: today,
          limit: limit, offset: offset
      });
      const orders = response.orders;
      if (!orders || orders.length === 0) break;

      for (const order of orders) {
        totalSales += parseFloat(order.payment_amount) || 0;
      }
      totalOrders += orders.length;
      offset += orders.length;
    }

    await runDb(async (db) => {
      const collection = db.collection(SALES_STATUS_DB);
      await collection.updateOne(
        { _id: 'blackFriday2025' },
        { $set: { totalOnlineSales: totalSales, onlineLastCheck: new Date() }, $setOnInsert: { _id: 'blackFriday2025' } },
        { upsert: true }
      );
    });
    console.log(`✅ [온라인 스케줄러] 집계 완료. 총액: ${totalSales} (주문 ${totalOrders}건)`);
  } catch (error) {
    console.error('❌ [온라인 스케줄러] 오류:', error.message);
  }
}

/**
 * [스케줄러 시작] (단수형) 온라인 스케줄러만 등록
 */
function startSalesScheduler() {
  console.log('⏰ [온라인 스케줄러] 10분 주기로 시작합니다.');
  cron.schedule('*/10 * * * *', updateOnlineSales);
  // updateOnlineSales(); // 테스트용 즉시 실행
}
/**
 * 💰 [API] 누적 판매 금액 조회 API
 * [수정됨] 하이브리드 방식:
 * (1) 시간 퍼센트로 '목표 상한선(ceiling)'을 계산
 * (2) 50% 확률로 (가중치 적용된) 랜덤 증분액을 더함
 * (3) [버그 수정] 랜덤 증분액이 상한선을 넘지 않을 때만 DB에 저장 (점프/리셋 방지)
 */
app.get('/api/total-sales', async (req, res) => {
  try {
    const { totalOnlineSales, totalOfflineSales } = await runDb(async (db) => {
      
      const statsCollection = db.collection(SALES_STATUS_DB); 
      const targetsCollection = db.collection(OFFLINE_TARGET_DB);
      
      const stat = await statsCollection.findOne({ _id: 'blackFriday2025' });
      const totalOnlineSales = stat ? stat.totalOnlineSales : 0;

      // --- [하이브리드 오프라인 계산 로직] ---
      
      const allTargets = await targetsCollection.find({}).sort({ dateString: 1 }).toArray();
      const nowUTC = new Date().getTime();
      let totalOfflineBase = 0; // (A) 과거 사이클 총합
      let currentTargetCeiling = 0; // (B) 현재 시간 기준 목표액 (상한선)

      // 2. (오프라인) "11-10" 이전 날짜 목표액 합산
      const pastTargets = allTargets.filter(d => d.dateString < "2025-11-10");
      for (const doc of pastTargets) {
        totalOfflineBase += doc.targetAmount;
      }

      // 3. (오프라인) "특별 첫날" (11-10 00:00 ~ 10:00) 계산
      const specialStart = SPECIAL_DAY_CONFIG.startUTC;
      const specialEnd = SPECIAL_DAY_CONFIG.endUTC;
      const specialTarget = SPECIAL_DAY_CONFIG.target; // 3000만

      if (nowUTC >= specialEnd) {
        totalOfflineBase += specialTarget; // 10시 지남: (A)에 3000만 전액 더함
      } else if (nowUTC >= specialStart && nowUTC < specialEnd) {
        // 00시 ~ 10시 사이: (B) 현재 목표 상한선 계산
        const elapsed = nowUTC - specialStart;
        const totalDuration = specialEnd - specialStart; 
        const percentage = elapsed / totalDuration;
        currentTargetCeiling = Math.floor(specialTarget * percentage);
      }
      
      // 4. (오프라인) "일반" (10:00 ~ 10:00) 사이클 계산 (10시가 지났을 경우)
      let currentCycleStart = SPECIAL_DAY_CONFIG.endUTC; 
      const dayDuration = 24 * 60 * 60 * 1000; 

      if (nowUTC >= currentCycleStart) { // 11/10 10:00 KST 이후
        const generalTargets = allTargets.filter(d => d.dateString >= "2025-11-10");
        
        for (const doc of generalTargets) {
          const cycleTarget = doc.targetAmount;
          const cycleEnd = currentCycleStart + dayDuration;

          if (nowUTC >= cycleEnd) {
            totalOfflineBase += cycleTarget; // (A)에 전액 더함
          } else if (nowUTC >= currentCycleStart && nowUTC < cycleEnd) {
            // 현재 이 사이클(24시간)이 진행 중이면:
            const elapsed = nowUTC - currentCycleStart;
            const percentage = elapsed / dayDuration;
            currentTargetCeiling = Math.floor(cycleTarget * percentage); // (B) 갱신
            break; 
          }
          currentCycleStart = cycleEnd;
        }
      }
      
      // 5. [연출] 50% 확률로 랜덤 증분액 더하기
      let stagedAmount = (stat && stat.lastStagedAmount) ? stat.lastStagedAmount : 0;
      
      // (A) 아직 사이클 시작 전이면(e.g. 11/9) 연출금액 0
      if (nowUTC < specialStart) {
         stagedAmount = 0; 
      } 
      // (B) 사이클이 시작되었고, 50% 확률이 터졌다면
      else if (Math.random() < 0.5) { 
        
        const randomAmount = OFFLINE_INCREMENTS[Math.floor(Math.random() * OFFLINE_INCREMENTS.length)];
        const newAmount = stagedAmount + randomAmount;
        
        // 6. [핵심 수정] 새 금액(newAmount)이 "시간 상한선(Ceiling)"보다 *작거나 같을 때만* 갱신
        if (newAmount <= currentTargetCeiling) {
            stagedAmount = newAmount;
        }
        // (만약 상한선을 넘으면? 아무것도 안 함. -> stagedAmount는 이전 값을 유지 (동결))
      }
      
      // 7. DB에 현재 연출된 금액을 저장
      // (주의: stat이 null일 경우를 대비해 $setOnInsert 추가)
      await statsCollection.updateOne(
        { _id: 'blackFriday2025' },
        { 
          $set: { lastStagedAmount: stagedAmount },
          $setOnInsert: { _id: 'blackFriday2025', totalOnlineSales: 0 } 
        },
        { upsert: true }
      );
      
      // 8. 최종 오프라인 매출 = (A. 과거 총합) + (B. 현재 연출된 금액)
      const totalOfflineSales = totalOfflineBase + stagedAmount;
      
      // --- [계산 끝] ---

      return { totalOnlineSales, totalOfflineSales };
    });

    // 9. 최종 합계 반환
    res.json({
      totalSales: totalOnlineSales + totalOfflineSales,
      online: totalOnlineSales,
      offline: totalOfflineSales
    });

  } catch (error) {
    console.error('❌ /api/total-sales 오류:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});



/**
 * 시크릿 특가 클릭 데이터 추가 (POST) - [IP 차단/로깅 기능 추가됨]
 */
app.post('/api/log-secret-code', async (req, res) => {
  // ★ 1. [수정] 이 라우트에서 직접 DB에 연결합니다.
  const client = new MongoClient(MONGODB_URI);

  try {
    // ★ 2. [수정] DB 연결
    await client.connect();
    const db = client.db(DB_NAME);

    // ★ 5. [신규] 클라이언트 IP 확인 (Cloudtype/프록시 환경 대응)
    const clientIp = req.headers['x-forwarded-for']?.split(',').shift() || req.connection.remoteAddress;

    const BLOCKED_IPS = [
      '61.99.75.10' // 요청하신 차단 IP
      // '123.45.67.89' // 다른 IP 추가 시
    ];
    // ★ 6. [신규] IP 차단 로직
    if (BLOCKED_IPS.includes(clientIp)) {
      // 차단된 IP는 로그를 남기지 않고 즉시 403 (Forbidden) 반환
      return res.status(403).json({ success: false, message: 'Access Denied.' });
    }

    // ★ 7. 'db' 변수 검사 제거 (여기서 선언되었으므로)
    const eventSecretDataCollection = db.collection('eventSecretData');
    const { enteredCode, isSuccess } = req.body;

    if (typeof enteredCode === 'undefined' || typeof isSuccess === 'undefined') {
      // ★ [수정] 오류 시에도 client.close()가 finally에서 실행되도록 return만 함
      return res.status(400).json({ success: false, message: '필수 데이터가 누락되었습니다.' });
    }

    // ★ 8. [신규] 로그에 IP 주소도 함께 저장
    const logDocument = {
      enteredCode,
      isSuccess,
      timestamp: new Date(),
      clientIp: clientIp // IP 주소 기록
    };

    await eventSecretDataCollection.insertOne(logDocument);
    res.status(201).json({ success: true, message: '로그가 성공적으로 저장되었습니다.' });

  } catch (error) {
    console.error('시크릿 코드 로그 저장 중 오류:', error);
    res.status(500).json({ success: false, message: '서버 오류 발생' });
  } finally {
    // ★ 9. [추가] 성공하든 실패하든 항상 DB 연결을 닫습니다.
    await client.close();
  }
});


/**
 * 시크릿 특가 로그 전체 조회 (GET) - (상세 로그 확인용)
 */
app.get('/api/get-secret-logs', async (req, res) => {
  // ★ 1. [수정] 이 라우트에서 직접 DB에 연결합니다.
  const client = new MongoClient(MONGODB_URI);

  try {
    // ★ 2. [수정] DB 연결
    await client.connect();
    const db = client.db(DB_NAME);
    
    // ★ 3. 'db' 변수 검사 제거
    const eventSecretDataCollection = db.collection('eventSecretData');
    
    // [수정] 데이터가 많아질 경우를 대비해 최신 1000개만 조회
    const logs = await eventSecretDataCollection.find({}).sort({ timestamp: -1 }).limit(1000).toArray();
    
    res.status(200).json({ success: true, data: logs });

  } catch (error) {
    console.error('시크릿 코드 로그 조회 중 오류:', error);
    res.status(500).json({ success: false, message: '서버 오류 발생' });
  } finally {
    // ★ 4. [추가] 성공하든 실패하든 항상 DB 연결을 닫습니다.
    await client.close();
  }
});

/**
 * [신규] 시크릿 특가 로그 '일일 집계' (GET) - (요약 페이지용)
 */
app.get('/api/get-secret-logs/daily-summary', async (req, res) => {
  // ★ 1. [수정] 이 라우트에서 직접 DB에 연결합니다.
  const client = new MongoClient(MONGODB_URI);

  try {
    // ★ 2. [수정] DB 연결
    await client.connect();
    const db = client.db(DB_NAME);

    // ★ 3. 'db' 변수 검사 제거
    const eventSecretDataCollection = db.collection('eventSecretData');

    // MongoDB Aggregation Pipeline
    const dailyStats = await eventSecretDataCollection.aggregate([
      {
        // 1. 타임스탬프를 KST 기준 날짜 문자열로 변환
        $project: {
          kstDate: {
            $dateToString: {
              format: "%Y-%m-%d", // "YYYY-MM-DD"
              date: "$timestamp",
              timezone: "Asia/Seoul" // KST 기준
            }
          },
          isSuccess: "$isSuccess"
        }
      },
      {
        // 2. KST 날짜별로 그룹화
        $group: {
          _id: "$kstDate", // "YYYY-MM-DD"
          totalClicks: { $sum: 1 },
          totalSuccess: { $sum: { $cond: [ "$isSuccess", 1, 0 ] } }, // isSuccess: true
          totalFail: { $sum: { $cond: [ { $not: "$isSuccess" }, 1, 0 ] } } // isSuccess: false
        }
      },
      {
        // 3. 최신 날짜순으로 정렬
        $sort: { _id: -1 }
      },
      {
        // 4. 출력 형식 정리
        $project: {
          _id: 0,
          date: "$_id",
          totalClicks: 1,
          totalSuccess: 1,
          totalFail: 1
        }
      }
    ]).toArray();

    res.status(200).json({ success: true, data: dailyStats });

  } catch (error) {
    console.error('시크릿 코드 일일 집계 중 오류:', error);
    res.status(500).json({ success: false, message: '서버 오류 발생' });
  } finally {
    // ★ 4. [추가] 성공하든 실패하든 항상 DB 연결을 닫습니다.
    await client.close();
  }
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


