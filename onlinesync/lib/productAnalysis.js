'use strict';

/**
 * 상품/구매 분석 (스크린샷 구조) — orders_raw 기반, API 재호출 없음.
 *   카테고리 분포 · 충전재(등급) 비중 · 제품 TOP · 인기 색상 · 요일별 패턴
 *   + KPI: 구매건수/카테고리별 수량/세트구매/커버동시구매/객단가 (CVR은 endpoint에서 방문수와 결합)
 */

const store = require('./store');
const catalog = require('./catalog');
const { detectTier, detectLine, categoryOf } = require('./salesBreakdown');

const ORDERS = 'orders_raw';
const N = (v) => (Number.isFinite(+v) ? +v : 0);
const MAIN = ['소파', '바디필로우', '메이트'];
const WD = ['일', '월', '화', '수', '목', '금', '토'];

function cleanName(name) {
  return String(name || '').replace(/^(\s*\[[^\]]+\]\s*)+/, '').replace(/^요기보\s*/, '').trim();
}
function parseColor(ov) {
  const m = String(ov || '').match(/색상\s*=\s*([^,;]+)/);
  if (!m) return null;
  const parts = m[1].trim().split('/').map((x) => x.trim()).filter(Boolean);
  return parts.length > 1 ? parts[1] : parts[0];
}

async function analyze(start, end) {
  const { productGroups } = await catalog.resolveGroupSets();
  const coll = await store.collection(ORDERS);
  const q = { paid: true, canceled: false };
  if (start || end) { q.order_date = {}; if (start) q.order_date.$gte = start; if (end) q.order_date.$lte = end; }
  const cursor = coll.find(q, { projection: { order_id: 1, order_date: 1, payment_amount: 1, points_used: 1, items: 1 } });

  const catD = {}, fillerD = {}, prodD = {}, colorD = {}, wd = {};
  let orders = 0, revenue = 0, setOrders = 0, coverAttachOrders = 0, pointsUsed = 0, pointsOrders = 0;
  const catQty = {};

  for await (const o of cursor) {
    orders++; revenue += N(o.payment_amount);
    if (N(o.points_used) > 0) { pointsUsed += N(o.points_used); pointsOrders++; }
    const d = new Date(o.order_date + 'T00:00:00'); const dow = isNaN(d) ? 0 : d.getDay();
    const w = (wd[dow] = wd[dow] || { dow, label: WD[dow], orders: 0, sales: 0 });
    w.orders++; w.sales += N(o.payment_amount);

    const groups = new Set(); let hasBundle = false; const distinctProds = new Set();
    for (const it of (o.items || [])) {
      const qty = N(it.quantity), amt = N(it.payment_amount);
      const cat = categoryOf(productGroups, it.product_no, it.product_name);
      const tier = detectTier(it.product_name, cat);
      (productGroups[String(it.product_no || '')] || []).forEach((g) => groups.add(g));
      if (it.is_bundle) hasBundle = true;
      distinctProds.add(String(it.product_no || ''));

      (catD[cat] = catD[cat] || { cat, qty: 0, sales: 0 }); catD[cat].qty += qty; catD[cat].sales += amt;
      catQty[cat] = (catQty[cat] || 0) + qty;
      (fillerD[tier] = fillerD[tier] || { tier, qty: 0, sales: 0 }); fillerD[tier].qty += qty; fillerD[tier].sales += amt;

      const nm = cleanName(it.product_name) || it.product_name;
      const p = (prodD[nm] = prodD[nm] || { name: nm, qty: 0, sales: 0, tier, line: detectLine(it.product_name), cat });
      p.qty += qty; p.sales += amt;

      const color = parseColor(it.option_value);
      if (color) { (colorD[color] = colorD[color] || { color, qty: 0, sales: 0 }); colorD[color].qty += qty; colorD[color].sales += amt; }
    }
    // 세트구매 = 번들 상품 OR 복수상품(2종+) 주문
    if (hasBundle || distinctProds.size >= 2) setOrders++;
    const hasCover = groups.has('커버'); const hasMain = MAIN.some((g) => groups.has(g));
    if (hasCover && hasMain) coverAttachOrders++;
  }

  const totalQty = Object.values(catD).reduce((a, c) => a + c.qty, 0);
  const arr = (obj, sortKey = 'qty') => Object.values(obj).sort((a, b) => b[sortKey] - a[sortKey]);
  const round = (o) => ({ ...o, sales: Math.round(o.sales) });

  return {
    start: start || null, end: end || null,
    kpis: {
      orders, revenue: Math.round(revenue), aov: orders ? Math.round(revenue / orders) : 0,
      setOrders, setRatio: orders ? setOrders / orders : 0,
      coverAttachOrders, coverAttachRatio: orders ? coverAttachOrders / orders : 0,
      pointsUsed: Math.round(pointsUsed), pointsOrders,
      sofaQty: catQty['소파'] || 0, bodyQty: catQty['바디필로우'] || 0, totalQty,
    },
    categoryDist: arr(catD).map((c) => round({ ...c, share: totalQty ? c.qty / totalQty : 0 })),
    fillerDist: arr(fillerD).map((c) => round({ ...c, share: totalQty ? c.qty / totalQty : 0 })),
    productTop: arr(prodD).slice(0, 30).map((p) => round({ ...p, share: totalQty ? p.qty / totalQty : 0 })),
    colorTop: arr(colorD).slice(0, 25).map(round),
    weekday: Array.from({ length: 7 }, (_, i) => wd[i] ? round(wd[i]) : { dow: i, label: WD[i], orders: 0, sales: 0 }),
  };
}

// 특정 제품라인 × 충전재(등급) 조합의 판매 제품 상세
async function lineTierProducts(start, end, line, tier) {
  const { productGroups } = await catalog.resolveGroupSets();
  const coll = await store.collection(ORDERS);
  const q = { paid: true, canceled: false };
  if (start || end) { q.order_date = {}; if (start) q.order_date.$gte = start; if (end) q.order_date.$lte = end; }
  const cursor = coll.find(q, { projection: { order_id: 1, items: 1 } });

  const prods = {};
  for await (const o of cursor) {
    for (const it of (o.items || [])) {
      const cat = categoryOf(productGroups, it.product_no, it.product_name);
      if (line && detectLine(it.product_name) !== line) continue;
      if (tier && detectTier(it.product_name, cat) !== tier) continue;
      const key = it.product_name || String(it.product_no);
      const p = (prods[key] = prods[key] || { product_name: key, qty: 0, sales: 0, orders: new Set() });
      p.qty += N(it.quantity); p.sales += N(it.payment_amount); p.orders.add(o.order_id);
    }
  }
  const rows = Object.values(prods).map((p) => ({ product_name: p.product_name, qty: p.qty, sales: Math.round(p.sales), orders: p.orders.size }))
    .sort((a, b) => b.sales - a.sales);
  return { line, tier, start: start || null, end: end || null, count: rows.length, rows };
}

module.exports = { analyze, lineTierProducts, parseColor, cleanName };
