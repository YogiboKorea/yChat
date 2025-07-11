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
// ========== [서버 실행 및 프롬프트 초기화] ==========
(async function initialize() {
  try {
    console.log("🟡 서버 시작 중...");

    // 토큰 불러오기
    await getTokensFromDB();

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
