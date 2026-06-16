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
  'https://www.yogibo.kr',
  'http://skin-skin123.yogibo.cafe24.com',
  'https://skin-skin123.yogibo.cafe24.com',
  'https://port-0-ychat-lzgmwhc4d9883c97.sel4.cloudtype.app',
  'https://design-six-zeta.vercel.app',
  'http://localhost:3000',
  'https://design-8m6dyzko3-yogibos-projects.vercel.app',
  'https://vmd-img.vercel.app',
  'https://vmd-img-yogibos-projects.vercel.app'
  
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

  const amount = 5000;

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
        reason: '도파민 디톡스 5,000원 적립금 지급'
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

// ========== [추가] 06 응원 페스타 슛챌린지 게임 이벤트 (적립금 5,000원·1인1회·중복차단) ==========
// 데이터: MongoDB '06gameEvent' 컬렉션 — 회원 1인 1문서(중복차단) + 적립금 수령여부 / 난이도(확률) 설정 문서(cfgKey)
const GAME06_COLLECTION = '06gameEvent';
const GAME06_CREDIT_AMOUNT = 5000; // 지급 적립금
const GAME06_MIN_GOALS = 5;        // 적립금 자격 최소 골 수
const GAME06_DEFAULT_DIFFICULTY = { accuracy: 0.35, lateAccuracy: 0.4, reactionMs: 70, noise: 130, lateNoise: 100 };
// 표준 UTC instant 저장(표시는 관리자에서 KST로 변환) — 이중 변환 버그 방지
const game06Now = () => new Date();
const game06Clamp = (v, min, max, def) => { const n = Number(v); if (!isFinite(n)) return def; return Math.min(max, Math.max(min, n)); };
const game06IsMember = (m) => !!m && typeof m === 'string' && !m.startsWith('guest_') && m !== 'GUEST' && m !== 'null';

// 1) 참여여부 / 적립금 수령여부 조회 (게임 로드 시 → 버튼 "지급 완료" 초기표시)
app.get('/api/event/cheer-festa/status', async (req, res) => {
  const { memberId } = req.query;
  if (!game06IsMember(memberId)) return res.json({ success: true, participated: false, creditClaimed: false, bestGoals: 0 });
  try {
    const { getDB } = require("./config/db");
    const doc = await getDB().collection(GAME06_COLLECTION).findOne({ memberId });
    return res.json({ success: true, participated: !!doc, creditClaimed: !!(doc && doc.creditClaimed), bestGoals: doc ? (doc.bestGoals || 0) : 0 });
  } catch (err) {
    console.error('[06게임이벤트] status 오류:', err);
    return res.status(500).json({ success: false, participated: false, creditClaimed: false, bestGoals: 0 });
  }
});

// 2) 참여 기록 (회원 전용) — 1인 1문서 upsert
app.post('/api/event/cheer-festa/participate', async (req, res) => {
  const { memberId, goals, tier, hasCredit, hasDraw } = req.body || {};
  if (!game06IsMember(memberId)) return res.status(400).json({ success: false, message: '회원 전용 이벤트입니다.' });
  const g = game06Clamp(goals, 0, 10, 0);
  try {
    const { getDB } = require("./config/db");
    const col = getDB().collection(GAME06_COLLECTION);
    const now = game06Now();
    await col.updateOne(
      { memberId },
      {
        $set: { isMember: true, lastPlayedAt: now, lastGoals: g, lastTier: tier || (hasDraw ? 'draw' : hasCredit ? 'credit' : 'none') },
        $setOnInsert: { memberId, firstPlayedAt: now, creditClaimed: false, creditAmount: 0 },
        $max: { bestGoals: g },
        $inc: { playCount: 1 }
      },
      { upsert: true }
    );
    const doc = await col.findOne({ memberId });
    return res.json({ success: true, participated: true, creditClaimed: !!(doc && doc.creditClaimed), bestGoals: doc ? (doc.bestGoals || g) : g });
  } catch (err) {
    if (err.code === 11000) {
      try { const { getDB } = require("./config/db"); const doc = await getDB().collection(GAME06_COLLECTION).findOne({ memberId }); return res.json({ success: true, participated: true, creditClaimed: !!(doc && doc.creditClaimed), bestGoals: doc ? (doc.bestGoals || g) : g }); } catch (e) {}
    }
    console.error('[06게임이벤트] participate 오류:', err);
    return res.status(500).json({ success: false, message: '참여 기록 중 오류가 발생했습니다.' });
  }
});

// 3) 적립금 지급 (5골+, 1인 1회) — 원자적 선점 후 지급, 실패 시 롤백
app.post('/api/event/cheer-festa/reward', async (req, res) => {
  const { memberId, goals } = req.body || {};
  if (!game06IsMember(memberId)) return res.status(400).json({ success: false, message: '로그인 후 참여 가능한 이벤트입니다.' });
  try {
    const { getDB } = require("./config/db");
    const { apiRequest } = require("./config/cafe24Api");
    const CAFE24_MALLID = process.env.CAFE24_MALLID || 'yogibo';
    const col = getDB().collection(GAME06_COLLECTION);
    const now = game06Now();

    // 자격 확인: 참여 기록상 최고골(또는 이번 결과) 5골 이상
    const p = await col.findOne({ memberId });
    const best = Math.max(p ? (p.bestGoals || 0) : 0, game06Clamp(goals, 0, 10, 0));
    if (best < GAME06_MIN_GOALS) return res.status(400).json({ success: false, message: `${GAME06_MIN_GOALS}골 이상 기록이 필요합니다.` });

    // 원자적 선점: creditClaimed !== true 인 문서만 true 로 전환(없으면 upsert)
    let upd;
    try {
      upd = await col.updateOne(
        { memberId, creditClaimed: { $ne: true } },
        { $set: { creditClaimed: true, claimedAt: now, creditAmount: GAME06_CREDIT_AMOUNT, isMember: true }, $setOnInsert: { memberId, firstPlayedAt: now, lastPlayedAt: now, playCount: 0 }, $max: { bestGoals: best } },
        { upsert: true }
      );
    } catch (claimErr) {
      if (claimErr.code === 11000) {
        const cur = await col.findOne({ memberId });
        if (cur && cur.creditClaimed) return res.status(400).json({ success: false, alreadyDone: true, message: '이미 적립금을 받으셨습니다.' });
        upd = await col.updateOne({ memberId, creditClaimed: { $ne: true } }, { $set: { creditClaimed: true, claimedAt: now, creditAmount: GAME06_CREDIT_AMOUNT, isMember: true }, $max: { bestGoals: best } });
        if (upd.modifiedCount === 0) return res.status(400).json({ success: false, alreadyDone: true, message: '이미 적립금을 받으셨습니다.' });
      } else throw claimErr;
    }
    if (upd.modifiedCount === 0 && upd.upsertedCount === 0) return res.status(400).json({ success: false, alreadyDone: true, message: '이미 적립금을 받으셨습니다.' });

    // 적립금 지급 (Cafe24 Admin Points API)
    try {
      await apiRequest('POST', `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/points`, {
        shop_no: 1,
        request: { member_id: memberId, order_id: null, amount: GAME06_CREDIT_AMOUNT, type: 'increase', reason: '응원 페스타 슛챌린지 적립금' }
      });
    } catch (payErr) {
      await col.updateOne({ memberId }, { $set: { creditClaimed: false }, $unset: { claimedAt: '', creditAmount: '' } });
      console.error('[06게임이벤트] 적립금 지급 오류:', payErr.response?.data || payErr.message);
      return res.status(500).json({ success: false, message: '적립금 지급 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
    }
    console.log(`[06게임이벤트] ${memberId} 적립금 ${GAME06_CREDIT_AMOUNT}원 지급 완료 (best=${best})`);
    return res.json({ success: true, message: `🎉 ${GAME06_CREDIT_AMOUNT.toLocaleString()}원 적립금이 지급되었습니다!` });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ success: false, alreadyDone: true, message: '이미 적립금을 받으셨습니다.' });
    console.error('[06게임이벤트] reward 오류:', err);
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 4) 난이도(확률) 설정 조회 — 게임/관리자 공용 (06gameEvent 내 cfgKey 문서)
app.get('/api/event/cheer-festa/config', async (req, res) => {
  try {
    const { getDB } = require("./config/db");
    const doc = await getDB().collection(GAME06_COLLECTION).findOne({ cfgKey: 'difficulty' });
    const difficulty = (doc && doc.difficulty) ? { ...GAME06_DEFAULT_DIFFICULTY, ...doc.difficulty } : GAME06_DEFAULT_DIFFICULTY;
    return res.json({ success: true, difficulty, updatedAt: doc ? doc.updatedAt : null });
  } catch (err) {
    console.error('[06게임이벤트] config get 오류:', err);
    return res.json({ success: true, difficulty: GAME06_DEFAULT_DIFFICULTY });
  }
});

// 5) 난이도(확률) 설정 저장 — 관리자
app.post('/api/event/cheer-festa/config', async (req, res) => {
  const { difficulty } = req.body || {};
  if (!difficulty || typeof difficulty !== 'object') return res.status(400).json({ success: false, message: 'difficulty 객체가 필요합니다.' });
  const clean = {
    accuracy: game06Clamp(difficulty.accuracy, 0, 1, GAME06_DEFAULT_DIFFICULTY.accuracy),
    lateAccuracy: game06Clamp(difficulty.lateAccuracy, 0, 1, GAME06_DEFAULT_DIFFICULTY.lateAccuracy),
    reactionMs: game06Clamp(difficulty.reactionMs, 0, 2000, GAME06_DEFAULT_DIFFICULTY.reactionMs),
    noise: game06Clamp(difficulty.noise, 0, 1000, GAME06_DEFAULT_DIFFICULTY.noise),
    lateNoise: game06Clamp(difficulty.lateNoise, 0, 1000, GAME06_DEFAULT_DIFFICULTY.lateNoise),
  };
  try {
    const { getDB } = require("./config/db");
    await getDB().collection(GAME06_COLLECTION).updateOne(
      { cfgKey: 'difficulty' },
      { $set: { cfgKey: 'difficulty', difficulty: clean, updatedAt: game06Now() } },
      { upsert: true }
    );
    return res.json({ success: true, difficulty: clean });
  } catch (err) {
    console.error('[06게임이벤트] config post 오류:', err);
    return res.status(500).json({ success: false, message: '설정 저장에 실패했습니다.' });
  }
});

// 6) 참여자 목록 + 요약 (관리자) — 설정문서(cfgKey) 제외
app.get('/api/event/cheer-festa/participants', async (req, res) => {
  try {
    const { getDB } = require("./config/db");
    const col = getDB().collection(GAME06_COLLECTION);
    const list = await col.find({ memberId: { $exists: true } }).sort({ lastPlayedAt: -1 }).limit(5000).toArray();
    const summary = {
      total: list.length,
      members: list.filter(d => d.isMember !== false).length,
      qualified: list.filter(d => (d.bestGoals || 0) >= GAME06_MIN_GOALS).length,
      claimed: list.filter(d => d.creditClaimed).length,
      creditTotal: list.filter(d => d.creditClaimed).length * GAME06_CREDIT_AMOUNT
    };
    const participants = list.map(d => ({
      memberId: d.memberId || null,
      guestId: null,
      isMember: d.isMember !== false,
      bestGoals: d.bestGoals || 0,
      playCount: d.playCount || 0,
      creditClaimed: !!d.creditClaimed,
      creditAmount: d.creditAmount || 0,
      claimedAt: d.claimedAt || null,
      lastPlayedAt: d.lastPlayedAt || null
    }));
    return res.json({ success: true, summary, participants });
  } catch (err) {
    console.error('[06게임이벤트] participants 오류:', err);
    return res.status(500).json({ success: false, message: '참여자 조회 실패' });
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

    // 3.6 onlineData 일일 동기화 크론 (격리: 별도 자식 프로세스로 실행, ENABLE_ONLINE_SYNC=1 일 때만)
    //     실패해도 챗 서버 기동에 영향 없도록 try/catch 로 격리.
    try { require("./onlinesync/cron"); } catch (e) { console.error("[onlinesync] 로드 실패(무시):", e.message); }

    // 3.7 Cafe24 토큰 "선제 갱신" 크론 — 본체 프로세스에서 refreshAccessToken 과 같은 인스턴스로 실행.
    //     매시 정각(KST) 만료 전 회전 → onlineData 라이브 API 호출의 401 을 구조적으로 예방.
    try { require("./config/tokenKeepalive"); } catch (e) { console.error("[token-keepalive] 로드 실패(무시):", e.message); }

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

    // 06 게임 이벤트 중복 방지 인덱스 (memberId unique, sparse: 난이도 설정문서 제외)
    await db.collection("06gameEvent").createIndex(
      { memberId: 1 },
      { unique: true, sparse: true, background: true }
    );
    console.log("✅ 06게임이벤트 중복방지 유니크 인덱스 설정 완료");

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