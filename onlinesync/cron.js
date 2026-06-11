'use strict';

/**
 * onlineData 일일 동기화 크론 (ychat 안에서 호스팅) — 운영 챗 서버에 최소 침습으로 얹는다.
 *
 *   매일 00:05(KST) 에 별도 "자식 프로세스"로 `scripts/daily-sync.js` 를 실행한다.
 *     · 자식 프로세스라 ychat 본체의 메모리/이벤트루프/타임존을 전혀 건드리지 않음.
 *     · 자식에는 TZ=Asia/Seoul 을 주입해 onlineData 날짜 로직이 KST 로 정확히 동작.
 *
 *   동작 조건: 환경변수 ENABLE_ONLINE_SYNC=1 일 때만 예약(없으면 완전 비활성 → 안전).
 *   필요한 env (Cloudtype, ychat 변수와 충돌 없는 고유명):
 *     ONLINEDATA_URI            분석 데이터 클러스터(주문/캐시) — ychat의 MONGODB_URI 와 다른 클러스터
 *     ONLINEDATA_DB=onlinedata  (기본값)
 *     CAFE24_TOKEN_URI          Cafe24 토큰이 든 클러스터
 *     CAFE24_TOKEN_DB=yogibo    CAFE24_TOKEN_COLLECTION=tokens
 *     CAFE24_MALL_ID=yogibo     CAFE24_API_VERSION=2025-03-01
 *     NAVER_COMMERCE_CLIENT_ID / NAVER_COMMERCE_CLIENT_SECRET  (스마트스토어용; 없으면 SS만 건너뜀)
 *   옵션: ONLINE_SYNC_ON_BOOT=1 → 서버 기동 10초 뒤 1회 즉시 실행(최초 검증용), ONLINE_SYNC_DAYS(기본 7)
 */

const path = require('path');
const { spawn } = require('child_process');

let cron = null;
try { cron = require('node-cron'); } catch (_) { cron = null; }

let running = false; // 중복 실행 방지(이전 동기화가 안 끝났으면 스킵)

// ychat 기존 환경변수 → onlineData 가 기대하는 이름으로 자동 매핑.
//  (검증) ychat MONGODB_URI=onlineData 데이터 클러스터, DB_NAME=토큰 DB(yogibo) 와 동일하므로 그대로 파생.
//  명시 변수(ONLINEDATA_URI 등)를 설정하면 그쪽을 우선한다.
function childEnv() {
  return {
    ...process.env,
    TZ: 'Asia/Seoul', // KST 보정(컨테이너 TZ 무관)
    ONLINEDATA_URI: process.env.ONLINEDATA_URI || process.env.MONGODB_URI,
    ONLINEDATA_DB: process.env.ONLINEDATA_DB || 'onlinedata',
    CAFE24_TOKEN_URI: process.env.CAFE24_TOKEN_URI || process.env.MONGODB_URI,
    CAFE24_TOKEN_DB: process.env.CAFE24_TOKEN_DB || process.env.DB_NAME || 'yogibo',
    CAFE24_TOKEN_COLLECTION: process.env.CAFE24_TOKEN_COLLECTION || 'tokens',
    CAFE24_MALL_ID: process.env.CAFE24_MALL_ID || process.env.CAFE24_MALLID || 'yogibo',
    CAFE24_API_VERSION: process.env.CAFE24_API_VERSION || '2025-03-01',
  };
}

function runDailySync(reason) {
  if (running) { console.log(`[onlinesync] 이미 동기화 진행 중 → ${reason} 스킵`); return; }
  running = true;
  const script = path.join(__dirname, 'scripts', 'daily-sync.js');
  const days = process.env.ONLINE_SYNC_DAYS || '7';
  console.log(`[onlinesync] 일일 동기화 시작 (${reason}) — 최근 ${days}일`);
  const child = spawn(process.execPath, [script, days], {
    cwd: __dirname,
    env: childEnv(),
    stdio: 'inherit',                           // 자식 로그를 ychat 콘솔로
  });
  // 워치독: 자식이 행(hang)나서 running 이 영구 고정되지 않게 일정 시간 초과 시 강제 종료.
  const MAX_MS = Number(process.env.ONLINE_SYNC_TIMEOUT_MS || 1800000); // 기본 30분
  const watchdog = setTimeout(() => {
    console.error(`[onlinesync] ⏱ 동기화 ${Math.round(MAX_MS / 60000)}분 초과 → 강제 종료(kill)`);
    try { child.kill('SIGKILL'); } catch (_) {}
  }, MAX_MS);
  child.on('exit', (code) => {
    clearTimeout(watchdog); running = false;
    if (code === 0) console.log(`[onlinesync] ✅ 동기화 정상 종료 (${reason})`);
    else console.error(`[onlinesync] ❌ 동기화 실패 종료 code=${code} (${reason}) — 캐시가 갱신되지 않았을 수 있음, 로그 확인`);
  });
  child.on('error', (e) => { clearTimeout(watchdog); running = false; console.error('[onlinesync] 자식 프로세스 spawn 오류:', e.message); });
}

function start() {
  if (process.env.ENABLE_ONLINE_SYNC !== '1') {
    console.log('[onlinesync] ENABLE_ONLINE_SYNC!=1 → 자동 동기화 비활성(설정 시 매일 00:05 KST 실행)');
    return;
  }
  if (!cron) { console.error('[onlinesync] node-cron 미설치 → 크론 예약 불가'); return; }
  // 매일 00:05 KST (자정 직후, 트래픽 적은 시간) — node-cron timezone 옵션으로 KST 트리거
  cron.schedule('5 0 * * *', () => runDailySync('cron 00:05 KST'), { timezone: 'Asia/Seoul' });
  console.log('[onlinesync] ✅ 매일 00:05(KST) onlineData 자동 동기화 예약됨');
  if (process.env.ONLINE_SYNC_ON_BOOT === '1') {
    setTimeout(() => runDailySync('boot(최초 검증)'), 10000);
  }
}

start();

module.exports = { runDailySync };
