const express = require("express");
const router = express.Router();
const multer = require('multer');
const path = require("path");
const fs = require("fs");
const knowledgeController = require("../controllers/knowledgeController");

const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadDir),
        filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`)
    }),
    limits: { fileSize: 50 * 1024 * 1024 }
});

router.post("/chat_send", upload.single('file'), knowledgeController.handleChatSend);
router.post("/upload_knowledge_image", upload.single('image'), knowledgeController.uploadKnowledgeImage);
router.put("/postIt/:id", upload.single('image'), knowledgeController.updatePostIt);
router.delete("/postIt/:id", knowledgeController.deletePostIt);
router.get("/postIt", knowledgeController.getPostIts);
router.post("/postIt", knowledgeController.createPostIt);
router.get("/chatConnet", knowledgeController.exportChatLogs);

module.exports = router;
