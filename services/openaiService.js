const axios = require("axios");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

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

async function recommendProductsWithGPT(userMsg, purchaseHistory, top3Products) {
    const prompt = `
    당신은 요기보 세일즈 매니저입니다.
    고객 질문: "${userMsg}"
    구매 이력: ${purchaseHistory ? JSON.stringify(purchaseHistory.products) : "없음"}
    추천 상품 목록:
    ${top3Products.map(p => `- ${p.name} (${p.price}원): ${p.reasons.join(", ")}`).join("\n")}
    
    위 정보를 바탕으로 고객에게 자연스럽게 상품을 추천하는 멘트를 작성해주세요.
    구매 이력이 있다면 "지난번 구매하신 OO과 함께 쓰시면 좋아요" 같은 멘트를 꼭 넣어주세요.
    `;

    try {
      const gptRes = await axios.post(OPEN_URL, {
        model: FINETUNED_MODEL,
        temperature: 0.5,
        messages: [
          { role: "system", content: "당신은 요기보 상담원입니다. 근거 없는 단정/과장 표현은 피하고, 제공된 정보 범위에서만 추천 멘트를 작성하세요." },
          { role: "user", content: prompt }
        ]
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });
      
      return gptRes.data.choices[0].message.content;
    } catch (e) { 
        throw new Error("추천 멘트 생성 중 예외 발생"); 
    }
}

module.exports = {
    getLLMResponse,
    recommendProductsWithGPT
};
