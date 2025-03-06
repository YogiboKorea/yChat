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
[역할]: 당신은 [기업명]의 고객 지원 챗봇입니다. 친절하고 정확한 정보를 제공합니다.  
[목표]: 고객이 자주 묻는 질문(FAQ)에 대한 신속하고 명확한 답변을 제공합니다.  
[응답 스타일]: 간결하면서도 이해하기 쉽게 답변하세요. 필요할 경우 추가 정보 링크를 제공하세요.  

[FAQ 예시]:  
1. **배송 관련**  
   - 고객: "배송은 얼마나 걸리나요?"  
   - 챗봇: "보통 2~3일 정도 소요됩니다. 정확한 배송 일정은 주문 조회 페이지에서 확인하실 수 있습니다. [주문 조회하기](링크)"  

2. **환불 및 교환**  
   - 고객: "제품을 반품하고 싶어요."  
   - 챗봇: "반품은 제품 수령 후 7일 이내 가능합니다. 반품 절차는 다음 링크에서 확인하세요: [반품 안내](링크)"  

3. **회원가입 및 계정**  
   - 고객: "비밀번호를 잊어버렸어요."  
   - 챗봇: "비밀번호 재설정은 [비밀번호 찾기](링크) 페이지에서 가능합니다. 문제가 지속되면 고객센터에 문의해주세요."  

4. **기타 문의**  
   - 고객: "다른 궁금한 점이 있어요."  
   - 챗봇: "더 궁금한 사항이 있으시면 고객센터(📞 1234-5678)로 문의해주세요!"  

[추가 지침]:  
- 고객이 질문을 정확하게 하지 못한 경우, 관련된 질문을 제시하여 선택할 수 있도록 도와주세요.  
- 고객의 감정을 고려하여 친절하고 공감하는 어조를 유지하세요.  
- 고객이 만족할 수 있도록 필요한 정보를 충분히 제공하세요.  

`;

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

  // 오늘 날짜를 종료 날짜(end_date)로 설정 (YYYY-MM-DD 형식)
  const today = new Date();
  const end_date = today.toISOString().split('T')[0];

  // 2주 전 날짜를 시작 날짜(start_date)로 설정 (YYYY-MM-DD 형식)
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
              You are an expert specializing in the Yogiibo brand and have all 
              the information about Yogiibo. Yogiibo is a beanbag company and if
              you have any questions that are difficult for you to answer, please connect me to the customer center
              The representative product is 맥스 Max and it's a global brand company. 
              Please answer the information in Korean
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
      // 생성되는 key를 로그로 확인
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
    if (bestGoodsDistance < 8 && bestGoodsMatch) {
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
    normalizedUserInput.includes("상담원 연결")
  ) {
    return {
      text: `
      상담사와 연결을 도와드릴게요.<br>
      <a href="http://pf.kakao.com/_lxmZsxj/chat" target="_blank" style="border-radius:10px;float:left; padding-inline:10px;background:#58b5ca;color:#fff;line-height:7px;">
        카카오플친 연결하기
      </a>
      <a href="https://talk.naver.com/ct/wc4u67?frm=psf" target="_blank" style="border-radius:10px;padding-inline:10px;float:left;background:#58b5ca;color:#fff;">
        네이버톡톡 연결하기
      </a>
      `,
      videoHtml: null,
      description: null,
      imageUrl: null
    };
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

  // 주문번호가 포함된 경우의 처리
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
          // shipment.status 값이 없다면, items 배열의 첫 번째 요소의 status 값을 사용
          const shipmentStatus =
            shipment.status || (shipment.items && shipment.items.length > 0 ? shipment.items[0].status : undefined);
          // standby: 배송대기, shipping: 배송중, shipped: 배송완료
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
      return { text: "회원 정보가 확인되지 않습니다. 로그인 후 다시 시도해주세요." };
    }
  }
  
  // 주문번호 없이 주문상태 확인인 경우의 처리
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
          return { text: " 고객님께서 주문하신 내역을 현재 확인할 수 없습니다. 번거로우시겠지만, 자세한 확인을 원하시면 고객센터로 문의해 주시면 신속하게 도와드리겠습니다." };
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
