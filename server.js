const path = require("path");
// 모든 커스텀 모듈을 불러오기 전에 .env가 가장 먼저 메모리에 올라가야 함
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const compression = require("compression");

const { connectDB } = require("./config/db");
const { getTokensFromDB } = require("./config/cafe24Api");
const { fetchProductsFromCafe24, syncCafe24Orders } = require("./services/cafe24Service");
const { updateSearchableData } = require("./services/ragService");

const chatRoutes = require("./routes/chatRoutes");
const knowledgeRoutes = require("./routes/knowledgeRoutes");

const { PORT = 5000 } = process.env;

const app = express();

const allowedOrigins = [
  'https://yogibo.kr', 
  'http://skin-skin123.yogibo.cafe24.com', 
  'https://skin-skin123.yogibo.cafe24.com'
];
app.use(cors({
  origin: function (origin, callback) {
    // origin이 없거나(서버 간 통신 등) 허용 목록에 있으면 통과
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true
}));

app.use(cors());
app.use(compression());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// Routes
const { router: legacyRoutes, initializeLegacyCronJobs } = require("./routes/legacyRoutes");



app.use("/chat", chatRoutes);
app.use("/", knowledgeRoutes);
app.use("/", legacyRoutes);

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

    // 3.5 레거시 크론 및 초기화 (블랙프라이데이 로직 등)
    await initializeLegacyCronJobs();

    // 4. HTTP 서버 실행
    app.listen(PORT, () => console.log(`🚀 앱 실행 완료 (포트: ${PORT})`));

    // 5. ★ [항목10] conversationLogs TTL 인덱스 설정 (365일 후 자동 삭제 - 개인정보 보호)
    const { getDB } = require("./config/db");
    const db = getDB();
    await db.collection("conversationLogs").createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 365 * 24 * 60 * 60, background: true }
    );
    // cafe24Orders도 3개월 후 자동 정리
    await db.collection("cafe24Orders").createIndex(
      { updatedAt: 1 },
      { expireAfterSeconds: 90 * 24 * 60 * 60, background: true }
    );
    console.log("✅ TTL 인덱스 설정 완료 (대화로그 365일 / 주문이력 90일 자동 삭제)");

    // 5. 스케줄러 실행
    // 기존 전체 매출 집계 스케줄러 비활성화 (Cafe24 503 우회 목적 - on-demand로 전환)
    // syncCafe24Orders(); 
    // setInterval(syncCafe24Orders, 10 * 60 * 1000); 

    setInterval(fetchProductsFromCafe24, 60 * 60 * 1000); // 추천 상품 데이터 풀 동기화 (1시간 간격 - CDN 장애시 자동 복구 및 신규 상품 업데이트 목적)

  } catch (err) {
    console.error("❌ 초기화 오류:", err.message);
    process.exit(1);
  }//123
})();