'use strict';

/**
 * 자동 동기화 루틴 — 항상 켜져있는 호스트(ychat 등)에서 실행.
 *
 *  runDaily(): 매일 00시 기준 최근 1주일 Cafe24+SmartStore 주문 적재 → 공통 구간 캐시 워밍(쿠폰 funnel 포함).
 *  runToday(): 사용자가 낮에 누르는 "오늘 재취합" — 오늘 주문만 적재 + 오늘 포함 구간 빠르게 갱신(funnel 은 캐시 유지).
 *
 *  배포(Vercel/READ_ONLY)에서는 호출 금지 — 무거운 라이브 적재/스캔이므로 항상 켜진 서버에서만.
 */

const ingest = require('./ingest');
const smartstoreIngest = require('./smartstoreIngest');
const report = require('./report');
const promoPeriods = require('./promoPeriods');

function pad(n) { return String(n).padStart(2, '0'); }
function fmt(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function today() { return fmt(new Date()); }
function minusDays(n) { const d = new Date(); d.setDate(d.getDate() - n); return fmt(d); }

// 대시보드 칩과 "정확히 동일한" 구간(rangeFor)을 워밍해야 캐시가 적중한다.
//  대시보드 칩 종료일 = 어제(yesterday). 오늘은 미완료라 집계 칩은 어제까지만 본다.
function commonRanges() {
  const now = new Date();
  const y = minusDays(1); // 어제 — 칩 종료일
  const monthStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  const lastMonthStart = fmt(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const lastMonthEnd = fmt(new Date(now.getFullYear(), now.getMonth(), 0));
  return [
    { label: '이번 달', start: monthStart, end: y },          // rangeFor('month') = [월초, 어제]
    { label: '최근 30일', start: minusDays(30), end: y },     // [어제-29, 어제]
    { label: '최근 7일', start: minusDays(7), end: y },       // [어제-6, 어제]
    { label: '어제', start: y, end: y },
    { label: '지난 달', start: lastMonthStart, end: lastMonthEnd },
  ].filter((r) => r.start <= r.end); // 월초 등 역전 구간 제외
}

// 프로모션 기간 추가. recentDays 지정 시, 종료일이 최근 N일 이내인 "진행/최근" 프로모션만(과거 immutable 구간 매일 재스캔 방지).
async function withPromos(ranges, { recentDays = null } = {}) {
  try {
    const promos = await promoPeriods.listPromos();
    const cutoff = recentDays != null ? minusDays(recentDays) : null;
    for (const p of (promos || []).slice(0, 12)) {
      if (!p.start || !p.end) continue;
      if (cutoff && p.end < cutoff) continue; // 너무 과거(이미 고정된) 프로모션은 제외
      ranges.push({ label: `프로모션:${p.name || p.month}`, start: p.start, end: p.end });
    }
  } catch (_) {}
  return ranges;
}

// 구간 목록을 force 재집계해 report_cache + coupon_funnel_cache 채움. 성공/실패 카운트 반환(무성 실패 감지용).
async function warmRanges(ranges, { forceFunnel = true, log = console.log } = {}) {
  let ok = 0, failed = 0;
  for (const r of ranges) {
    const t = Date.now();
    try {
      const o = await report.getOverview(r.start, r.end, { force: true, forceFunnel });
      const f = (o.funnel && o.funnel.totals) || {};
      log(`  ✓ warm ${r.label} ${r.start}~${r.end} ${((Date.now() - t) / 1000).toFixed(1)}s · 주문 ${o.ordersCount} · 쿠폰 ${f.used || 0}/${f.issued || 0}`);
      ok++;
    } catch (e) { log(`  ✗ warm ${r.label} 실패: ${e.message}`); failed++; }
  }
  return { total: ranges.length, ok, failed };
}

// 매일 1주일 동기화: Cafe24 + SmartStore 적재 후 공통 구간 캐시 워밍(쿠폰 funnel 포함)
async function runDaily({ days = 7, warmPromos = true, log = console.log } = {}) {
  const start = minusDays(days), end = today();
  const out = { start, end, at: new Date().toISOString(), steps: {} };
  log(`[daily-sync] ${start}~${end} 시작`);
  try { out.steps.cafe24 = await ingest.syncRange(start, end); log(`  ✓ Cafe24 적재 ${out.steps.cafe24.upserts != null ? out.steps.cafe24.upserts + '건' : ''}`); }
  catch (e) { out.steps.cafe24 = { error: e.message }; log(`  ✗ Cafe24 적재 실패: ${e.message}`); }
  try { out.steps.smartstore = await smartstoreIngest.syncRange(start, end); log('  ✓ SmartStore 적재'); }
  catch (e) { out.steps.smartstore = { error: e.message }; log(`  ✗ SmartStore 적재 실패: ${e.message}`); }
  let ranges = commonRanges();
  if (warmPromos) ranges = await withPromos(ranges, { recentDays: 40 }); // 최근 40일 내 종료 프로모션만 매일 재워밍
  const warm = await warmRanges(ranges, { forceFunnel: true, log });
  out.warm = warm;

  // 무성 실패 방지: 적재/워밍 결과를 명시적으로 판정해 "전부 실패"면 예외를 던져 cron 에 비정상 종료(code≠0)를 알린다.
  const cafeFailed = !!(out.steps.cafe24 && out.steps.cafe24.error);
  const ssFailed = !!(out.steps.smartstore && out.steps.smartstore.error);
  if (cafeFailed) log(`  ⚠ Cafe24 적재 실패: ${out.steps.cafe24.error}`);
  if (ssFailed) log(`  ⚠ SmartStore 적재 실패/스킵: ${out.steps.smartstore.error}`);
  if (warm.total > 0 && warm.ok === 0) {
    throw new Error(`동기화 실패 — 워밍 전 구간 실패(0/${warm.total}), Cafe24 적재 ${cafeFailed ? '실패' : 'OK'}. Mongo/Cafe24 상태 확인 필요`);
  }
  log(`[daily-sync] 완료 — 워밍 ${warm.ok}/${warm.total} 성공${warm.failed ? ` (실패 ${warm.failed})` : ''}, Cafe24 적재 ${cafeFailed ? '실패' : 'OK'}, SmartStore ${ssFailed ? '실패/스킵' : 'OK'}`);
  return out;
}

// 오늘만 재취합: 오늘 주문 적재 + 오늘 포함 구간 빠른 갱신(funnel 은 캐시 유지 → 즉시)
async function runToday({ log = console.log } = {}) {
  const d = today();
  const out = { day: d, at: new Date().toISOString(), steps: {} };
  log(`[sync-today] ${d} 시작`);
  try { out.steps.cafe24 = await ingest.syncRange(d, d); log('  ✓ Cafe24 오늘 적재'); }
  catch (e) { out.steps.cafe24 = { error: e.message }; log(`  ✗ Cafe24: ${e.message}`); }
  try { out.steps.smartstore = await smartstoreIngest.syncRange(d, d); log('  ✓ SmartStore 오늘 적재'); }
  catch (e) { out.steps.smartstore = { error: e.message }; log(`  ✗ SmartStore: ${e.message}`); }
  // '오늘' 칩 구간([오늘,오늘])만 빠르게 갱신 — funnel 은 강제하지 않음(캐시 유지 → 92초 스캔 회피)
  await warmRanges([{ label: '오늘', start: d, end: d }], { forceFunnel: false, log });
  log('[sync-today] 완료');
  return out;
}

module.exports = { runDaily, runToday, commonRanges, warmRanges, withPromos };
