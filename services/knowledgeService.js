const { getDB } = require("../config/db");

async function saveConversationLog(mid, uMsg, bRes) {
    const db = getDB();
    try { 
        await db.collection("conversationLogs").updateOne(
            { memberId: mid || null, date: new Date().toISOString().split("T")[0] }, 
            { $push: { conversation: { userMessage: uMsg, botResponse: bRes, createdAt: new Date() } } }, 
            { upsert: true }
        ); 
    } catch(e) { 
        console.error("대화내역 저장 오류:", e); 
    }
}

module.exports = {
    saveConversationLog
};
