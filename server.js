const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const cors = require("cors");
const compression = require("compression");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { connectDB } = require("./config/db");
const { getTokensFromDB } = require("./config/cafe24Api");
const { fetchProductsFromCafe24, syncCafe24Orders } = require("./services/cafe24Service");
const { updateSearchableData } = require("./services/ragService");

const chatRoutes = require("./routes/chatRoutes");
const knowledgeRoutes = require("./routes/knowledgeRoutes");

const { PORT = 5000 } = process.env;

const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// Routes
app.use("/chat", chatRoutes);
app.use("/", knowledgeRoutes);

// ★ 서버 실행 로직
(async function initialize() {
  try { 
      console.log("🟡 서버 시작..."); 
      
      // 1. DB Connection Pool 초기화 (재사용 가능한 커넥션 풀)
      await connectDB();
      
      // 2. 외부 서비스(Cafe24) 토큰 및 데이터 로드
      await getTokensFromDB(); 
      await fetchProductsFromCafe24();
      
      // 3. 지식 및 FAQ 데이터 (RAG 검색용)
      await updateSearchableData(); 

      // 4. HTTP 서버 실행
      app.listen(PORT, () => console.log(`🚀 앱 실행 완료 (포트: ${PORT})`)); 

      // 5. 스케줄러 실행 (10분 간격 분할 조회)
      syncCafe24Orders(); 
      setInterval(syncCafe24Orders, 10 * 60 * 1000); 

  } catch (err) { 
      console.error("❌ 초기화 오류:", err.message); 
      process.exit(1); 
  }
})();