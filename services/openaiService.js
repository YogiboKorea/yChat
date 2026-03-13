const axios = require("axios");

const { OPEN_URL, API_KEY, FINETUNED_MODEL = "gpt-4o-mini" } = process.env;

async function getLLMResponse(currentSystemPrompt, input, context = []) {
  const txt = context.map(i => `Q: ${i.q}\nA: ${i.a}`).join("\n\n");
  const system = `${currentSystemPrompt}

[운영 규칙 - 매우 중요]
- 답변은 반드시 아래 [참고 정보]에서 근거가 확인되는 내용만 안내하세요.
- [참고 정보]에 없는 내용은 절대 추측하지 말고, "정확한 확인이 필요합니다"라고 말하세요.
- 고객에게 추가 확인이 필요한 정보(주문번호/구매처/제품명 등)가 있으면 먼저 요청하세요.

[참고 정보]
${txt || "정보 없음."}`;

  try {
    const res = await axios.post(
      OPEN_URL,
      {
        model: FINETUNED_MODEL,
        temperature: 0.2,
        top_p: 0.9,
        messages: [
          { role: "system", content: system },
          { role: "user", content: input }
        ]
      },
      { headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" } }
    );
    return res.data.choices?.[0]?.message?.content || "답변을 생성하지 못했습니다.";
  } catch (e) {
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

    const prompt = `
    당신은 요기보 세일즈 매니저입니다.
    고객 질문: "${userMsg}"
    구매 이력: ${purchaseHistory ? JSON.stringify(purchaseHistory.products) : "없음"}
    
    [교육된 지식 데이터(우선 순위가 가장 높음)]
    ${context.length > 0 ? context.map(c => `Q: ${c.q}\nA: ${c.a}`).join("\n\n") : "없음"}
    
    현재 판매중인 요기보 전체 상품 목록:
    ${productsJson}
    
    위 전체 상품 목록에서 고객의 질문(예: "1인 가구", "원룸", "가족", "게임" 등)에 대해, [교육된 지식 데이터]를 가장 우선적으로 참고하여 적합한 상품 딱 3개를 골라주세요. 지식 데이터에 특징/추천안이 언급된 상품이 있다면 무조건 우선 추천하세요.
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
        console.error("OpenAI Recommendation Error:", e);
        throw new Error("추천 멘트 생성 중 예외 발생"); 
    }
}

module.exports = {
    getLLMResponse,
    recommendProductsWithGPT
};
