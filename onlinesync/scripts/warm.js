'use strict';

/**
 * 캐시 워밍(적재 없음) — 자주 여는 구간의 overview + 쿠폰 funnel 을 미리 계산해 DB에 적재.
 *   배포(Vercel)는 무거운 라이브 스캔을 못 돌리므로, 로컬에서 이 스크립트로 캐시를 채워두면
 *   서버는 report_cache / coupon_funnel_cache 를 즉시 읽어 빠르게 응답한다.
 *   ※ 새 주문까지 가져오려면 적재가 포함된 `node scripts/daily-sync.js` 를 사용.
 *
 *   사용: node scripts/warm.js            (공통 구간 + 등록된 프로모션 기간)
 *         node scripts/warm.js 2026-05-01 2026-05-31   (특정 구간만)
 */

const dailySync = require('../lib/dailySync');

(async () => {
  const [argStart, argEnd] = process.argv.slice(2);
  let ranges;
  if (argStart && argEnd) {
    ranges = [{ label: '지정 구간', start: argStart, end: argEnd }];
  } else {
    ranges = await dailySync.withPromos(dailySync.commonRanges());
  }
  console.log(`[warm] ${ranges.length}개 구간 캐시 워밍 시작…`);
  const t0 = Date.now();
  await dailySync.warmRanges(ranges, { forceFunnel: true });
  console.log(`[warm] 완료 — 총 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
})();
