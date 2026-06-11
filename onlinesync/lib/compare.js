'use strict';

/**
 * 통합 비교 분석 — 자사몰(orders_raw) + 스마트스토어(smartstore_orders).
 *   periodCompare : 전년/전월/전주 동기간 비교 (채널별 매출·주문·객단가)
 *   bestProducts  : 채널별 베스트 상품 Top10
 *   promoCompare  : 저장된 전사 프로모션 기간별 매출 비교 + 전/중/후 7일
 *   categoryPromo : 프로모션 기간 카테고리별 성과 (+ 전월 동기간 대비)
 */

const store = require('./store');
const promoPeriods = require('./promoPeriods');
const analytics = require('./analytics');
const { categoryOf, detectTier, TIERS } = require('./salesBreakdown');

const PAID_SS = ['PAYED', 'DELIVERING', 'DELIVERED', 'PURCHASE_DECIDED', 'EXCHANGED'];
const N = (v) => (Number.isFinite(+v) ? +v : 0);
function pad(n) { return String(n).padStart(2, '0'); }
function fmt(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function shift(dateStr, { days = 0, months = 0, years = 0 }) {
  const d = new Date(dateStr + 'T00:00:00');
  if (years) d.setFullYear(d.getFullYear() + years);
  if (months) d.setMonth(d.getMonth() + months);
  if (days) d.setDate(d.getDate() + days);
  return fmt(d);
}

async function caSum(s, e) {
  const c = await store.collection('orders_raw');
  const r = await c.aggregate([
    { $match: { order_date: { $gte: s, $lte: e }, paid: true, canceled: false } },
    { $group: { _id: null, revenue: { $sum: '$payment_amount' }, orders: { $sum: 1 } } },
  ]).toArray();
  return r[0] ? { revenue: Math.round(r[0].revenue), orders: r[0].orders } : { revenue: 0, orders: 0 };
}
async function ssSum(s, e) {
  const c = await store.collection('smartstore_orders');
  const r = await c.aggregate([
    { $match: { order_date: { $gte: s, $lte: e }, canceled: { $ne: true }, status: { $in: PAID_SS } } },
    { $group: { _id: null, revenue: { $sum: '$payment_amount' }, ordSet: { $addToSet: '$order_id' } } },
    { $project: { revenue: 1, orders: { $size: '$ordSet' } } },
  ]).toArray();
  return r[0] ? { revenue: Math.round(r[0].revenue), orders: r[0].orders } : { revenue: 0, orders: 0 };
}
async function bothSum(s, e) {
  const [ca, ss] = await Promise.all([caSum(s, e), ssSum(s, e)]);
  const total = { revenue: ca.revenue + ss.revenue, orders: ca.orders + ss.orders };
  return { cafe24: ca, smartstore: ss, total };
}
const aov = (g) => (g.orders ? Math.round(g.revenue / g.orders) : 0);
const rate = (cur, base) => (base ? (cur - base) / base : null);

// 전년/전월/전주 동기간 비교
async function periodCompare(start, end) {
  const periods = {
    cur: [start, end],
    wow: [shift(start, { days: -7 }), shift(end, { days: -7 })],
    mom: [shift(start, { months: -1 }), shift(end, { months: -1 })],
    yoy: [shift(start, { years: -1 }), shift(end, { years: -1 })],
  };
  const data = {};
  for (const [k, [s, e]] of Object.entries(periods)) data[k] = { range: [s, e], ...(await bothSum(s, e)) };

  const channelRow = (ch) => {
    const cur = data.cur[ch];
    return {
      channel: ch,
      cur: { revenue: cur.revenue, orders: cur.orders, aov: aov(cur) },
      wow: { revenue: data.wow[ch].revenue, rate: rate(cur.revenue, data.wow[ch].revenue) },
      mom: { revenue: data.mom[ch].revenue, rate: rate(cur.revenue, data.mom[ch].revenue) },
      yoy: { revenue: data.yoy[ch].revenue, rate: rate(cur.revenue, data.yoy[ch].revenue) },
      aovCur: aov(cur),
      aovWow: aov(data.wow[ch]), aovMom: aov(data.mom[ch]), aovYoy: aov(data.yoy[ch]),
    };
  };
  return {
    start, end,
    periods: Object.fromEntries(Object.entries(periods).map(([k, v]) => [k, v])),
    rows: ['total', 'cafe24', 'smartstore'].map(channelRow),
  };
}

// 채널별 베스트 상품 Top10
async function bestProducts(start, end, limit = 10) {
  const caColl = await store.collection('orders_raw');
  const ca = await caColl.aggregate([
    { $match: { order_date: { $gte: start, $lte: end }, paid: true, canceled: false } },
    { $unwind: '$items' },
    { $group: { _id: '$items.product_name', qty: { $sum: '$items.quantity' }, sales: { $sum: '$items.payment_amount' } } },
    { $sort: { sales: -1 } }, { $limit: limit },
  ]).toArray();
  const ssColl = await store.collection('smartstore_orders');
  const ss = await ssColl.aggregate([
    { $match: { order_date: { $gte: start, $lte: end }, canceled: { $ne: true }, status: { $in: PAID_SS } } },
    { $group: { _id: '$product_name', qty: { $sum: '$quantity' }, sales: { $sum: '$payment_amount' } } },
    { $sort: { sales: -1 } }, { $limit: limit },
  ]).toArray();
  const map = (r) => ({ name: String(r._id || '').replace(/^(\s*\[[^\]]+\]\s*)+/, '').replace(/^요기보\s*/, '') || r._id, qty: r.qty, sales: Math.round(r.sales) });
  return { start, end, cafe24: ca.map(map), smartstore: ss.map(map) };
}

// 카테고리별 성과 (기간) — orders_raw 아이템을 categoryOf로 분류
async function categorySales(start, end) {
  const coll = await store.collection('orders_raw');
  const cur = coll.find({ order_date: { $gte: start, $lte: end }, paid: true, canceled: false }, { projection: { items: 1 } });
  const cat = {};
  for await (const o of cur) for (const it of (o.items || [])) {
    const c = categoryOf({}, it.product_no, it.product_name);
    (cat[c] = cat[c] || { cat: c, qty: 0, sales: 0 }); cat[c].qty += N(it.quantity); cat[c].sales += N(it.payment_amount);
  }
  return cat;
}
// 카테고리별 프로모션 성과 + 전월 동기간 대비
async function categoryPromo(start, end) {
  const [cur, prev] = await Promise.all([
    categorySales(start, end),
    categorySales(shift(start, { months: -1 }), shift(end, { months: -1 })),
  ]);
  const order = ['공동구매', '소파', '바디필로우', '메이트', '서포트/롤', '커버', '리필/비즈', '기타'];
  const total = Object.values(cur).reduce((a, c) => a + c.sales, 0) || 1;
  const rows = Object.values(cur).map((c) => ({
    cat: c.cat, sales: Math.round(c.sales), qty: c.qty, share: c.sales / total,
    momRate: rate(c.sales, prev[c.cat] ? prev[c.cat].sales : 0),
  })).sort((a, b) => order.indexOf(a.cat) - order.indexOf(b.cat));
  return { start, end, total: Math.round(total), rows };
}

// 저장된 전사 프로모션 기간별 비교 + 전/중/후 7일
async function promoCompare() {
  const promos = await promoPeriods.listPromos();
  const out = [];
  for (const p of promos) {
    const during = await bothSum(p.start, p.end);
    const before = await bothSum(shift(p.start, { days: -7 }), shift(p.start, { days: -1 }));
    const after = await bothSum(shift(p.end, { days: 1 }), shift(p.end, { days: 7 }));
    const days = Math.round((new Date(p.end) - new Date(p.start)) / 86400000) + 1;
    out.push({
      month: p.month, name: p.name, start: p.start, end: p.end, days,
      cafe24: during.cafe24, smartstore: during.smartstore, total: during.total,
      dailyAvg: days ? Math.round(during.total.revenue / days) : 0,
      aov: aov(during.total),
      before7: before.total, after7: after.total,
    });
  }
  return { promos: out };
}

// 월별 매출/주문 시계열 — 몰별 (2025-01 ~ 현재). 전년 동월 비교(YoY)용. DB만 사용.
async function monthlySeries(start = '2025-01-01', end = null) {
  end = end || fmt(new Date());
  const ym = { $substrBytes: ['$order_date', 0, 7] };
  const caColl = await store.collection('orders_raw');
  const ssColl = await store.collection('smartstore_orders');
  const [ca, ss] = await Promise.all([
    caColl.aggregate([
      { $match: { order_date: { $gte: start, $lte: end }, paid: true, canceled: false } },
      { $group: { _id: ym, sales: { $sum: '$payment_amount' }, orders: { $sum: 1 } } },
    ]).toArray(),
    ssColl.aggregate([
      { $match: { order_date: { $gte: start, $lte: end }, canceled: { $ne: true }, status: { $in: PAID_SS } } },
      { $group: { _id: ym, sales: { $sum: '$payment_amount' }, ordSet: { $addToSet: '$order_id' } } },
      { $project: { sales: 1, orders: { $size: '$ordSet' } } },
    ]).toArray(),
  ]);
  const map = {};
  const put = (arr, ch) => { for (const r of arr) { (map[r._id] = map[r._id] || { ym: r._id, cafe24: { sales: 0, orders: 0 }, smartstore: { sales: 0, orders: 0 } }); map[r._id][ch] = { sales: Math.round(r.sales), orders: r.orders }; } };
  put(ca, 'cafe24'); put(ss, 'smartstore');
  const rows = Object.values(map).sort((a, b) => (a.ym < b.ym ? -1 : 1)).map((m) => ({
    ym: m.ym, cafe24: m.cafe24, smartstore: m.smartstore,
    total: { sales: m.cafe24.sales + m.smartstore.sales, orders: m.cafe24.orders + m.smartstore.orders },
  }));
  return { start, end, rows };
}

// 월별 충전재(등급)별 매출 시계열 — 채널별(cafe24/smartstore/total) (detectTier는 JS 로직이라 순회 집계)
async function monthlyTierSeries(start = '2025-01-01', end = null) {
  end = end || fmt(new Date());
  const months = {}; // mo -> { cafe24:{tier:{sales,qty}}, smartstore:{...} }
  const add = (mo, ch, tier, sales, qty) => { const m = (months[mo] = months[mo] || { cafe24: {}, smartstore: {} }); const t = (m[ch][tier] = m[ch][tier] || { sales: 0, qty: 0 }); t.sales += sales; t.qty += qty; };
  const ca = await store.collection('orders_raw');
  for await (const o of ca.find({ order_date: { $gte: start, $lte: end }, paid: true, canceled: false }, { projection: { order_date: 1, items: 1 } })) {
    const mo = String(o.order_date).slice(0, 7);
    for (const it of (o.items || [])) { const cat = categoryOf({}, it.product_no, it.product_name); add(mo, 'cafe24', detectTier(it.product_name, cat), N(it.payment_amount), N(it.quantity)); }
  }
  const ss = await store.collection('smartstore_orders');
  for await (const o of ss.find({ order_date: { $gte: start, $lte: end }, canceled: { $ne: true }, status: { $in: PAID_SS } }, { projection: { order_date: 1, product_name: 1, product_id: 1, quantity: 1, payment_amount: 1 } })) {
    const mo = String(o.order_date).slice(0, 7); const cat = categoryOf({}, o.product_id, o.product_name);
    add(mo, 'smartstore', detectTier(o.product_name, cat), N(o.payment_amount), N(o.quantity));
  }
  const mk = (obj) => Object.fromEntries(TIERS.map((t) => [t, { sales: Math.round((obj[t] || {}).sales || 0), qty: (obj[t] || {}).qty || 0 }]));
  const rows = Object.keys(months).sort().map((mo) => {
    const cafe24 = mk(months[mo].cafe24), smartstore = mk(months[mo].smartstore);
    const total = Object.fromEntries(TIERS.map((t) => [t, { sales: cafe24[t].sales + smartstore[t].sales, qty: cafe24[t].qty + smartstore[t].qty }]));
    return { ym: mo, cafe24, smartstore, total };
  });
  return { start, end, TIERS, rows };
}

// 상품별 판매량 — 몰별 (매출순 Top N, 채널 총매출 대비 비중)
async function productByChannel(start, end, limit = 40) {
  const clean = (s) => String(s || '').replace(/^(\s*\[[^\]]+\]\s*)+/, '').replace(/^요기보\s*/, '') || s;
  const caColl = await store.collection('orders_raw');
  const ssColl = await store.collection('smartstore_orders');
  const [ca, ss, caTot, ssTot] = await Promise.all([
    caColl.aggregate([
      { $match: { order_date: { $gte: start, $lte: end }, paid: true, canceled: false } },
      { $unwind: '$items' },
      { $group: { _id: '$items.product_name', qty: { $sum: '$items.quantity' }, sales: { $sum: '$items.payment_amount' } } },
      { $sort: { sales: -1 } }, { $limit: limit },
    ]).toArray(),
    ssColl.aggregate([
      { $match: { order_date: { $gte: start, $lte: end }, canceled: { $ne: true }, status: { $in: PAID_SS } } },
      { $group: { _id: '$product_name', qty: { $sum: '$quantity' }, sales: { $sum: '$payment_amount' } } },
      { $sort: { sales: -1 } }, { $limit: limit },
    ]).toArray(),
    caSum(start, end), ssSum(start, end),
  ]);
  const pack = (arr, tot) => arr.map((r) => ({ name: clean(r._id), qty: r.qty, sales: Math.round(r.sales), share: tot ? r.sales / tot : 0 }));
  return { start, end, cafe24: pack(ca, caTot.revenue), smartstore: pack(ss, ssTot.revenue) };
}

// 충전재(비즈) 등급별 판매량 — 몰별 (orders_raw + smartstore_orders)
async function tierByChannel(start, end) {
  const blank = () => Object.fromEntries(TIERS.map((t) => [t, { tier: t, qty: 0, sales: 0 }]));
  const ca = blank(), ss = blank();
  const caColl = await store.collection('orders_raw');
  const cur1 = caColl.find({ order_date: { $gte: start, $lte: end }, paid: true, canceled: false }, { projection: { items: 1 } });
  for await (const o of cur1) for (const it of (o.items || [])) {
    const cat = categoryOf({}, it.product_no, it.product_name);
    const tier = detectTier(it.product_name, cat);
    (ca[tier] = ca[tier] || { tier, qty: 0, sales: 0 }); ca[tier].qty += N(it.quantity); ca[tier].sales += N(it.payment_amount);
  }
  const ssColl = await store.collection('smartstore_orders');
  const cur2 = ssColl.find({ order_date: { $gte: start, $lte: end }, canceled: { $ne: true }, status: { $in: PAID_SS } }, { projection: { product_name: 1, product_id: 1, quantity: 1, payment_amount: 1 } });
  for await (const o of cur2) {
    const cat = categoryOf({}, o.product_id, o.product_name);
    const tier = detectTier(o.product_name, cat);
    (ss[tier] = ss[tier] || { tier, qty: 0, sales: 0 }); ss[tier].qty += N(o.quantity); ss[tier].sales += N(o.payment_amount);
  }
  const toArr = (m) => {
    const totS = Object.values(m).reduce((a, x) => a + x.sales, 0) || 1;
    const totQ = Object.values(m).reduce((a, x) => a + x.qty, 0) || 1;
    return TIERS.map((t) => ({ tier: t, qty: (m[t] || {}).qty || 0, sales: Math.round((m[t] || {}).sales || 0), share: ((m[t] || {}).sales || 0) / totS, qtyShare: ((m[t] || {}).qty || 0) / totQ }));
  };
  return { start, end, cafe24: toArr(ca), smartstore: toArr(ss) };
}

// 트래픽 → 전환 — 자사몰(방문수 API) vs 스마트스토어(방문수 미제공 → 주문 기준)
async function traffic(start, end) {
  let caVisits = 0;
  try { const daily = await analytics.dailyVisitors(start, end, 'total'); caVisits = daily.reduce((a, d) => a + (d.visits || 0), 0); } catch (_) {}
  const [ca, ss] = await Promise.all([caSum(start, end), ssSum(start, end)]);
  return {
    start, end,
    cafe24: { visits: caVisits, orders: ca.orders, revenue: ca.revenue, cvr: caVisits ? ca.orders / caVisits : null },
    smartstore: { visits: null, orders: ss.orders, revenue: ss.revenue, cvr: null },
  };
}

module.exports = { periodCompare, bestProducts, categoryPromo, promoCompare, bothSum, productByChannel, tierByChannel, traffic, monthlySeries, monthlyTierSeries };
