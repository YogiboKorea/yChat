const { ObjectId } = require("mongodb");
const { findRuleBasedAnswer, findAllRelevantContent, getCurrentSystemPrompt } = require("../services/ragService");
const { getLLMResponse } = require("../services/openaiService");
const { getMemberPurchaseHistory, syncCafe24Orders } = require("../services/cafe24Service");
const { saveConversationLog } = require("../services/knowledgeService");
const { getDB } = require("../config/db");
const { formatResponseText, FALLBACK_MESSAGE_HTML } = require("../utils/helpers");

async function handleChat(req, res) {
  const { message, memberId } = req.body;
  if (!message) return res.status(400).json({ error: "No message" });

  try {
    // ★ [항목6] DB에서 해당 회원의 최근 3개 대화 이력 우선 조회 (문맥 파악 및 상담 사전질문 로직용)
    const db = getDB();
    let conversationHistory = [];
    try {
      const logs = await db.collection("conversationLogs")
        .find({ memberId: memberId || null })
        .sort({ _id: -1 })
        .limit(2)
        .toArray();
      const allTurns = logs.flatMap(l => l.conversation || []);
      conversationHistory = allTurns.slice(-3); // 최근 3턴
    } catch (e) { /* 대화이력 조회 실패해도 정상 작동 */ }

    const ruleAnswer = await findRuleBasedAnswer(message, memberId);
    if (ruleAnswer) {
      await saveConversationLog(memberId, message, ruleAnswer.text);
      return res.json(ruleAnswer);
    }

    const docs = await findAllRelevantContent(message);
    const isPersonalQuery = /(내 정보|아이디|구매이력|장바구니|안녕|반가|결제|최근|뭐야|누구|이름)/.test(message);

    if ((!docs || docs.length === 0) && !isPersonalQuery) {
      // 바로 Fallback 버튼을 띄우는 대신, AI가 일반 상식이나 제공된 카탈로그 내에서 대답할 수 있도록 그냥 넘김.
      console.log(`[RAG] 검색결과가 없어 일반 LLM 프롬프트로 처리: ${message}`);
    }

    // ★ [항목4 연동] 쿨타임 적용된 syncCafe24Orders (30분 내 중복 호출 자동 스킵)
    let historyText = "없음";
    if (memberId && memberId !== "null" && memberId !== "undefined") {
      await syncCafe24Orders(memberId);
      const history = await getMemberPurchaseHistory(memberId);
      if (history && history.products && history.products.length > 0) {
        historyText = history.products.join(", ");
      }
    }

    const personalInfoContext = `
[현재 대화 중인 고객 정보]
- 고객 ID: ${memberId && memberId !== "null" ? memberId : "비로그인 상태"}
- 최근 1개월 구매 이력(상품명): ${historyText}
(고객이 자신의 정보나 취향을 물어보면 이 정보를 바탕으로 대답해주세요. 만약 장바구니 조회를 요청하면 보안상 챗봇에서는 장바구니 조회가 불가능하다고 친절하게 안내하세요.)`;

    let gptAnswer = await getLLMResponse(getCurrentSystemPrompt() + personalInfoContext, message, docs, conversationHistory);
    gptAnswer = formatResponseText(gptAnswer);

    if (gptAnswer.includes("NO_CONTEXT")) {
      const fallback = `${FALLBACK_MESSAGE_HTML}`;
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

async function handleFeedback(req, res) {
  const { message, memberId } = req.body;
  if (!message) return res.status(400).json({ error: "No message" });
  
  try {
    const db = getDB();
    await db.collection("chatFeedback").insertOne({
      memberId: memberId || "비로그인",
      message: message,
      createdAt: new Date()
    });
    return res.json({ text: "소중한 의견 감사합니다. 더 발전하는 요기보 챗봇이 되겠습니다!" });
  } catch (e) {
    console.error("Feedback API Error:", e);
    return res.status(500).json({ text: "의견 접수 중 문제가 발생했습니다." });
  }
}

async function getFeedbacks(req, res) {
  try {
    const db = getDB();
    const feedbacks = await db.collection("chatFeedback")
      .find({})
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    return res.json(feedbacks);
  } catch (e) {
    console.error("GetFeedbacks API Error:", e);
    return res.status(500).json({ error: "Failed to fetch feedbacks" });
  }
}

async function deleteFeedback(req, res) {
  const { id } = req.params;
  try {
    const db = getDB();
    await db.collection("chatFeedback").deleteOne({ _id: new ObjectId(id) });
    return res.json({ success: true });
  } catch (e) {
    console.error("DeleteFeedback API Error:", e);
    return res.status(500).json({ error: "Failed to delete feedback" });
  }
}

module.exports = {
  handleChat,
  handleFeedback,
  getFeedbacks,
  deleteFeedback
};
