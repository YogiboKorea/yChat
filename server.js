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
const gameRoutes = require("./routes/gameRoutes");

const { PORT = 5000 } = process.env;

const app = express();

const allowedOrigins = [
  'https://yogibo.kr', 
  'http://skin-skin123.yogibo.cafe24.com', 
  'https://skin-skin123.yogibo.cafe24.com',
  'https://port-0-ychat-lzgmwhc4d9883c97.sel4.cloudtype.app'
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
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
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
app.use("/api/game", gameRoutes);

// ========== [추가] 디톡스 페이지 1회성 적립금 지급 이벤트 참여 여부 조회 ==========
app.get('/api/event/detox-reward/status', async (req, res) => {
  const { memberId } = req.query;

  if (!memberId || typeof memberId !== 'string' || memberId.startsWith('guest_')) {
    return res.status(400).json({ success: false, message: '유효하지 않은 회원 ID입니다.' });
  }

  try {
    const { getDB } = require("./config/db");
    const db = getDB();
    const collection = db.collection('detox_event_point_onOff');
    const alreadyParticipated = await collection.findOne({ memberId });
    if (alreadyParticipated) {
      return res.json({ success: true, alreadyDone: true });
    }
    return res.json({ success: true, alreadyDone: false });
  } catch (err) {
    console.error('[디톡스이벤트] 상태 조회 오류:', err);
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ========== [추가] 디톡스 페이지 1회성 적립금 지급 이벤트 API ==========
app.post('/api/event/detox-reward', async (req, res) => {
  const { memberId } = req.body;

  // 1. 비회원(guest_) 및 파라미터 유효성 검사
  if (!memberId || typeof memberId !== 'string' || memberId.startsWith('guest_')) {
    return res.status(400).json({ success: false, message: '로그인 후 참여 가능한 이벤트입니다.' });
  }

  const amount = 3000;

  try {
    const { getDB } = require("./config/db");
    const db = getDB();
    const collection = db.collection('detox_event_point_onOff');

    // 2. 중복 참여 확인
    const alreadyParticipated = await collection.findOne({ memberId });
    if (alreadyParticipated) {
      return res.status(400).json({ success: false, message: '이미 적립 혜택을 받으셨습니다.', alreadyDone: true });
    }

    // 3. Cafe24 API로 포인트 적립
    const { apiRequest } = require("./config/cafe24Api");
    const CAFE24_MALLID = process.env.CAFE24_MALLID || 'yogibo';
    
    const payload = {
      shop_no: 1,
      request: {
        member_id: memberId,
        order_id: null,
        amount: amount,
        type: 'increase',
        reason: '도파민 디톡스 3,000원 적립금 지급'
      }
    };

    await apiRequest(
      'POST',
      `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/points`,
      payload
    );

    // 4. 적립 성공 시 참여 기록 저장 (KST 기준)
    const nowKST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    await collection.insertOne({
      memberId,
      amount,
      participatedAt: nowKST
    });

    console.log(`[디톡스이벤트] ${memberId} 적립금 ${amount}원 지급 완료`);
    return res.json({ success: true, message: '🎉 3,000원 적립금이 지급되었습니다!' });

  } catch (err) {
    console.error('[디톡스이벤트] 포인트 지급 오류:', err);

    // Unique Index 충돌 에러 처리 (동시성 방어)
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: '이미 혜택을 받으셨습니다.', alreadyDone: true });
    }

    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
  }
});

// ========== [김포 매장] 이벤트매장 적립금 3,000원 (별도 컬렉션) ==========
app.get('/api/event/gimpo-reward/status', async (req, res) => {
  const { memberId } = req.query;
  if (!memberId || typeof memberId !== 'string' || memberId.startsWith('guest_')) {
    return res.status(400).json({ success: false, message: '유효하지 않은 회원 ID입니다.' });
  }
  try {
    const { getDB } = require("./config/db");
    const db = getDB();
    const alreadyParticipated = await db.collection('gimpo_event_point').findOne({ memberId });
    return res.json({ success: true, alreadyDone: !!alreadyParticipated });
  } catch (err) {
    console.error('[김포이벤트] 상태 조회 오류:', err);
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

app.post('/api/event/gimpo-reward', async (req, res) => {
  const { memberId } = req.body;
  if (!memberId || typeof memberId !== 'string' || memberId.startsWith('guest_')) {
    return res.status(400).json({ success: false, message: '로그인 후 참여 가능한 이벤트입니다.' });
  }

  const amount = 3000;

  try {
    const { getDB } = require("./config/db");
    const db = getDB();
    const collection = db.collection('gimpo_event_point');

    const alreadyParticipated = await collection.findOne({ memberId });
    if (alreadyParticipated) {
      return res.status(400).json({ success: false, message: '이미 적립 혜택을 받으셨습니다.', alreadyDone: true });
    }

    const { apiRequest } = require("./config/cafe24Api");
    const CAFE24_MALLID = process.env.CAFE24_MALLID || 'yogibo';

    const payload = {
      shop_no: 1,
      request: {
        member_id: memberId,
        order_id: null,
        amount: amount,
        type: 'increase',
        reason: '김포 매장 이벤트 3,000원 적립금 지급'
      }
    };

    await apiRequest(
      'POST',
      `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/points`,
      payload
    );

    const nowKST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    await collection.insertOne({ memberId, amount, participatedAt: nowKST });

    console.log(`[김포이벤트] ${memberId} 적립금 ${amount}원 지급 완료`);
    return res.json({ success: true, message: '🎉 3,000원 적립금이 지급되었습니다!' });

  } catch (err) {
    console.error('[김포이벤트] 포인트 지급 오류:', err);
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: '이미 혜택을 받으셨습니다.', alreadyDone: true });
    }
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
  }
});

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

    // 5.5 디톡스 이벤트 중복 방지 인덱스 (memberId = unique)
    await db.collection("detox_event_point_onOff").createIndex(
      { memberId: 1 },
      { unique: true, background: true }
    );
    console.log("✅ 디톡스 이벤트 중복방지 유니크 인덱스 설정 완료");

    // 김포 이벤트 중복 방지 인덱스
    await db.collection("gimpo_event_point").createIndex(
      { memberId: 1 },
      { unique: true, background: true }
    );
    console.log("✅ 김포 이벤트 중복방지 유니크 인덱스 설정 완료");

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