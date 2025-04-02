/******************************************************
 * server.js - JSON FAQ + 주문배송 로직 + ChatGPT fallback + 대화 로그 저장 (당일 대화 배열 업데이트)
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
const ExcelJS = require('exceljs');
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

// 원본 URL 문자열 (이미 "%20" 포함)
const rawKakaoUrl = "http://pf.%20kakao.%20com/_lxmZsxj/chat";
const rawNaverUrl = "https://talk.%20naver.%20com/ct/wc4u67?frm=psf";

// "%20" 문자열을 제거하여 올바른 URL로 변경
const kakaoUrl = rawKakaoUrl.replace(/%20/g, "");
const naverUrl = rawNaverUrl.replace(/%20/g, "");

console.log(kakaoUrl); // "http://pf.kakao.com/_lxmZsxj/chat"
console.log(naverUrl); // "https://talk.naver.com/ct/wc4u67?frm=psf"

// 이후 시스템 프롬프트에 이 URL을 사용
const YOGIBO_SYSTEM_PROMPT = `

1. 역할 및 말투  
전문가 역할: 요기보 브랜드에 대한 전문 지식을 가진 전문가로 행동합니다.  
존대 및 공손: 고객에게 항상 존댓말과 공손한 말투를 사용합니다.  
이모티콘 활용: 대화 중 적절히 이모티콘을 사용합니다.  
문단 띄어쓰기: 각 문단이 끝날 때마다 한 줄 이상의 공백을 넣어 가독성을 높여 주세요.

2. 고객 응대 지침  
정확한 답변: 웹상의 모든 요기보 관련 데이터를 숙지하고, 고객 문의에 대해 명확하고 이해하기 쉬운 답변을 제공해 주세요.  
아래 JSON 데이터는 참고용 포스트잇 Q&A 데이터입니다. 이 데이터를 참고하여 적절한 답변을 생성해 주세요.

3. 항상 모드 대화의 마지막엔 추가 궁금한 사항이 있으실 경우,  
<a href="${kakaoUrl}" target="_blank" rel="noopener noreferrer">카카오플친 연결하기</a>  
<a href="${naverUrl}" target="_blank" rel="noopener noreferrer">네이버톡톡 연결하기</a>  
라고 안내해 주세요.
`;

console.log(YOGIBO_SYSTEM_PROMPT);



// Express 앱
const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ========== [2] JSON 데이터 로드 (FAQ/제품 안내 등) ==========
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

// ========== [6] 기타 유틸 함수 ==========
function normalizeSentence(sentence) {
  return sentence
    .replace(/[?!！？]/g, "")
    .replace(/없나요/g, "없어요")
    .trim();
}

function containsOrderNumber(input) {
  return /\d{8}-\d{7}/.test(input);
}
async function getGPT3TurboResponse(userInput) {
  try {
    // (1) DB에서 포스트잇 Q/A 불러오기
    const allNotes = await getAllPostItQA();
    console.log("Retrieved post-it notes:", allNotes);

    // (2) 포스트잇 Q/A를 평문 텍스트 형식으로 변환 (최대 10개 노트만 사용)
    let postItContext = "\n아래는 참고용 포스트잇 질문/답변 데이터입니다:\n";
    if (!allNotes || allNotes.length === 0) {
      console.warn("No post-it notes found. Skipping post-it context.");
    } else {
      const maxNotes = 10;
      const notesToInclude = allNotes.slice(0, maxNotes);
      notesToInclude.forEach((note, i) => {
        // question과 answer가 모두 있는 경우에만 추가
        if (note.question && note.answer) {
          postItContext += `\nQ${i + 1}: ${note.question}\nA${i + 1}: ${note.answer}\n`;
        }
      });
    }

    // (3) 기존 YOGIBO_SYSTEM_PROMPT 뒤에 포스트잇 텍스트 데이터 추가
    const finalSystemPrompt = YOGIBO_SYSTEM_PROMPT + postItContext;
    console.log("Final system prompt length:", finalSystemPrompt.length);
    console.log("Final system prompt content:\n", finalSystemPrompt);

    // (4) GPT API 호출
    const response = await axios.post(
      OPEN_URL,
      {
        model: FINETUNED_MODEL,
        messages: [
          { role: "system", content: finalSystemPrompt },
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

    // (5) GPT 응답 처리
    const gptAnswer = response.data.choices[0].message.content;
    const formattedAnswer = addSpaceAfterPeriod(gptAnswer);
    return formattedAnswer;

  } catch (error) {
    console.error("Error calling OpenAI:", error.message);
    return "요기보 챗봇 오류가 발생했습니다. 다시 시도 부탁드립니다.";
  }
}




// 점(.) 뒤에 공백이 없는 경우 자동 추가하는 함수
function addSpaceAfterPeriod(text) {
  return text.replace(/\.([^\s])/g, '. $1');
}

// ========== [8] 대화 로그 저장 함수 (당일 동일 아이디 대화는 배열로 업데이트) ==========
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
      // 이미 당일 대화가 있으면 conversation 배열에 새 항목 추가
      await collection.updateOne(query, { $push: { conversation: logEntry } });
      console.log("대화 로그 업데이트 성공");
    } else {
      // 당일 대화가 없으면 새 문서 생성
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

// ========== [9] 메인 로직: findAnswer ==========
async function findAnswer(userInput, memberId) {
  const normalizedUserInput = normalizeSentence(userInput);

  /************************************************
   * A. JSON 기반 FAQ / 제품 안내 로직
   ************************************************/
  // (1) 세탁 방법 맥락 처리
  // if (pendingWashingContext) {
  //   const washingMap = {
  //     "요기보": "요기보",
  //     "줄라": "줄라",
  //     "럭스": "럭스",
  //     "모듀": "모듀",
  //     "메이트": "메이트"
  //   };
  //   for (let key in washingMap) {
  //     if (normalizedUserInput.includes(key)) {
  //       if (companyData.washing && companyData.washing[key]) {
  //         pendingWashingContext = false;
  //         return {
  //           text: companyData.washing[key].description,
  //           videoHtml: null,
  //           description: null,
  //           imageUrl: null
  //         };
  //       }
  //     }
  //   }
  //   pendingWashingContext = false;
  //   return {
  //     text: "해당 커버 종류를 찾지 못했어요. (요기보, 줄라, 럭스, 모듀, 메이트 중 하나를 입력해주세요.)",
  //     videoHtml: null,
  //     description: null,
  //     imageUrl: null
  //   };
  // }
  // if (
  //   normalizedUserInput.includes("세탁방법") ||
  //   (normalizedUserInput.includes("세탁") && normalizedUserInput.includes("방법"))
  // ) {
  //   pendingWashingContext = true;
  //   return {
  //     text: "어떤 커버(제품) 세탁 방법이 궁금하신가요? (요기보, 줄라, 럭스, 모듀, 메이트 등)",
  //     videoHtml: null,
  //     description: null,
  //     imageUrl: null
  //   };
  // }

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

  // (7) homePage 유사도 매칭
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

  // (8) asInfo 정보
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
      text: `
      상담사와 연결을 도와드릴게요.
      <a href="http://pf.kakao.com/_lxmZsxj/chat" target="_blank" >카카오플친 연결하기 </a>
      <a href="https://talk.naver.com/ct/wc4u67?frm=psf" target="_blank">네이버톡톡 연결하기</a>
      `,
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }

  /************************************************
   * B. Café24 주문/배송 로직
   ************************************************/
  // (9) 회원 아이디 조회
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

  // (10) 주문번호가 포함된 경우 처리
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
      {
        return { 
          text: `배송은 제품 출고 후 1~3 영업일 정도 소요되며, 제품별 출고 시 소요되는 기간은 아래 내용을 확인해주세요.
          - 소파 및 바디필로우: 주문 확인 후 제작되는 제품으로, 3~7 영업일 이내에 출고됩니다.
          - 모듀(모듈러) 소파: 주문 확인일로부터 1~3 영업일 이내에 출고됩니다.
          - 그 외 제품: 주문 확인일로부터 1~3 영업일 이내에 출고됩니다.
          일부 제품은 오후 1시 이전에 구매를 마쳐주시면 당일 출고될 수 있어요.
          개별 배송되는 제품을 여러 개 구매하신 경우 제품이 여러 차례로 나눠 배송될 수 있습니다.
          주문 폭주 및 재난 상황이나 천재지변, 택배사 사정 등에 의해 배송 일정이 일부 변경될 수 있습니다.
          추가 문의사항이 있으신 경우 Yogibo 고객센터로 문의해주세요.`
        };
      }
    }
  }
  
  // (11) 주문번호 없이 주문상태 확인 처리
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
              shippingCompany = `<a href="https://www.lotteglogis.com/home/reservation/tracking/index">${shippingCompany}</a>`;
            } else if (shippingCompany === "경동 택배") {
              shippingCompany = `<a href="https://kdexp.com/index.do" target="_blank">${shippingCompany}</a>`;
            }
    
            return {
              text: `고객님께서 주문하신 상품은 ${shippingCompany}를 통해 ${statusText} 이며, 운송장 번호는 ${trackingNo} 입니다.`,
              videoHtml: null,
              description: null,
              imageUrl: null,
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
            추가 문의사항이 있으신 경우 Yogibo 고객센터로 문의해주세요.`
          };
        }
      } catch (error) {
        return { text: "고객님의 주문 정보를 찾을 수 없습니다. 주문 여부를 확인해주세요." };
      }
    } else {
      {
        return { 
          text: `배송은 제품 출고 후 1~3 영업일 정도 소요되며, 제품별 출고 시 소요되는 기간은 아래 내용을 확인해주세요.
          - 소파 및 바디필로우: 주문 확인 후 제작되는 제품으로, 3~7 영업일 이내에 출고됩니다.
          - 모듀(모듈러) 소파: 주문 확인일로부터 1~3 영업일 이내에 출고됩니다.
          - 그 외 제품: 주문 확인일로부터 1~3 영업일 이내에 출고됩니다.
          일부 제품은 오후 1시 이전에 구매를 마쳐주시면 당일 출고될 수 있어요.
          개별 배송되는 제품을 여러 개 구매하신 경우 제품이 여러 차례로 나눠 배송될 수 있습니다.
          주문 폭주 및 재난 상황이나 천재지변, 택배사 사정 등에 의해 배송 일정이 일부 변경될 수 있습니다.
          추가 문의사항이 있으신 경우 Yogibo 고객센터로 문의해주세요.`
        };
      }
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

// ========== [12] /chat 라우팅 ==========
app.post("/chat", async (req, res) => {
  const userInput = req.body.message;
  const memberId = req.body.memberId; // 프론트에서 전달한 회원 ID
  if (!userInput) {
    return res.status(400).json({ error: "Message is required" });
  }

  try {
    const answer = await findAnswer(userInput, memberId);
    let finalAnswer = answer;
    if (answer.text === "질문을 이해하지 못했어요. 좀더 자세히 입력 해주시겠어요") {
      const gptResponse = await getGPT3TurboResponse(userInput);
      finalAnswer = {
        text: gptResponse,
        videoHtml: null,
        description: null,
        imageUrl: null
      };
    }
    // "내아이디" 검색어인 경우에는 로그 저장을 건너뜁니다.
    if (normalizeSentence(userInput) !== "내 아이디") {
      await saveConversationLog(memberId, userInput, finalAnswer.text);
    }
    return res.json(finalAnswer);
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

//대화 내용 적용 로직
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
});// 채팅 응답 답변에 대한 데이터 추가 
/******************************************************
 * server.js - 기존 코드 + 포스트잇(질문/답변/카테고리) 저장 로직
 ******************************************************/

// 새로 추가할 collection 이름
const postItCollectionName = "postItNotes";

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

// 포스트잇 데이터 저장 함수
async function getAllPostItQA() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(postItCollectionName);

    // 전체 포스트잇 Q/A 불러오기
    const notes = await collection.find({}).toArray();

    return notes;
  } catch (error) {
    console.error("포스트잇 Q/A 로드 오류:", error);
    return [];
  } finally {
    await client.close();
  }
}

// [A] 포스트잇 노트 조회 (페이징)
// 선택적으로 ?category= 를 사용해 특정 카테고리만 필터링할 수 있음
app.get("/postIt", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const PAGE_SIZE = 300;
  const category = req.query.category; // optional query param
  const queryFilter = category ? { category } : {};

  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(postItCollectionName);

    // 전체 문서 수 (필터 적용)
    const totalCount = await collection.countDocuments(queryFilter);
    const totalPages = Math.ceil(totalCount / PAGE_SIZE);

    let currentPage = page;
    if (currentPage < 1) currentPage = 1;
    if (totalPages > 0 && currentPage > totalPages) currentPage = totalPages;

    const skipCount = (currentPage - 1) * PAGE_SIZE;

    // 최신 등록이 맨 위에 오도록 정렬 (desc)
    const notes = await collection
      .find(queryFilter)
      .sort({ _id: -1 })
      .skip(skipCount)
      .limit(PAGE_SIZE)
      .toArray();

    // 각 문서의 _id를 문자열로 변환 (프론트에서 편하게 사용하기 위함)
    notes.forEach(doc => {
      doc._id = doc._id.toString();
    });//업데이트 진행중

    await client.close();

    return res.json({
      notes,           // 현재 페이지 노트 목록
      currentPage,     // 현재 페이지
      totalPages,      // 총 페이지 수
      totalCount,      // 전체 노트 개수
      pageSize: PAGE_SIZE
    });
  } catch (error) {
    console.error("GET /postIt 오류:", error.message);
    return res.status(500).json({ error: "포스트잇 목록 조회 중 오류가 발생했습니다." });
  }
});

// [B] 포스트잇 노트 등록 (카테고리 추가)
app.post("/postIt", async (req, res) => {
  const { question, answer, category } = req.body;
  if (!question && !answer) {
    return res.status(400).json({ error: "질문 또는 답변이 비어있습니다." });
  }

  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(postItCollectionName);

    const convertedAnswer = answer ? convertHashtagsToLinks(answer) : answer;

    // DB에 저장할 문서 (category 필드 추가)
    const newNote = {
      question,
      answer: convertedAnswer,
      category: category || "uncategorized", // 기본값 설정 가능
      createdAt: new Date()
      // 필요하다면 color 등 다른 필드 추가 가능
    };

    const result = await collection.insertOne(newNote);
    await client.close();

    // 성공 시 새로 등록된 문서 반환
    return res.json({
      message: "포스트잇 등록 성공",
      note: newNote
    });
  } catch (error) {
    console.error("POST /postIt 오류:", error.message);
    return res.status(500).json({ error: "포스트잇 등록 중 오류가 발생했습니다." });
  }
});

// [C] 포스트잇 노트 수정 (카테고리 업데이트 옵션 포함)
app.put("/postIt/:id", async (req, res) => {
  try {
    const noteId = req.params.id; 
    const { question, answer, category } = req.body;
    const { ObjectId } = require("mongodb");

    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(postItCollectionName);

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

    return res.json({
      message: "포스트잇 수정 성공",
      note: result.value
    });
  } catch (error) {
    console.error("PUT /postIt 오류:", error.message);
    return res.status(500).json({ error: "포스트잇 수정 중 오류가 발생했습니다." });
  }
});

// [D] 포스트잇 노트 삭제
app.delete("/postIt/:id", async (req, res) => {
  const noteId = req.params.id;

  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(postItCollectionName);

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
// ========== [13] 서버 시작 ==========
(async function initialize() {
  await getTokensFromDB();  // MongoDB에서 토큰 불러오기
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
})();
