const { getDB } = require("../config/db");
const { getShipmentDetail, getOrderShippingInfo, getCachedProducts, getMemberPurchaseHistory } = require("./cafe24Service");
const { recommendProductsWithGPT } = require("./openaiService");
const { 
    normalizeSentence, 
    containsOrderNumber, 
    isUserLoggedIn, 
    COUNSELOR_BUTTONS_ONLY_HTML, 
    LOGIN_BTN_HTML 
} = require("../utils/helpers");

const path = require("path");
const fs = require("fs");
const { getEmbedding } = require("./openaiService");

let staticFaqList = [];
try { staticFaqList = require("../faq"); } catch (e) { console.warn("faq.js load skip"); }

const companyDataPath = path.join(__dirname, "../json", "companyData.json");
let companyData = {};
try { 
    if (fs.existsSync(companyDataPath)) {
        companyData = JSON.parse(fs.readFileSync(companyDataPath, "utf-8")); 
    }
} catch (e) { console.error("companyData load error:", e); }

let allSearchableData = []; 
let currentSystemPrompt = `
1. 역할: 당신은 '요기보(Yogibo)'의 AI 상담원입니다.

2. ★ 중요 임무:
- 사용자 질문에 대해 아래 제공되는 [참고 정보]들을 꼼꼼히 읽고 답변을 작성하세요.
- [참고 정보]는 FAQ, 제품 매뉴얼, 회사 규정 등이 섞여 있습니다. 이 중에서 질문과 가장 관련 있는 내용을 찾아내세요.
- 답변은 반드시 [참고 정보]에서 근거가 확인되는 내용만 안내하세요.
- [참고 정보]에 동일한 문장이 없더라도, 여러 근거를 종합하면 논리적으로 답할 수 있는 경우에는
  "참고 정보 기준으로 종합하면" 형태로 설명하는 것은 허용합니다.
- 단, [참고 정보]에 없는 사실(전화번호/주소/정책/가격/기간/효과 등)을 새로 만들어내거나 추측하면 안 됩니다.
- 만약 (a) 관련 근거가 전혀 없거나, (b) 요기보와 무관한 내용(코딩/주식/날씨 등)이라면,
  절대 지어내지 말고 오직 "NO_CONTEXT"라고만 출력하세요.

3. 답변 스타일:
- 친절하고 전문적인 톤으로 답변하세요.
- 가능한 경우 (1) 핵심 답변 → (2) 근거 요약 → (3) 고객에게 확인할 질문 순서로 작성하세요.
- 링크는 [버튼명](URL) 형식으로, 이미지는 <img src="..."> 태그를 그대로 유지하세요.
`;

async function updateSearchableData() {
  const db = getDB();
  try {
    const notes = await db.collection("postItNotes").find({}).toArray();
    const dbData = notes.map(n => ({ 
        source: "DB", category: n.category || "general", q: n.question, a: n.answer 
    }));

    const faqData = staticFaqList.map(f => ({
        source: "FAQ", category: "faq", q: f.q, a: f.a
    }));

    let jsonData = [];
    if (companyData.covering) {
        Object.keys(companyData.covering).forEach(key => {
            jsonData.push({ source: "JSON", category: "covering", q: key, a: companyData.covering[key].answer });
        });
    }
    if (companyData.sizeInfo) {
        Object.keys(companyData.sizeInfo).forEach(key => {
            jsonData.push({ source: "JSON", category: "size", q: key, a: companyData.sizeInfo[key].description });
        });
    }

    // 1) DB에서 누락된 임베딩(Vector) 일괄 생성 (Backfill)
    const missingEmbeddings = notes.filter(n => !n.embedding);
    if (missingEmbeddings.length > 0) {
        console.log(`[RAG] DB 내 ${missingEmbeddings.length}개의 데이터에 대한 임베딩(Vector) 생성을 시작합니다...`);
        const batchSize = 500;
        for (let i = 0; i < missingEmbeddings.length; i += batchSize) {
            const batch = missingEmbeddings.slice(i, i + batchSize);
            const textsToEmbed = batch.map(b => `Q: ${b.question || ''}\nA: ${(b.answer || '').replace(/<[^>]*>?/gm, '')}`);
            const embeddings = await getEmbedding(textsToEmbed);
            if (embeddings && embeddings.length === batch.length) {
                await Promise.all(batch.map((b, idx) => {
                    b.embedding = embeddings[idx]; 
                    return db.collection("postItNotes").updateOne({ _id: b._id }, { $set: { embedding: embeddings[idx] } });
                }));
            }
        }
    }

    // 2) 메모리 로드 
    allSearchableData = [...faqData, ...dbData, ...jsonData];
    
    // 3) 메모리에만 존재하는 정적 데이터(FAQ/JSON) 임베딩 생성 (서버 시작 또는 갱신 시점 1회)
    const memoryMissing = allSearchableData.filter(i => !i.embedding);
    if (memoryMissing.length > 0) {
        console.log(`[RAG] 정적 데이터 ${memoryMissing.length}개의 임베딩(Vector) 생성을 시작합니다...`);
        const batchSize = 500;
        for (let i = 0; i < memoryMissing.length; i += batchSize) {
            const batch = memoryMissing.slice(i, i + batchSize);
            const textsToEmbed = batch.map(b => `Q: ${b.q || ''}\nA: ${(b.a || '').replace(/<[^>]*>?/gm, '')}`);
            const embeddings = await getEmbedding(textsToEmbed);
            if (embeddings && embeddings.length === batch.length) {
                batch.forEach((b, idx) => { b.embedding = embeddings[idx]; });
            }
        }
    }

    // 4) systemPrompts 테이블 최신값 가져오기
    const prompts = await db.collection("systemPrompts").find({}).sort({createdAt: -1}).limit(1).toArray();
    if (prompts.length > 0) currentSystemPrompt = prompts[0].content; 
    
    console.log(`✅ [데이터 로드 완료] 총 ${allSearchableData.length}개의 지식 데이터가 벡터 기반 RAG로 준비되었습니다.`);
  } catch (err) { 
      console.error("데이터 갱신 실패:", err); 
  }
}

function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function findAllRelevantContent(msg) {
  const queryEmbedding = await getEmbedding(msg);
  
  if (!queryEmbedding) {
      console.warn("[RAG] 임베딩 API 장애: 키워드 기반 검색으로 폴백합니다.");
      const kws = msg.split(/\s+/).filter(w => w.length > 1);
      if (!kws.length && msg.length < 2) return [];

      const scored = allSearchableData.map(item => {
        let score = 0;
        const q = (item.q || "").toLowerCase().replace(/\s+/g, "");
        const cleanMsg = msg.toLowerCase().replace(/\s+/g, "");
        if (q === cleanMsg) score += 100;
        else if (q.includes(cleanMsg) || cleanMsg.includes(q)) score += 50;
        
        kws.forEach(w => {
          if ((item.q || "").toLowerCase().includes(w)) score += 30;
          if ((item.a || "").toLowerCase().includes(w)) score += 30;
        });
        return { ...item, score };
      });
      return scored.filter(i => i.score >= 12).sort((a, b) => b.score - a.score).slice(0, 6);
  }

  // 코사인 유사도 계산
  const scored = allSearchableData.map(item => {
      let score = 0;
      if (item.embedding) {
          const sim = cosineSimilarity(queryEmbedding, item.embedding);
          score = Math.floor(sim * 100); // 0~100 스케일
      }
      return { ...item, score };
  });

  // 유사도 40점 이상만 추출 (OpenAI 임베딩에서 0.4 정도면 꽤 관련성이 있음)
  return scored.filter(i => i.score >= 40).sort((a, b) => b.score - a.score).slice(0, 6);
}

function getCurrentSystemPrompt() {
    return currentSystemPrompt;
}

async function recommendProducts(userMsg, memberId) {
    const purchaseHistory = await getMemberPurchaseHistory(memberId);
    const yogiboProducts = getCachedProducts();
    const relevantContext = await findAllRelevantContent(userMsg);
    
    if(!yogiboProducts || yogiboProducts.length === 0) {
        return "현재 상품 데이터를 불러올 수 없습니다. 잠시 후 다시 시도해주세요.";
    }

    try {
        const aiResult = await recommendProductsWithGPT(userMsg, purchaseHistory, yogiboProducts, relevantContext);
        
        let answer = aiResult.message || "고객님께 딱 맞는 상품을 찾았습니다!";
        const recommendedProducts = aiResult.recommendedIds
            .map(id => yogiboProducts.find(p => p.id === id))
            .filter(p => p !== undefined); // 혹시 모를 매치 실패 방지
            
        if (recommendedProducts.length === 0) {
             return "원하시는 조건에 맞는 상품을 찾지 못했어요. 조금 더 구체적으로 말씀해주시겠어요?";
        }

        const buttons = recommendedProducts.map(p => `<a href="${p.productUrl}" target="_blank" class="consult-btn" style="background:#58b5ca; color:#fff; display:inline-block; margin:5px; text-decoration:none;">🛍️ ${p.name} 보러가기</a>`).join("");
        return answer + "<br><br>" + buttons;
    } catch (e) { 
        console.error("추천 처리 실패:", e);
        return "추천 상품을 불러오는 중 오류가 발생했습니다."; 
    }
}

const counselorTriggers = ["상담사", "상담원", "상담사 연결", "상담원 연결", "사람 상담", "직원 연결", "카톡 상담", "카카오 상담", "네이버 상담", "톡톡 상담"];

async function findRuleBasedAnswer(userInput, memberId) {
  const normalized = normalizeSentence(userInput);

  if (counselorTriggers.some(t => normalized.includes(t))) return { text: COUNSELOR_BUTTONS_ONLY_HTML };

  const recommendKeywords = ["추천", "뭐가 좋", "어떤게 좋", "골라", "선택", "뭐 사"];
  if (recommendKeywords.some(k => normalized.includes(k))) {
    const recommendResult = await recommendProducts(userInput, memberId);
    return { text: recommendResult };
  }

  if (containsOrderNumber(normalized)) {
    if (isUserLoggedIn(memberId)) {
      try {
        const orderId = normalized.match(/\d{8}-\d{7}/)[0];
        const ship = await getShipmentDetail(orderId);
        if (ship) return { text: `주문번호 <strong>${orderId}</strong>의 배송 상태는 <strong>${ship.status || "배송 준비중"}</strong>입니다.` };
        return { text: "해당 주문번호의 정보를 찾을 수 없습니다." };
      } catch (e) { return { text: "조회 중 오류가 발생했습니다." }; }
    }
    return { text: `조회를 위해 로그인이 필요합니다.${LOGIN_BTN_HTML}` };
  }

  const isTracking = (normalized.includes("배송") || normalized.includes("주문")) && (normalized.includes("조회") || normalized.includes("확인") || normalized.includes("언제") || normalized.includes("어디"));
  if (isTracking) {
    if (isUserLoggedIn(memberId)) {
      try {
        const data = await getOrderShippingInfo(memberId);
        if (data.orders?.[0]) {
            const orderId = data.orders[0].order_id;
            try {
                const ship = await getShipmentDetail(orderId);
                if (ship) {
                    let text = `최근 주문(<strong>${orderId}</strong>)의 배송 상태는 <strong>${ship.status || "배송 준비중"}</strong>입니다.`;
                    if (ship.tracking_no) {
                        text += `<br>택배사: ${ship.shipping_company_name}<br>운송장 번호: ${ship.tracking_no}`;
                        text += `<br><br><a href="${ship.tracking_url}" target="_blank" class="consult-btn" style="background:#58b5ca; color:#fff; display:inline-block; text-decoration:none;"><i class="fa-solid fa-truck"></i> 실시간 배송조회</a>`;
                    }
                    return { text };
                }
            } catch (e) {
                // 배송 정보 조회를 못했지만 주문번호는 아는 경우
                return { text: `최근 주문(<strong>${orderId}</strong>) 내역을 확인했습니다.<br>배송 준비 중이거나 배송사 연동이 지연되고 있을 수 있습니다.` };
            }
            return { text: `최근 주문(<strong>${orderId}</strong>) 내역을 확인했습니다.` };
        }
        return { text: "최근 주문(배송) 내역이 없습니다." };
      } catch (e) { return { text: "조회 실패." }; }
    }
    return { text: `배송정보 확인을 위해 로그인이 필요합니다.${LOGIN_BTN_HTML}` };
  }
  return null;
}

module.exports = {
    updateSearchableData,
    findAllRelevantContent,
    getCurrentSystemPrompt,
    findRuleBasedAnswer
};
