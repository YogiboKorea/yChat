const { findRuleBasedAnswer, findAllRelevantContent } = require("../services/ragService");
const { getLLMResponse } = require("../services/openaiService");
const { getMemberPurchaseHistory } = require("../services/cafe24Service");
const { saveConversationLog } = require("../services/knowledgeService");
const { formatResponseText, FALLBACK_MESSAGE_HTML } = require("../utils/helpers");

async function handleChat(req, res) {
  const { message, memberId } = req.body;
  if (!message) return res.status(400).json({ error: "No message" });

  try {
    const ruleAnswer = await findRuleBasedAnswer(message, memberId);
    if (ruleAnswer) {
      await saveConversationLog(memberId, message, ruleAnswer.text);
      return res.json(ruleAnswer);
    }

    const docs = findAllRelevantContent(message);
    const bestScore = docs.length > 0 ? docs[0].score : 0;

    const isPersonalQuery = /(내 정보|아이디|구매이력|장바구니|안녕|반가|결제|최근|뭐야|누구|이름)/.test(message);

    if ((!docs || docs.length === 0 || bestScore < 12) && !isPersonalQuery) {
      const fallback = `정확한 정보 확인이 필요합니다.${FALLBACK_MESSAGE_HTML}`;
      await saveConversationLog(memberId, message, fallback);
      return res.json({ text: fallback });
    }

    // getCurrentSystemPrompt는 RAG쪽의 최신 데이터를 받아오기 위함
    const { getCurrentSystemPrompt } = require("../services/ragService");
    
    let historyText = "없음";
    if (memberId && memberId !== "null" && memberId !== "undefined") {
       const history = await getMemberPurchaseHistory(memberId);
       if (history && history.products && history.products.length > 0) {
           historyText = history.products.join(", ");
       }
    }

    const personalInfoContext = `
[현재 대화 중인 고객 정보]
- 고객 ID: ${memberId && memberId !== "null" ? memberId : "비로그인 상태"}
- 최근 2개월 구매 이력(상품명): ${historyText}
(고객이 자신의 정보나 취향을 물어보면 이 정보를 바탕으로 대답해주세요. 만약 장바구니 조회를 요청하면 보안상 챗봇에서는 장바구니 조회가 불가능하다고 친절하게 안내하세요.)`;

    let gptAnswer = await getLLMResponse(getCurrentSystemPrompt() + personalInfoContext, message, docs); 
    gptAnswer = formatResponseText(gptAnswer);

    if (gptAnswer.includes("NO_CONTEXT")) {
      const fallback = `정확한 정보 확인이 필요합니다.${FALLBACK_MESSAGE_HTML}`;
      await saveConversationLog(memberId, message, fallback);
      return res.json({ text: fallback });
    }

    await saveConversationLog(memberId, message, gptAnswer);
    return res.json({ text: gptAnswer });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ text: "오류가 발생했습니다." });
  }
}

module.exports = {
  handleChat
};
