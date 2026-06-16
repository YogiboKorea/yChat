'use strict';

/**
 * Cafe24 액세스 토큰 "선제 갱신" 크론 — onlineData 대시보드의 라이브 API 호출이
 * 토큰 만료(401)를 만나지 않도록, 만료되기 전에 미리 토큰을 회전(refresh)시킨다.
 *
 *   왜 메인 프로세스 안에서 도는가:
 *     · 반드시 ychat 본체(메인 프로세스)에서 config/cafe24Api 와 "같은 모듈 인스턴스"로 실행한다.
 *       → cafe24Api 의 in-memory 뮤텍스(refreshPromise)를 공유하므로, 반응형 401 갱신과
 *         동시에 일어나도 refresh_token 을 "단 한 번만" 회전시킨다(중복 회전 = invalid_grant 방지).
 *     · onlinesync 의 일일동기화는 자식 프로세스라 뮤텍스 공유가 안 됨 → 토큰 갱신은 여기(본체)에서만.
 *
 *   타이밍:
 *     · Cafe24 access_token 수명 ≈ 2시간. 기본 매시 정각(60분 간격)으로 갱신해 항상 2배 여유.
 *     · 단, 직전 50분 안에 (반응형 401 또는 직전 cron 으로) 이미 갱신됐으면 스킵 → 불필요한 회전 최소화.
 *     · refresh_token 도 같이 회전되므로 미사용 만료(약 2주)도 자연 방지된다.
 *
 *   env:
 *     ENABLE_TOKEN_KEEPALIVE=0     → 비활성(기본은 활성).
 *     TOKEN_KEEPALIVE_CRON         → 크론식(기본 '0 * * * *' = 매시 정각, KST).
 *     TOKEN_KEEPALIVE_FRESH_MS     → "아직 신선" 판단 임계(기본 3,000,000ms = 50분).
 *     TOKEN_KEEPALIVE_ON_BOOT=0    → 기동 직후 1회 즉시 갱신 비활성(기본은 활성, 20초 지연).
 *     NODE_APP_INSTANCE            → pm2 cluster 시 '0' 인스턴스에서만 예약(다중 프로세스 동시 회전 방지).
 */

const cafe24 = require('./cafe24Api');
const { getDB } = require('./db');

let cron = null;
try { cron = require('node-cron'); } catch (_) { cron = null; }

const TOKEN_COLL = process.env.CAFE24_TOKEN_COLLECTION || 'tokens';
const FRESH_MS = Number(process.env.TOKEN_KEEPALIVE_FRESH_MS || 50 * 60 * 1000); // 50분

let running = false; // 이 모듈 자체의 중복 호출 방지(refreshAccessToken 내부 뮤텍스와 별개)

// DB tokens.updatedAt 기준 마지막 갱신 경과(ms). 모르면 Infinity(=무조건 갱신).
async function tokenAgeMs() {
  try {
    const doc = await getDB().collection(TOKEN_COLL).findOne({}, { projection: { updatedAt: 1 } });
    if (doc && doc.updatedAt) return Date.now() - new Date(doc.updatedAt).getTime();
  } catch (_) { /* DB 미연결 등 → 갱신 진행 */ }
  return Infinity;
}

// force=true 면 신선도 무시하고 무조건 갱신.
async function refreshNow(reason, { force = false } = {}) {
  if (running) { console.log(`[token-keepalive] 이미 갱신 진행 중 → ${reason} 스킵`); return; }
  running = true;
  try {
    if (!force) {
      const age = await tokenAgeMs();
      if (age < FRESH_MS) {
        console.log(`[token-keepalive] 최근 ${Math.round(age / 60000)}분 전 갱신됨 → ${reason} 스킵(아직 신선)`);
        return;
      }
    }
    await cafe24.refreshAccessToken(`선제 갱신 · ${reason}`);
    console.log(`[token-keepalive] ✅ 토큰 선제 갱신 완료 (${reason})`);
  } catch (e) {
    console.error(`[token-keepalive] ❌ 토큰 선제 갱신 실패 (${reason}): ${e.message} — 2분 후 1회 재시도`);
    setTimeout(() => { refreshNow(`재시도 · ${reason}`, { force: true }).catch(() => {}); }, 120000);
  } finally {
    running = false;
  }
}

function start() {
  if (process.env.ENABLE_TOKEN_KEEPALIVE === '0') {
    console.log('[token-keepalive] ENABLE_TOKEN_KEEPALIVE=0 → 선제 토큰 갱신 비활성');
    return;
  }
  // pm2 cluster 다중 인스턴스면 0번에서만 예약(여러 프로세스가 동시에 회전 → invalid_grant 방지).
  if (process.env.NODE_APP_INSTANCE && process.env.NODE_APP_INSTANCE !== '0') {
    console.log(`[token-keepalive] NODE_APP_INSTANCE=${process.env.NODE_APP_INSTANCE} → 비(非)주 인스턴스, 예약 건너뜀`);
    return;
  }
  if (!cron) { console.error('[token-keepalive] node-cron 미설치 → 예약 불가'); return; }

  const expr = process.env.TOKEN_KEEPALIVE_CRON || '0 * * * *'; // 매시 정각
  cron.schedule(expr, () => refreshNow(`cron ${expr}`), { timezone: 'Asia/Seoul' });
  console.log(`[token-keepalive] ✅ Cafe24 토큰 선제 갱신 예약됨 (${expr}, KST) — 만료 전 회전으로 401 예방`);

  if (process.env.TOKEN_KEEPALIVE_ON_BOOT !== '0') {
    setTimeout(() => refreshNow('boot 직후'), 20000); // DB 연결 안정화 후 1회
  }
}

start();

module.exports = { start, refreshNow };
