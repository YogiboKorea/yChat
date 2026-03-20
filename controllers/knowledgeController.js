const { getDB } = require("../config/db");
const { updateSearchableData, addItemToSearchable, removeItemFromSearchable, updateItemInSearchable } = require("../services/ragService");
const { ObjectId } = require("mongodb");
const fs = require("fs");
const ftp = require('basic-ftp');
const pdfParse = require('pdf-extraction');
const ExcelJS = require("exceljs");
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const { FTP_PUBLIC_BASE, YOGIBO_FTP, YOGIBO_FTP_ID, YOGIBO_FTP_PW } = process.env;

async function handleChatSend(req, res) {
    const { role, content } = req.body;
    const db = getDB();
    try {
        if (req.file) {
            req.file.originalname = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
            if (req.file.mimetype === 'application/pdf') {
                const dataBuffer = fs.readFileSync(req.file.path); 
                const data = await pdfParse(dataBuffer);
                const cleanText = data.text.replace(/\n\n+/g, '\n').replace(/\s+/g, ' ').trim();
                const chunks = []; 
                for (let i = 0; i < cleanText.length; i += 500) chunks.push(cleanText.substring(i, i + 500));
                const docs = chunks.map((chunk, index) => ({ category: "pdf-knowledge", question: `[PDF 학습데이터] ${req.file.originalname} (Part ${index + 1})`, answer: chunk, createdAt: new Date() }));
                if (docs.length > 0) {
                    const result = await db.collection("postItNotes").insertMany(docs);
                    // ★ [경량] 전체 재로드 대신 새 청크만 직접 메모리에 추가 (비동기 다수 병렬 체어)
                    const insertedIds = Object.values(result.insertedIds);
                    await Promise.all(docs.map((doc, i) => addItemToSearchable({ ...doc, _id: insertedIds[i] })));
                }
                fs.unlink(req.file.path, () => {}); 
                return res.json({ message: `PDF 분석 완료! 총 ${docs.length}개의 데이터로 학습되었습니다.` });
            }
        }
        if (role && content) {
            const fullPrompt = `역할: ${role}\n지시사항: ${content}`;
            await db.collection("systemPrompts").insertOne({ role, content: fullPrompt, createdAt: new Date() });
            // ★ LLM 역할 변경은 시스템 프롬프트 전체에 영향을 주므로 기존적으로 전체 리로드
            await updateSearchableData();
            return res.json({ message: "LLM 역할 설정이 완료되었습니다." });
        }
        res.status(400).json({ error: "파일이나 내용이 없습니다." });
    } catch (e) { 
        if (req.file) fs.unlink(req.file.path, () => {}); 
        res.status(500).json({ error: e.message }); 
    }
}

async function uploadKnowledgeImage(req, res) {
    const { keyword } = req.body;
    const db = getDB();
    const ftpClient = new ftp.Client();
    if (!req.file || !keyword) return res.status(400).json({ error: "필수 정보 누락" });
    
    req.file.originalname = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    try {
        const cleanFtpHost = YOGIBO_FTP.replace(/^(http:\/\/|https:\/\/|ftp:\/\/)/, '').replace(/\/$/, '');
        await ftpClient.access({ host: cleanFtpHost, user: YOGIBO_FTP_ID, password: YOGIBO_FTP_PW, secure: false });
        try { await ftpClient.ensureDir("web"); await ftpClient.ensureDir("chat"); } catch (dirErr) { await ftpClient.cd("/"); await ftpClient.ensureDir("www"); await ftpClient.ensureDir("chat"); }
        const safeFilename = `${Date.now()}_${Math.floor(Math.random()*1000)}.jpg`;
        await ftpClient.uploadFrom(req.file.path, safeFilename);
        const remotePath = "web/chat"; const publicBase = FTP_PUBLIC_BASE || `http://${cleanFtpHost}`;
        const imageUrl = `${publicBase}/${remotePath}/${safeFilename}`.replace(/([^:]\/)\/+/g, '$1');
        const insertedDoc = { category: "image-knowledge", question: keyword, answer: `<img src="${imageUrl}" style="max-width:100%; border-radius:10px; margin-top:10px;">`, createdAt: new Date() };
        const insertResult = await db.collection("postItNotes").insertOne(insertedDoc);
        fs.unlink(req.file.path, () => {}); ftpClient.close();
        // ★ [경량] 이미지 항목만 메모리에 추가 (전체 재로드 안 함)
        await addItemToSearchable({ ...insertedDoc, _id: insertResult.insertedId });
        res.json({ message: "이미지 지식 등록 완료" });
    } catch (e) { 
        if (req.file) fs.unlink(req.file.path, () => {}); 
        ftpClient.close(); 
        res.status(500).json({ error: e.message }); 
    }
}

async function updatePostIt(req, res) {
    const { id } = req.params; const { question, answer } = req.body; const file = req.file;
    const db = getDB(); const ftpClient = new ftp.Client();
    try {
        let newAnswer = answer;
        if (file) {
            file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
            const safeFilename = `${Date.now()}_edit.jpg`;
            const cleanFtpHost = YOGIBO_FTP.replace(/^(http:\/\/|https:\/\/|ftp:\/\/)/, '').replace(/\/$/, '');
            await ftpClient.access({ host: cleanFtpHost, user: YOGIBO_FTP_ID, password: YOGIBO_FTP_PW, secure: false });
            try { await ftpClient.ensureDir("web"); await ftpClient.ensureDir("chat"); } catch (dirErr) { await ftpClient.cd("/"); await ftpClient.ensureDir("www"); await ftpClient.ensureDir("chat"); }
            await ftpClient.uploadFrom(file.path, safeFilename);
            const remotePath = "web/chat"; const publicBase = FTP_PUBLIC_BASE || `http://${cleanFtpHost}`;
            const imageUrl = `${publicBase}/${remotePath}/${safeFilename}`.replace(/([^:]\/)\/+/g, '$1');
            newAnswer = `<img src="${imageUrl}" style="max-width:100%; border-radius:10px; margin-top:10px;">`;
            fs.unlink(file.path, () => {}); ftpClient.close();
        }
        await db.collection("postItNotes").updateOne({ _id: new ObjectId(id) }, { $set: { question, answer: newAnswer, updatedAt: new Date() } });
        // ★ [경량] 해당 항목만 메모리에서 교체
        await updateItemInSearchable(id, { category: req.body.category, question, answer: newAnswer });
        res.json({ message: "수정 완료" });
    } catch (e) { 
        if (file) fs.unlink(file.path, () => {}); ftpClient.close(); res.status(500).json({ error: e.message }); 
    }
}

async function deletePostIt(req, res) { 
    const { id } = req.params; const db = getDB(); const ftpClient = new ftp.Client();
    try {
        const targetPost = await db.collection("postItNotes").findOne({ _id: new ObjectId(id) });
        if (targetPost) {
            const imgMatch = targetPost.answer && targetPost.answer.match(/src="([^"]+)"/);
            if (imgMatch) {
                const fullUrl = imgMatch[1]; const filename = fullUrl.split('/').pop();
                if (filename) {
                    try {
                        const cleanFtpHost = YOGIBO_FTP.replace(/^(http:\/\/|https:\/\/|ftp:\/\/)/, '').replace(/\/$/, '');
                        await ftpClient.access({ host: cleanFtpHost, user: YOGIBO_FTP_ID, password: YOGIBO_FTP_PW, secure: false });
                        await ftpClient.remove(`web/chat/${filename}`).catch(async () => { await ftpClient.remove(`www/chat/${filename}`).catch(() => {}); });
                        ftpClient.close();
                    } catch (ftpErr) { ftpClient.close(); }
                }
            }
        }
        await db.collection("postItNotes").deleteOne({ _id: new ObjectId(id) });
        // ★ [경량] 메모리에서만 제거 (전체 재로드 안 함)
        removeItemFromSearchable(id);
        res.json({ message: "OK" });
    } catch(e) { res.status(500).json({ error: e.message }); }
}

async function getPostIts(req, res) {
    const p = parseInt(req.query.page)||1; const l=300;
    try { 
        const db = getDB(); 
        const f = req.query.category ? {category: req.query.category} : {}; 
        const n = await db.collection("postItNotes").find(f).sort({_id:-1}).skip((p-1)*l).limit(l).toArray(); 
        res.json({notes: n, currentPage: p}); 
    } catch(e){ res.status(500).json({error:e.message}) }
}

async function createPostIt(req,res) { 
    try{
        const db = getDB();
        const result = await db.collection("postItNotes").insertOne({...req.body, createdAt:new Date()});
        // ★ [경량] 새 항목만 메모리에 추가 (전체 재로드 안 함)
        await addItemToSearchable({ ...req.body, _id: result.insertedId });
        res.json({message:"OK"})
    } catch(e){ res.status(500).json({error:e.message}) } 
}

async function exportChatLogs(req,res){ 
    try{
        const db = getDB();
        const d = await db.collection("conversationLogs").find({}).toArray();
        const wb=new ExcelJS.Workbook();
        const ws=wb.addWorksheet('Log');
        ws.columns=[{header:'ID',key:'m'},{header:'Date',key:'d'},{header:'Log',key:'c'}]; 
        d.forEach(r=>ws.addRow({m:r.memberId||'Guest',d:r.date,c:JSON.stringify(r.conversation)})); 
        res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition","attachment; filename=log.xlsx"); 
        await wb.xlsx.write(res);
        res.end();
    } catch(e){ res.status(500).send("Err") } 
}

module.exports = {
    handleChatSend,
    uploadKnowledgeImage,
    updatePostIt,
    deletePostIt,
    getPostIts,
    createPostIt,
    exportChatLogs
};
