const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const compression = require("compression");
const levenshtein = require("fast-levenshtein");
const axios = require("axios"); // axios로 GPT API 호출
require("dotenv").config();     // .env 로드

const app = express();

// 미들웨어 설정
app.use(cors());
app.use(compression());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// JSON 파일 로드 (예: ./json/companyData.json)
const companyData = JSON.parse(fs.readFileSync("./json/companyData.json", "utf-8"));

// ============ GPT API 연동 함수 ============
async function getGPT3TurboResponse(userInput) {
  try {
    // .env 파일에서 API_KEY, OPEN_URL 로드
    const API_KEY = process.env.API_KEY;
    const OPEN_URL = process.env.OPEN_URL;

    // 실제 ChatGPT API 호출
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
        headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' }
      }
    );

    // ChatGPT 응답 텍스트
    const gptAnswer = response.data.choices[0].message.content;
    return gptAnswer;
  } catch (error) {
    console.error("Error calling OpenAI:", error.message);
    // 실패 시 fallback
    return "GPT fallback response";
  }
}

/**
 * 전역 상태(컨텍스트): 커버링 / 세탁방법
 * 실제 서비스에서는 사용자별 세션으로 관리하는 것이 안전합니다.
 */
let pendingCoveringContext = false;
let pendingWashingContext = false; // 세탁 컨텍스트

// ============ 유틸 함수들 ============
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

// ============ 메인 로직: findAnswer ============
async function findAnswer(userInput) {
  const normalizedUserInput = normalizeSentence(userInput);

  // =========================
  // [A] 커버링 컨텍스트 확인
  // =========================
  if (pendingCoveringContext) {
    const coveringTypes = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
    if (coveringTypes.includes(normalizedUserInput)) {
      const key = `${normalizedUserInput} 커버링 방법을 알고 싶어`;
      if (companyData.covering && companyData.covering[key]) {
        const videoUrl = companyData.covering[key].videoUrl;
        pendingCoveringContext = false; // 사용 후 해제
        return {
          text: companyData.covering[key].answer,
          videoHtml: videoUrl
            ? `<iframe width="100%" height="auto" src="${videoUrl}" frameborder="0" allowfullscreen style="margin-top:20px;"></iframe>`
            : null,
          description: null,
          imageUrl: null
        };
      }
      pendingCoveringContext = false;
    }
  }

  // =========================
  // [B] 세탁(washing) 
  // =========================
  if (pendingWashingContext) {
    // 세탁 종류(키워드) 매핑
    const washingMap = {
      "요기보": "요기보 세탁방법을 알고 싶어요",
      "줄라": "줄라 세탁방법을 알고 싶어요",
      "럭스": "럭스 세탁방법을 알고 싶어요",
      "모듀": "모듀 세탁방법을 알고 싶어요"
    };
    // 사용자 입력에 위 키워드가 있는지 확인
    for (let key in washingMap) {
      if (normalizedUserInput.includes(key)) {
        const dataKey = washingMap[key];
        if (companyData.washing && companyData.washing[dataKey]) {
          pendingWashingContext = false; // 해제
          return {
            text: companyData.washing[dataKey].description,
            videoHtml: null,
            description: null,
            imageUrl: null
          };
        }
      }
    }
    // 못 찾은 경우
    pendingWashingContext = false;
    return {
      text: "해당 커버 종류를 찾지 못했어요. (요기보, 줄라, 럭스, 모듀, 메이트 중 하나를 입력해주세요.)",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }

  // =========================
  // [C] 세탁방법 입력 감지
  // =========================
  if (
    normalizedUserInput.includes("세탁방법") ||
    (normalizedUserInput.includes("세탁") && normalizedUserInput.includes("방법"))
  ) {
    // 세탁 컨텍스트 활성화
    pendingWashingContext = true;
    return {
      text: "어떤 커버(제품) 세탁 방법이 궁금하신가요? (요기보, 줄라, 럭스, 모듀, 메이트 중 택1)",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }

  // =========================
  // Step 1: 사이즈 관련
  // =========================
  if (
    normalizedUserInput.includes("소파 사이즈") ||
    normalizedUserInput.includes("빈백 사이즈") ||
    normalizedUserInput.includes("상품 사이즈")
  ) {
    return {
      text: "어떤 빈백 사이즈가 궁금하신가요? 예를 들어, 맥스, 더블, 프라임, 피라미드 등 상품명을 입력해주세요.",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }
  const sizeTypes = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
  for (let sizeType of sizeTypes) {
    // "커버링"이 포함되면 사이즈 로직 건너뛰기
    if (normalizedUserInput.includes(sizeType) && !normalizedUserInput.includes("커버링")) {
      const key = sizeType + " 사이즈 또는 크기.";
      if (companyData.sizeInfo && companyData.sizeInfo[key]) {
        return {
          text: companyData.sizeInfo[key].description,
          videoHtml: null,
          description: companyData.sizeInfo[key].description,
          imageUrl: companyData.sizeInfo[key].imageUrl
        };
      }
    }
  }

  // =========================
  // Step 2: 제품 커버 관련 조건 (교체/사용 관련)
  // =========================
  if (
    normalizedUserInput.includes("커버") &&
    normalizedUserInput.includes("교체") &&
    (normalizedUserInput.includes("사용") || normalizedUserInput.includes("교체해서 사용"))
  ) {
    return {
      text: "해당 제품 전용 커버라면 모두 사용 가능해요. 요기보, 럭스, 믹스, 줄라 등 다양한 커버를 사용해보세요. 예를 들어, 맥스 제품을 사용 중이시라면 요기보 맥스 커버, 럭스 맥스 커버, 믹스 맥스 커버, 줄라 맥스 커버로 교체하여 사용 가능합니다.",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }

  // =========================
  // Step 3: 커버링 관련 조건 (확장)
  // =========================
  const coveringTypes2 = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
  if (
    coveringTypes2.some(type => normalizedUserInput.includes(type)) &&
    normalizedUserInput.includes("커버링")
  ) {
    const foundType = coveringTypes2.find(type => normalizedUserInput.includes(type));
    const key = `${foundType} 커버링 방법을 알고 싶어`;
    if (companyData.covering && companyData.covering[key]) {
      const videoUrl = companyData.covering[key].videoUrl;
      return {
        text: companyData.covering[key].answer,
        videoHtml: videoUrl
          ? `<iframe width="100%" height="auto" src="${videoUrl}" frameborder="0" allowfullscreen style="margin-top:20px;"></iframe>`
          : null,
        description: null,
        imageUrl: null
      };
    }
  }
  if (
    normalizedUserInput.includes("커버링") &&
    normalizedUserInput.includes("방법") &&
    !coveringTypes2.some(type => normalizedUserInput.includes(type))
  ) {
    pendingCoveringContext = true;
    return {
      text: "어떤 커버링인가요? 예를 들어, '맥스', '프라임', '더블', '피라미드' 등을 입력해주세요.",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }
  if (normalizedUserInput === "커버링 방법 알려줘") {
    pendingCoveringContext = true;
    return {
      text: "어떤 커버링인가요? 예를 들어, '맥스', '프라임', '더블', '피라미드' 등을 입력해주세요.",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }

  // =========================
  // Step 4: 비즈 관련 조건
  // =========================
  const bizTypes = ["프리미엄 플러스", "프리미엄", "스탠다드"];
  if (normalizedUserInput.includes("비즈") && !bizTypes.some((type) => normalizedUserInput.includes(type))) {
    return {
      text: "어떤 비즈에 대해 궁금하신가요? 예를 들어, '스탠다드 비즈', '프리미엄 비즈', '프리미엄 플러스 비즈' 등을 입력해주세요.",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }
  if (normalizedUserInput === "비즈 알려줘" || normalizedUserInput === "비즈 방법 알려줘") {
    return {
      text: "어떤 비즈에 대해 궁금하신가요? 예를 들어, '스탠다드 비즈', '프리미엄 비즈', '프리미엄 플러스 비즈' 등을 입력해주세요.",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }
  // 특정 비즈
  if (bizTypes.includes(normalizedUserInput)) {
    const key = `${normalizedUserInput} 비즈 에 대해 알고 싶어`;
    if (companyData.biz && companyData.biz[key]) {
      return {
        text: companyData.biz[key].description + " " + getAdditionalBizComment(),
        videoHtml: null,
        description: companyData.biz[key].description,
        imageUrl: null
      };
    }
  }
  for (let bizType of bizTypes) {
    if (normalizedUserInput.includes(bizType)) {
      const key = `${bizType} 비즈 에 대해 알고 싶어`;
      if (companyData.biz && companyData.biz[key]) {
        return {
          text: companyData.biz[key].description + " " + getAdditionalBizComment(),
          videoHtml: null,
          description: companyData.biz[key].description,
          imageUrl: null
        };
      }
    }
  }

  // =========================
  // Step 5: 요기보 history
  // =========================
  if (
    normalizedUserInput.includes("요기보") &&
    (normalizedUserInput.includes("역사") ||
      normalizedUserInput.includes("알려줘") ||
      normalizedUserInput.includes("란") ||
      normalizedUserInput.includes("탄생") ||
      normalizedUserInput.includes("에 대해"))
  ) {
    const key = "요기보 에 대해 알고 싶어";
    if (companyData.history && companyData.history[key]) {
      const fullHistory = companyData.history[key].description;
      const summary = summarizeHistory(fullHistory, 300);
      return {
        text: summary,
        videoHtml: null,
        description: fullHistory,
        imageUrl: null
      };
    }
  }

  // =========================
  // Step 6: goodsInfo (Levenshte인)
  // =========================
  let bestGoodsMatch = null;
  let bestGoodsDistance = Infinity;
  if (companyData.goodsInfo) {
    for (let question in companyData.goodsInfo) {
      const normalizedQuestion = normalizeSentence(question);
      const distance = levenshtein.get(normalizedUserInput, normalizedQuestion);
      if (distance < bestGoodsDistance) {
        bestGoodsDistance = distance;
        bestGoodsMatch = companyData.goodsInfo[question];
      }
    }
  }
  const goodsThreshold = 8;
  if (bestGoodsMatch && bestGoodsDistance <= goodsThreshold) {
    return {
      text: bestGoodsMatch.description,
      videoHtml: null,
      description: bestGoodsMatch.description,
      imageUrl: bestGoodsMatch.imageUrl ? bestGoodsMatch.imageUrl : null
    };
  }

  // =========================
  // Step 7: 회원가입 관련 조건
  // =========================
  if (
    normalizedUserInput.includes("회원가입") ||
    normalizedUserInput.includes("회원 등록") ||
    normalizedUserInput.includes("가입 방법")
  ) {
    const key = "회원 가입 방법";
    if (companyData.homePage && companyData.homePage[key]) {
      return {
        text: companyData.homePage[key].description,
        videoHtml: null,
        description: companyData.homePage[key].description,
        imageUrl: companyData.homePage[key].imageUrl ? companyData.homePage[key].imageUrl : null
      };
    }
  }

  // =========================
  // Step 8: 배송정보(deliveryInfo) (Levenshte인)
  // =========================
  let deliveryPageMatch = null;
  let deliveryPageDistance = Infinity;
  if (companyData.deliveryInfo) {
    for (let question in companyData.deliveryInfo) {
      const normalizedQuestion = normalizeSentence(question);
      const distance = levenshtein.get(normalizedUserInput, normalizedQuestion);
      if (distance < deliveryPageDistance) {
        deliveryPageDistance = distance;
        deliveryPageMatch = companyData.deliveryInfo[question];
      }
    }
  }
  const deliveryPageThreshold = 8;
  if (deliveryPageMatch && deliveryPageDistance <= deliveryPageThreshold) {
    return {
      text: deliveryPageMatch.description,
      videoHtml: null,
      description: deliveryPageMatch.description,
      imageUrl: deliveryPageMatch.imageUrl ? deliveryPageMatch.imageUrl : null
    };
  }

  // =========================
  // Step 9: homePage (Levenshte인)
  // =========================
  let homePageMatch = null;
  let homePageDistance = Infinity;
  if (companyData.homePage) {
    for (let question in companyData.homePage) {
      // "회원 가입 방법"은 위에서 처리
      if (question.includes("회원 가입 방법")) continue;

      const normalizedQuestion = normalizeSentence(question);
      const distance = levenshtein.get(normalizedUserInput, normalizedQuestion);
      if (distance < homePageDistance) {
        homePageDistance = distance;
        homePageMatch = companyData.homePage[question];
      }
    }
  }
  const homePageThreshold = 6;
  if (homePageMatch && homePageDistance <= homePageThreshold) {
    return {
      text: homePageMatch.description,
      videoHtml: null,
      description: homePageMatch.description,
      imageUrl: homePageMatch.imageUrl ? homePageMatch.imageUrl : null
    };
  }

  // =========================
  // Step 10: covering / biz 최종 비교
  // =========================
  let bestMatch = null;
  let bestDistance = Infinity;
  let bestCategory = null;

  if (companyData.covering) {
    for (let question in companyData.covering) {
      const normalizedQuestion = normalizeSentence(question);
      const distance = levenshtein.get(normalizedUserInput, normalizedQuestion);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestMatch = companyData.covering[question];
        bestCategory = "covering";
      }
    }
  }
  if (companyData.biz) {
    for (let question in companyData.biz) {
      const normalizedQuestion = normalizeSentence(question);
      const distance = levenshtein.get(normalizedUserInput, normalizedQuestion);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestMatch = companyData.biz[question];
        bestCategory = "biz";
      }
    }
  }
  const finalThreshold = 7;
  if (bestDistance > finalThreshold) {
    return {
      text: "질문을 이해하지 못했어요. 좀더 자세히 입력 해주시겠어요",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }
  if (bestCategory === "covering") {
    const videoUrl = bestMatch.videoUrl ? bestMatch.videoUrl : null;
    return {
      text: bestMatch.answer,
      videoHtml: videoUrl
        ? `<iframe width="100%" height="auto" src="${videoUrl}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`
        : null,
      description: null,
      imageUrl: null
    };
  } else if (bestCategory === "biz") {
    return {
      text: bestMatch.description + " " + getAdditionalBizComment(),
      videoHtml: null,
      description: bestMatch.description,
      imageUrl: null
    };
  }

  // 기본 fallback
  return {
    text: "알 수 없는 오류가 발생했습니다.",
    videoHtml: null,
    description: null,
    imageUrl: null
  };
}

// ============ Express 라우팅 ============
app.post("/chat", async (req, res) => {
  const userInput = req.body.message;
  if (!userInput) {
    return res.status(400).json({ error: "Message is required" });
  }
  try {
    const answer = await findAnswer(userInput);
    // fallback: "질문을 이해하지 못했어요..." 라면 GPT API 호출
    if (answer.text === "질문을 이해하지 못했어요. 좀더 자세히 입력 해주시겠어요") {
      const gptResponse = await getGPT3TurboResponse(userInput);
      return res.json({
        text: gptResponse,
        videoHtml: null,
        description: null,
        imageUrl: null
      });
    }
    // 정상 응답
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
