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
    const productsJson = JSON.stringify(allProducts.map(p => ({
        id: p.id,
        name: p.name,
        price: p.price,
        category: p.category,
        features: p.features,
        useCase: p.useCase
    })));

    const hasPurchaseHistory = purchaseHistory && purchaseHistory.products && purchaseHistory.products.length > 0;
    const coverExclusionRule = !hasPurchaseHistory 
        ? `- [매우 중요] 고객의 구매 이력이 없으므로, 이름에 "커버"가 들어간 상품은 추천에서 절대로 제외하세요.` 
        : `- [리뷰 유도] 고객이 소유한 상품 목록(${purchaseHistory.products.join(", ")}) 중, 고객이 대화 중 언급하지 않았거나 리뷰를 작성하지 않았을 가능성이 있는 상품이 있다면 친절하게 리뷰 작성을 권유하는 멘트를 자연스럽게 한 줄 추가하세요. (예: "혹시 예전에 구매하신 OO은 잘 사용하고 계신가요? 아직 리뷰를 남기지 않으셨다면 리뷰 이벤트에 참여해 보세요!")`;

    const prompt = `
    당신은 요기보 세일즈 매니저입니다.
    고객 질문: "${userMsg}"
    최근 1년 구매 이력: ${hasPurchaseHistory ? JSON.stringify(purchaseHistory.products) : "없음"}
    
    [교육된 지식 데이터(우선 순위가 가장 높음)]
    ${context.length > 0 ? context.map(c => `Q: ${c.q}\nA: ${c.a}`).join("\n\n") : "없음"}
    
    현재 판매중인 요기보 전체 상품 목록:
    ${productsJson}
    
    [카테고리 매칭 필수 규칙]
    - [매우 중요] 고객이 특정 카테고리(예: 소파)를 원하면, "반드시" 해당 category 값을 가진 상품만 골라야 합니다. category 설정값이 일치하지 않는 상품(예: "기타", "악세서리")은 추천에 섞지 마세요.
    - 고객이 "소파"나 "가구"를 추천해달라고 하면 반드시 category가 "소파"인 상품 중에서만 추천하세요. (예: 이름에 커버, 스퀴지보, 메이트, 필로우가 들어간 상품은 소파가 아니므로 절대 제외)
    - 고객이 "바디필로우"나 "베개", "껴안고 자는" 것을 원하면 반드시 category가 "바디필로우"인 상품 중에서만 추천하세요.
    - 고객이 "인형", "캐릭터", "아기 선물" 등을 원하면 반드시 category가 "메이트/캐릭터"인 상품 중에서만 추천하세요.
    - [추천 가중치] 요기보의 대표 상품은 "맥스(Max)" 입니다. 고객의 요청 조건에 소파가 부합한다면 무조건 "맥스" 계열을 최우선으로 추천 목록에 포함시켜 주세요.
    ${coverExclusionRule}
    
    위 전체 상품 목록에서 고객의 질문(예: "1인 가구", "원룸", "가족", "게임" 등)에 대해, [카테고리 매칭 필수 규칙]과 [교육된 지식 데이터]를 가장 우선적으로 참고하여 적합한 상품 딱 3개를 골라주세요. 지식 데이터에 특징/추천안이 언급된 상품이 있다면 무조건 우선 추천하세요.
    그리고 이 3개의 상품을 왜 추천하는지에 대한 고객용 안내 멘트를 작성해주세요. (구매 이력이 있다면 "지난번 구매하신 OO과 함께 쓰시면 좋아요" 같은 멘트를 꼭 넣어주세요.)
    
    반드시 아래 JSON 형식으로만 응답해야 합니다. 다른 말은 절대 추가하지 마세요.
    {
       "recommendedIds": ["상품ID1", "상품ID2", "상품ID3"],
       "message": "고객에게 전달할 매우 친절하고 구체적인 추천 멘트 (HTML <br>태그 사용 가능, 상품 이름과 가격, 추천 이유 포함)"
    }
    `;

    try {
      const gptRes = await axios.post(OPEN_URL, {
        model: FINETUNED_MODEL,
        temperature: 0.1, // 창의성보다는 정확한 JSON 출력을 위해 낮춤
        response_format: { type: "json_object" }, // JSON 형태 강제
        messages: [
          { role: "system", content: "당신은 요기보 상담원입니다. 제공된 상품 카탈로그 안에서만 상품을 선택하고, 반드시 명시된 JSON 포맷으로만 응답하세요." },
          { role: "user", content: prompt }
        ]
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });
      
      const parsed = JSON.parse(gptRes.data.choices[0].message.content);
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
