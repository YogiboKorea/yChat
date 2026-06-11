'use strict';

/**
 * 유입수 분석 — Cafe24 Analytics API (ca-api.cafe24data.com) 기준.
 * 프로빙으로 검증된 엔드포인트만 사용:
 *   /visitors/view     date, visit_count, first_visit_count, re_visit_count   (device_type: total|pc|mobile)
 *   /pages/view        url, count, visit_count, first_visit_count
 *   /visitpaths/keywords  keyword, visit_count
 *   /visitpaths/domains   domain, visit_count
 *   /visitpaths/adsales   ad, order_count, order_amount, join_count
 */

const c = require('./cafe24');
const store = require('./store');

const N = (v) => (Number.isFinite(+v) ? +v : 0);
const pad2 = (n) => String(n).padStart(2, '0');
function enumDays(start, end) { const out = []; let d = new Date(start + 'T00:00:00'); const last = new Date(end + 'T00:00:00'); while (d <= last) { out.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`); d = new Date(d.getTime() + 86400000); } return out; }
function enumMonths(start, end) { const out = []; let y = +start.slice(0, 4), m = +start.slice(5, 7); const ey = +end.slice(0, 4), em = +end.slice(5, 7); while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${pad2(m)}`); m++; if (m > 12) { m = 1; y++; } } return out; }
function lastDay(ym) { const y = +ym.slice(0, 4), m = +ym.slice(5, 7); return `${ym}-${pad2(new Date(y, m, 0).getDate())}`; }

async function dailyVisitors(start, end, device) {
  const rows = await c.caPaginate('/visitors/view',
    { start_date: start, end_date: end, device_type: device }, 'view');
  return rows.map((r) => ({
    date: String(r.date).slice(0, 10), // 'YYYY-MM-DD' (시각 제거)
    visits: N(r.visit_count),
    newVisits: N(r.first_visit_count),
    reVisits: N(r.re_visit_count),
  }));
}

// 유입 종합 리포트 — 전체 방문수만(신규/재방문·PC/모바일·일별). 도메인/검색어/광고/페이지 breakdown 제외.
async function inflowReport(start, end) {
  const s = c.ymd(start), e = c.ymd(end);

  const [total, pc, mobile] = await Promise.all([
    dailyVisitors(s, e, 'total'),
    dailyVisitors(s, e, 'pc').catch(() => []),
    dailyVisitors(s, e, 'mobile').catch(() => []),
  ]);

  // 일별 시계열 (pc/mobile 병합)
  const pcByDate = Object.fromEntries(pc.map((r) => [r.date, r.visits]));
  const moByDate = Object.fromEntries(mobile.map((r) => [r.date, r.visits]));
  const daily = total.map((r) => ({
    date: r.date,
    visits: r.visits,
    newVisits: r.newVisits,
    reVisits: r.reVisits,
    pc: pcByDate[r.date] || 0,
    mobile: moByDate[r.date] || 0,
  }));

  const sum = (arr, k) => arr.reduce((a, r) => a + (r[k] || 0), 0);
  const totals = {
    visits: sum(daily, 'visits'),
    newVisits: sum(daily, 'newVisits'),
    reVisits: sum(daily, 'reVisits'),
    pcVisits: pc.reduce((a, r) => a + r.visits, 0),
    mobileVisits: mobile.reduce((a, r) => a + r.visits, 0),
    days: daily.length,
  };
  totals.avgDaily = totals.days ? Math.round(totals.visits / totals.days) : 0;
  totals.newRatio = totals.visits ? totals.newVisits / totals.visits : 0;
  totals.reRatio = totals.visits ? totals.reVisits / totals.visits : 0;

  return { start: s, end: e, totals, daily };
}

// ── 트래픽 전환 풀세트 (방문/PV/구매/가입) ──

// 기간 합계 PV (/pages/view url별 count 합산)
async function periodPV(start, end) {
  const rows = await c.caPaginate('/pages/view', { start_date: start, end_date: end }, 'view').catch(() => []);
  return rows.reduce((a, r) => a + N(r.count), 0);
}

// 일별 PV — 과거일은 pv_daily 캐시 우선, 오늘은 항상 라이브
async function dailyPV(start, end) {
  const days = enumDays(start, end);
  const todayStr = c.ymd(new Date());
  let coll = null; try { coll = await store.collection('pv_daily'); } catch (_) {}
  let cached = {};
  if (coll) { const docs = await coll.find({ date: { $gte: start, $lte: end } }).toArray(); cached = Object.fromEntries(docs.map((d) => [d.date, d.pv])); }
  const out = {}; const ops = [];
  for (const day of days) {
    if (cached[day] != null && day < todayStr) { out[day] = cached[day]; continue; }
    out[day] = await periodPV(day, day);
    if (coll && day < todayStr) ops.push({ updateOne: { filter: { date: day }, update: { $set: { date: day, pv: out[day], _at: new Date().toISOString() } }, upsert: true } });
  }
  if (coll && ops.length) { try { await coll.bulkWrite(ops, { ordered: false }); } catch (_) {} }
  return out;
}

// 단일 구간 가입수 (/customersprivacy created_date) — offset 페이지네이션 미지원이라 limit 1000 단건.
//  반환 1000건이면 캡 가능성 → 호출측에서 더 잘게 쪼갬.
async function rangeSignupRows(start, end) {
  const j = await c.adminGet('/customersprivacy', { shop_no: 1, search_type: 'created_date', created_start_date: start, created_end_date: end, limit: 1000 }).catch(() => ({}));
  return (j && j.customersprivacy) || [];
}

// 일별 가입수 → {date: count}. created_end_date가 무시되므로(그 날짜 이후 ascending 반환) 해당 일자만 필터.
async function dailySignups(start, end) {
  const days = enumDays(start, end);
  const todayStr = c.ymd(new Date());
  let coll = null; try { coll = await store.collection('signups_daily'); } catch (_) {}
  let cached = {};
  if (coll) { const docs = await coll.find({ date: { $gte: start, $lte: end } }).toArray(); cached = Object.fromEntries(docs.map((d) => [d.date, d.count])); }
  const out = {}; const ops = [];
  for (const day of days) {
    if (cached[day] != null && day < todayStr) { out[day] = cached[day]; continue; }
    const rows = await rangeSignupRows(day, day); // day 이후 ascending(최대 1000) → day 것만 카운트
    out[day] = rows.filter((r) => String(r.created_date || '').slice(0, 10) === day).length;
    if (coll && day < todayStr) ops.push({ updateOne: { filter: { date: day }, update: { $set: { date: day, count: out[day], _at: new Date().toISOString() } }, upsert: true } });
  }
  if (coll && ops.length) { try { await coll.bulkWrite(ops, { ordered: false }); } catch (_) {} }
  return out;
}

// 한 달 가입수 — 월초부터 ascending 1000건 받아 월 범위만 필터. 캡(1000)이면 일자별 합산으로 정확화.
async function monthSignups(ym, realEnd) {
  const lo = ym + '-01';
  const rows = await rangeSignupRows(lo, realEnd);
  const inRange = rows.filter((r) => { const d = String(r.created_date || '').slice(0, 10); return d >= lo && d <= realEnd; }).length;
  if (rows.length < 1000) return inRange; // 월초 이후 전부(미래 포함) <1000 → 월 집계 완전
  return Object.values(await dailySignups(lo, realEnd)).reduce((a, x) => a + x, 0);
}

// 일별 구매건수·매출 (orders_raw)
async function ordersByDate(start, end) {
  const coll = await store.collection('orders_raw');
  const r = await coll.aggregate([
    { $match: { order_date: { $gte: start, $lte: end }, paid: true, canceled: false } },
    { $group: { _id: '$order_date', orders: { $sum: 1 }, revenue: { $sum: '$payment_amount' } } },
  ]).toArray();
  const out = {}; for (const x of r) out[x._id] = { orders: x.orders, revenue: Math.round(x.revenue) }; return out;
}

const WD = ['일', '월', '화', '수', '목', '금', '토'];

// 선택 기간 일별 트래픽 전환 + 요일평균 + Top10
async function trafficDaily(start, end) {
  const s = c.ymd(start), e = c.ymd(end);
  const [visitsArr, pvMap, signupMap, ordMap] = await Promise.all([
    dailyVisitors(s, e, 'total').catch(() => []), dailyPV(s, e), dailySignups(s, e), ordersByDate(s, e),
  ]);
  const vBy = Object.fromEntries(visitsArr.map((r) => [r.date, r.visits]));
  const daily = enumDays(s, e).map((d) => {
    const v = vBy[d] || 0, pv = pvMap[d] || 0, o = ordMap[d] || {}, su = signupMap[d] || 0;
    return { date: d, dow: new Date(d + 'T00:00:00').getDay(), visits: v, pv, pvPerVisit: v ? pv / v : 0, orders: o.orders || 0, revenue: o.revenue || 0, cvr: v ? (o.orders || 0) / v : 0, signups: su, signupRate: v ? su / v : 0 };
  });
  const wd = {}; daily.forEach((r) => { const w = (wd[r.dow] = wd[r.dow] || { days: 0, visits: 0, signups: 0 }); w.days++; w.visits += r.visits; w.signups += r.signups; });
  const weekday = Array.from({ length: 7 }, (_, i) => { const w = wd[i] || { days: 0, visits: 0, signups: 0 }; return { dow: i, label: WD[i], avgVisits: w.days ? Math.round(w.visits / w.days) : 0, avgSignups: w.days ? Math.round(w.signups / w.days * 10) / 10 : 0 }; });
  const sum = (k) => daily.reduce((a, r) => a + r[k], 0);
  const tv = sum('visits'), tpv = sum('pv'), to = sum('orders'), tr = sum('revenue'), ts = sum('signups');
  const totals = { visits: tv, pv: tpv, orders: to, revenue: tr, signups: ts, cvr: tv ? to / tv : 0, signupRate: tv ? ts / tv : 0, pvPerVisit: tv ? tpv / tv : 0, days: daily.length };
  const top = [...daily].sort((a, b) => b.visits - a.visits).slice(0, 10);
  return { start: s, end: e, totals, daily, weekday, top };
}

// /visitors/view 는 1년 초과 범위에서 400 → ≤365일 윈도우로 분할 조회
async function dailyVisitorsChunked(start, end, device) {
  const out = []; let s = new Date(start + 'T00:00:00'); const last = new Date(end + 'T00:00:00');
  while (s <= last) {
    const e = new Date(Math.min(last.getTime(), s.getTime() + 364 * 86400000));
    const ws = `${s.getFullYear()}-${pad2(s.getMonth() + 1)}-${pad2(s.getDate())}`;
    const we = `${e.getFullYear()}-${pad2(e.getMonth() + 1)}-${pad2(e.getDate())}`;
    out.push(...(await dailyVisitors(ws, we, device).catch(() => [])));
    s = new Date(e.getTime() + 86400000);
  }
  return out;
}

// 월별 방문/가입/PV (2025-01~현재) — 전년 동월 비교. pv/signups는 traffic_monthly 캐시
async function trafficMonthly(start, end) {
  const s = c.ymd(start || '2025-01-01'), e = c.ymd(end || new Date());
  const visitsArr = await dailyVisitorsChunked(s, e, 'total');
  const vMonth = {}; visitsArr.forEach((r) => { const m = r.date.slice(0, 7); vMonth[m] = (vMonth[m] || 0) + r.visits; });
  const months = enumMonths(s, e);
  const curMonth = e.slice(0, 7);
  let coll = null; try { coll = await store.collection('traffic_monthly'); } catch (_) {}
  let cached = {};
  if (coll) { const docs = await coll.find({ ym: { $in: months } }).toArray(); cached = Object.fromEntries(docs.map((d) => [d.ym, d])); }
  const ops = []; const rows = [];
  for (const m of months) {
    const mEnd = lastDay(m); const realEnd = mEnd > e ? e : mEnd;
    let pv, su; const cu = cached[m];
    if (cu && m < curMonth) { pv = cu.pv; su = cu.signups; }
    else {
      pv = await periodPV(m + '-01', realEnd);
      su = await monthSignups(m, realEnd);
      if (coll && m < curMonth) ops.push({ updateOne: { filter: { ym: m }, update: { $set: { ym: m, pv, signups: su, _at: new Date().toISOString() } }, upsert: true } });
    }
    rows.push({ ym: m, visits: vMonth[m] || 0, pv, signups: su });
  }
  if (coll && ops.length) { try { await coll.bulkWrite(ops, { ordered: false }); } catch (_) {} }
  return { start: s, end: e, rows };
}

module.exports = { inflowReport, dailyVisitors, trafficDaily, trafficMonthly, dailyPV, dailySignups };
