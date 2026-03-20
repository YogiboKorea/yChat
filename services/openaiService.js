const axios = require("axios");

const { OPEN_URL, API_KEY, FINETUNED_MODEL = "gpt-4o-mini" } = process.env;

// ★ [항목6+7 개선] 멀티턴 대화 컨텍스트 지원 + 에러 로그 추가
async function getLLMResponse(currentSystemPrompt, input, context = [], conversationHistory = []) {
  const txt = context.map(i => `Q: ${i.q}\nA: ${i.a}`).join("\n\n");
  const system = `${currentSystemPrompt}

[운영 규칙 - 매우 중요]
- 답변은 반드시 아래 [참고 정보]에서 근거가 확인되는 내용만 안내하세요.
- [참고 정보]에 없는 내용은 절대 추측하지 말고, "정확한 확인이 필요합니다"라고 말하세요.
- 고객에게 추가 확인이 필요한 정보(주문번호/구매처/제품명 등)가 있으면 먼저 요청하세요.

[참고 정보]
${txt || "정보 없음."}`;

  // ★ [멀티턴] 이전 대화 최근 3개를 messages 배열에 삽입
  const historyMessages = conversationHistory.flatMap(h => [
    { role: "user", content: h.userMessage },
    { role: "assistant", content: h.botResponse }
  ]);

  try {
    const res = await axios.post(
      OPEN_URL,
      {
        model: FINETUNED_MODEL,
        temperature: 0.2,
        top_p: 0.9,
        messages: [
          { role: "system", content: system },
          ...historyMessages,
          { role: "user", content: input }
        ]
      },
      { headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" } }
    );
    return res.data.choices?.[0]?.message?.content || "답변을 생성하지 못했습니다.";
  } catch (e) {
    // ★ [항목7 개선] 에러 로그 추가 (장애 추적용)
    console.error("[OpenAI getLLMResponse 오류]", e?.response?.data || e.message);
    return "답변 생성 중 문제가 발생했습니다.";
  }
}

async function recommendProductsWithGPT(userMsg, purchaseHistory, allProducts, context = []) {
    // ★ [커버 배제 로직] 고객이 명시적으로 "커버"를 찾지 않으면, 제품명에 '커버'가 들어간 항목은 애초에 AI에게 주지 않음
    const isCoverRequested = userMsg.includes("커버");
    const filteredProducts = isCoverRequested ? allProducts : allProducts.filter(p => !p.name.includes("커버"));

    const productsJson = JSON.stringify(filteredProducts.map(p => ({
        id: p.id,
        name: p.name,
        price: p.price,
        category: p.category,
        features: p.features,
        useCase: p.useCase
    })));

    const hasPurchaseHistory = purchaseHistory && purchaseHistory.products && purchaseHistory.products.length > 0;
    const coverExclusionRule = !hasPurchaseHistory 
        ? `- [매우 중요] 이름에 "커버"가 들어간 상품은 추천에서 절대로 제외하세요.` 
        : `- [리뷰 유도] 고객이 소유한 상품 목록(${purchaseHistory.products.join(", ")}) 중, 고객이 대화 중 언급하지 않았거나 리뷰를 작성하지 않았을 가능성이 있는 상품이 있다면 친절하게 리뷰 작성을 권유하는 멘트를 자연스럽게 한 줄 추가하세요.`;

    const prompt = `
    당신은 요기보 세일즈 매니저입니다.
    고객 질문: "${userMsg}"
    최근 1년 구매 이력: ${hasPurchaseHistory ? JSON.stringify(purchaseHistory.products) : "없음"}
    
    [보조 지식 데이터 - 아래 맥스 규칙보다 우선순위 낮음]
    ${context.length > 0 ? context.map(c => `Q: ${c.q}\nA: ${c.a}`).join("\n\n") : "없음"}
    
    현재 판매중인 요기보 전체 상품 목록:
    ${productsJson}
    
    [색상 및 예산 필터링 필수 규칙]
    - 요기보의 빈백 소파와 바디필로우는 제품당 기본적으로 10~20가지 색상(레드, 블루, 그린, 퍼플, 핑크, 다크/라이트그레이, 네이비 등) 커버를 모두 지원합니다. 따라서 고객이 특정 색상(예: "빨간색")을 요구하더라도 모두 조건을 충족한다고 간주하고 당당히 추천하세요.
    - 고객 질문에 "20만원 이내", "10만원 이하" 등 특정 예산(가격 상한선)이 포함된 경우, 제공된 상품 데이터의 price 값을 비교하여 반드시 예산 범위 내의 상품만 엄격하게 필터링하여 추천하세요. 예산을 초과하는 상품은 절대 추천 목록에 넣지 마세요.
    
    [카테고리 매칭 필수 규칙]
    - [매우 중요] 고객이 특정 카테고리(예: 소파)를 원하면, "반드시" 해당 category 값을 가진 상품만 골라야 합니다. category 설정값이 일치하지 않는 상품(예: "기타", "악세서리")은 추천에 섞지 마세요.
    - 고객이 "소파", "가구", "빈백", "쇼파" 를 추천해달라고 하면 반드시 category가 "소파"인 상품 중에서만 추천하세요. (이름에 커버·스퀴지보·메이트·필로우·커버가 들어간 상품은 절대 제외)
    - 고객이 "바디필로우"나 "베개", "껴안고 자는" 것을 원하면 반드시 category가 "바디필로우"인 상품 중에서만 추천하세요.
    - 고객이 "인형", "캐릭터", "아기 선물" 등을 원하면 반드시 category가 "메이트/캐릭터"인 상품 중에서만 추천하세요.
    - [경고] 예산(가격) 조건에 맞더라도, 고객이 요청한 카테고리(예: 빈백, 소파)와 일치하지 않는 엉뚱한 카테고리 상품(예: 인형, 바디필로우)은 절대로 추천 목록에 섞지 마세요.
    
    [상황 및 예산별 맞춤 추천 필수 규칙]
    고객의 질문 맥락이나 예산을 분석하여 아래 룰을 최우선으로 적용해 탐색하세요.
    - [예산 30만원 이상 / 고가 라인 요청 시]: "요기보 맥스(Max)" 와 "요기보 더블(Double)" 을 강력 추천.
    - [예산 10만원대 범위 요청 시]: "요기보 서포트(Support)" 를 강력 추천.
    - [예산 10만원 미만 / 가성비 / 소형 요청 시]: "메이트(Mate) 인형/캐릭터" 상품을 적극 추천.
    - [조합 추천 / 꿀조합 / 맥스와 함께 쓸 제품 요청 시]: "요기보 서포트(Support)" 를 함께 추천. (서포트는 대부분의 빈백 라인과 가장 잘 어울리는 찰떡궁합 아이템입니다.)
    - [인기상품, 베스트셀러, 많이 팔리는 것 문의 시]: 복잡하게 여러 개 나열하지 말고, **"요기보 맥스(Max)"와 "요기보 서포트(Support)" 2가지**를 가장 대표적인 베스트셀러로 묶어서 간결하고 강력하게 추천하세요.
    - [일반적인 빈백/소파 라인 요청 시 (예산 조건 없을 때)]: "요기보 맥스", "미디", "미니", "라운저" 라인을 우선 탐색.
    - [아기, 유아, 학생 대상 (예산 조건 없을 때)]: "요기보 피라미드" 와 "메이트 인형" 세트 추천.
    - [임산부 / 허리 통증 개선 목적]: 무조건 "요기보 서포트(Support)" 를 1순위로 포함하여 추천.
    - [온라인 쇼룸 안내]: 고객이 오프라인 매장 분위기를 볼 수 있는 "온라인 쇼룸", "가상 쇼룸" 등을 물어보면 반드시 "https://yogibo.kr/show_room/new/index.html" 링크를 안내하세요. (가상의 URL이나 외부 단축 URL은 절대 만들지 마세요.)
    - (단, 위 추천 상품들의 가격이 고객이 부른 상한선 예산을 초과하면 추천하지 마세요.)
    ${coverExclusionRule}
    
    위 전체 상품 목록에서 고객의 질문에 맞는 상품 딱 3개를 골라주세요.
    선택 우선순위: ① 카테고리 일치 여부(가장 중요) → ② 예산 범위 제한 → ③ 보조 지식 데이터 참고
    
    [다양성 확보 필수 규칙]
    - 매번 기계적으로 똑같은 상품(예: 메가 문 필로우, 스퀴지보 플랜트 등)만 추천하지 마세요. 
    - 조건(예산, 카테고리 등)에 부합하는 한도 내에서 최대한 새롭고 다양한 요기보 상품을 탐색하여 번갈아가며 추천하세요.

    그리고 이 3개의 상품을 왜 추천하는지에 대한 고객용 안내 멘트를 작성해주세요.
    - [경고: 가격 환각 절대 금지]: 멘트에 상품 가격을 명시할 때는, 절대로 임의로 상상해서 적지 마세요. 반드시 위 데이터 목록에 있는 해당 상품의 \`price\` 숫자값을 정확히 확인하여 "O,OOO원" 형식으로 안내하세요. 
    - (구매 이력이 있다면 "지난번 구매하신 OO과 함께 쓰시면 좋아요" 같은 멘트를 같이 넣어주세요.)
    
    반드시 아래 JSON 형식으로만 응답해야 합니다. 다른 말은 절대 추가하지 마세요.
    {
       "recommendedIds": ["상품ID1", "상품ID2", "상품ID3"],
       "message": "고객에게 전달할 매우 친절하고 구체적인 추천 멘트 (HTML <br>태그 사용 가능, 상품 이름과 가격, 추천 이유 포함)"
    }
    `;

    try {
      const gptRes = await axios.post(OPEN_URL, {
        model: FINETUNED_MODEL,
        temperature: 0.4, // 답변 다양성을 위해 기존 0.1에서 0.4로 상향 (JSON 출력 보장 상태이므로 안전)
        response_format: { type: "json_object" }, 
        messages: [
          { role: "system", content: "당신은 요기보 상담원입니다. 제공된 상품 카탈로그 안에서만 상품을 선택하고, 반드시 명시된 JSON 포맷으로만 응답하세요." },
          { role: "user", content: prompt }
        ]
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });
      
      const parsed = JSON.parse(gptRes.data.choices[0].message.content);

      // ★ [코드 레벨 강제] 소파/빈백 키워드 감지 시 맥스(product_no=39)를 반드시 1번으로 삽입 및 멘트 교정
      // 단, 예산(O만원 이하/이내) 제한이 있을 경우 맥스 강제를 해제하여 GPT의 가격 필터링이 온전히 작동하게 함
      const SOFA_KEYWORDS = /소파|빈백|쇼파|bean bag|베개소파|공중부양|게임용|거실|추천|베스트|대표설정|대표상품/;
      const HAS_PRICE_LIMIT = /[0-9]+만원|[0-9]+만 원|이하|이내|저렴한|싼/;
      if (SOFA_KEYWORDS.test(userMsg) && !HAS_PRICE_LIMIT.test(userMsg)) {
        // Cafe24 product_no=39 로 정확히 검색 (없으면 이름으로 fallback)
        let maxProduct = allProducts.find(p => p.productUrl && p.productUrl.includes('product_no=39'));
        if (!maxProduct) maxProduct = allProducts.find(p => p.name.includes('맥스') && p.category === '소파');

        if (maxProduct) {
          const maxId = maxProduct.id;
          const originalIds = parsed.recommendedIds || [];
          
          if (originalIds[0] !== maxId) {
             // 맥스가 결과에 없거나 1번이 아니면 강제로 1번으로 올림
             const ids = originalIds.filter(id => id !== maxId);
             parsed.recommendedIds = [maxId, ...ids].slice(0, 3);
             console.log(`[맥스 강제 삽입] 소파 쿼리에서 맥스(${maxId})를 1번으로 교정`);
             
             // 텍스트에도 맥스 멘트가 빠졌을 경우 (GPT 환각 방어)
             if (!parsed.message.includes('맥스')) {
                 const formattedPrice = maxProduct.price ? maxProduct.price.toLocaleString() + '원' : '389,000원';
                 const maxText = `요기보 시그니처 대표 상품인 <b>${maxProduct.name}</b>(은)는 소파·침대·놀이매트로 모두 활용 가능하며, 가장 많은 분들이 선택하시는 베스트셀러입니다. (가격: ${formattedPrice})<br><br>`;
                 
                 // 어색한 타 상품 지칭 문구(예: "대표 상품인 메가 문 필로우") 제거/교정 시도
                 parsed.message = parsed.message.replace(/요기보 시그니처 대표 상품인.*?다\./g, '');
                 
                 parsed.message = maxText + parsed.message;
             }
          }
        }
      }

      return parsed;
    } catch (e) { 
        console.error("[OpenAI recommendProductsWithGPT 오류]:", e?.response?.data || e.message);
        throw new Error("추천 멘트 생성 중 예외 발생"); 
    }
}

async function getEmbedding(textOrArray) {
  if (!textOrArray || (Array.isArray(textOrArray) && textOrArray.length === 0)) return null;
  try {
    const embeddingUrl = OPEN_URL.includes("/chat/completions") 
      ? OPEN_URL.replace("/chat/completions", "/embeddings")
      : "https://api.openai.com/v1/embeddings";

    const res = await axios.post(
      embeddingUrl,
      {
        model: "text-embedding-3-small", // 요기보 기본 최적화
        input: textOrArray
      },
      { headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" } }
    );
    
    // 배열이면 배열 전체 반환, 단일 문자열이면 첫 번째 벡터 반환
    if (Array.isArray(textOrArray)) {
        // 원래 입력 순서대로 정렬 (res.data.data가 순서를 보장하지만 혹시 몰라 sort 추가)
        return res.data.data.sort((a,b) => a.index - b.index).map(d => d.embedding);
    }
    return res.data.data[0].embedding;
  } catch (e) {
    console.error("Embedding API error:", e?.response?.data || e.message);
    return null;
  }
}

module.exports = {
    getLLMResponse,
    recommendProductsWithGPT,
    getEmbedding
};
