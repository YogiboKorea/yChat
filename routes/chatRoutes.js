const express = require("express");
const router = express.Router();
const chatController = require("../controllers/chatController");

router.post("/", chatController.handleChat);
router.post("/feedback", chatController.handleFeedback);
router.get("/feedback", chatController.getFeedbacks);
router.delete("/feedback/:id", chatController.deleteFeedback);

module.exports = router;
