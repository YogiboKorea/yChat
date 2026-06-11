'use strict';

/**
 * 매일 자동 동기화 (최근 1주일 Cafe24 + SmartStore 적재 → 캐시 워밍).
 *   항상 켜진 호스트(ychat 등)에서 매일 00시에 실행.
 *
 *   사용:
 *     node scripts/daily-sync.js          (최근 7일)
 *     node scripts/daily-sync.js 14       (최근 14일)
 *
 *   Windows 작업 스케줄러 / cron 에 등록하거나, server.js 의 ENABLE_DAILY_SYNC=1 자동 스케줄러를 쓰면 됨.
 */

const dailySync = require('../lib/dailySync');

(async () => {
  const days = Number(process.argv[2]) || 7;
  try {
    await dailySync.runDaily({ days });
    process.exit(0);
  } catch (e) {
    console.error('[daily-sync] 실패:', e);
    process.exit(1);
  }
})();
