const { findRuleBasedAnswer, findAllRelevantContent } = require("../services/ragService");
const { getLLMResponse } = require("../services/openaiService");
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

    if (!docs || docs.length === 0 || bestScore < 12) {
      const fallback = `정확한 정보 확인이 필요합니다.${FALLBACK_MESSAGE_HTML}`;
      await saveConversationLog(memberId, message, fallback);
      return res.json({ text: fallback });
    }

    // getCurrentSystemPrompt는 RAG쪽의 최신 데이터를 받아오기 위함
    const { getCurrentSystemPrompt } = require("../services/ragService");
    let gptAnswer = await getLLMResponse(getCurrentSystemPrompt(), message, docs); 
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
