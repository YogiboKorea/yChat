'use strict';

/**
 * Cafe24 혜택/공동구매 분석 — orders_raw 기반.
 *   benefitUsage : 주문을 쿠폰/적립금 사용 여부로 분류 (둘다/쿠폰만/적립금만/미사용)
 *   groupBuy     : 상품명에 [공동구매] 포함 주문을 "공동구매 건"으로 모아 집계
 */

const store = require('./store');
const customers = require('./customers');
const couponsLib = require('./coupons');

const ORDERS = 'orders_raw';
const N = (v) => (Number.isFinite(+v) ? +v : 0);
const bucketOf = (o) => { const c = N(o.coupon_discount) > 0, p = N(o.points_used) > 0; return c && p ? 'both' : c ? 'couponOnly' : p ? 'pointsOnly' : 'none'; };
const isGroupBuy = (o) => (o.items || []).some((it) => /공동구매/.test(it.product_name || '')); // 공동구매 주문(적립금/쿠폰 불가)
const BUCKET_LABEL = { both: '쿠폰+적립금', couponOnly: '쿠폰만', pointsOnly: '적립금만', none: '혜택 미사용' };

async function scan(start, end, projection) {
  const coll = await store.collection(ORDERS);
  const q = { paid: true, canceled: false };
  if (start || end) { q.order_date = {}; if (start) q.order_date.$gte = start; if (end) q.order_date.$lte = end; }
  return coll.find(q, { projection });
}

// 쿠폰/적립금 사용 여부 분류 (공동구매 주문 제외 — 적립금/쿠폰 사용 불가)
async function benefitUsage(start, end) {
  const cur = await scan(start, end, { coupon_discount: 1, points_used: 1, payment_amount: 1, is_member: 1, items: 1 });
  const blank = () => ({ orders: 0, revenue: 0, coupon: 0, points: 0, members: 0 });
  const b = { both: blank(), couponOnly: blank(), pointsOnly: blank(), none: blank() };
  let total = 0, totalRev = 0, pointOrders = 0, pointSum = 0, couponOrders = 0, couponSum = 0, gbExcluded = 0;

  for await (const o of cur) {
    if (isGroupBuy(o)) { gbExcluded++; continue; } // 공동구매 주문 제외
    total++; const amt = N(o.payment_amount); totalRev += amt;
    const c = N(o.coupon_discount) > 0, p = N(o.points_used) > 0;
    const key = c && p ? 'both' : c ? 'couponOnly' : p ? 'pointsOnly' : 'none';
    const g = b[key]; g.orders++; g.revenue += amt; g.coupon += N(o.coupon_discount); g.points += N(o.points_used);
    if (o.is_member) g.members++;
    if (p) { pointOrders++; pointSum += N(o.points_used); }
    if (c) { couponOrders++; couponSum += N(o.coupon_discount); }
  }
  const round = (g) => ({ ...g, revenue: Math.round(g.revenue), coupon: Math.round(g.coupon), points: Math.round(g.points) });
  const rows = [
    { key: '쿠폰+적립금', type: 'both', ...round(b.both) },
    { key: '쿠폰만', type: 'couponOnly', ...round(b.couponOnly) },
    { key: '적립금만', type: 'pointsOnly', ...round(b.pointsOnly) },
    { key: '혜택 미사용', type: 'none', ...round(b.none) },
  ];
  return {
    start: start || null, end: end || null,
    total, totalRevenue: Math.round(totalRev), groupBuyExcluded: gbExcluded,
    pointOrders, pointSum: Math.round(pointSum), pointRatio: total ? pointOrders / total : 0,
    couponOrders, couponSum: Math.round(couponSum), couponRatio: total ? couponOrders / total : 0,
    rows,
  };
}

// 특정 구분(bucket)의 주문 상세 — 구매상품 + 쿠폰/적립금 사용액
async function benefitOrders(start, end, type, { withPII = true, limit = 500 } = {}) {
  const cur = await scan(start, end, { order_id: 1, member_id: 1, order_date: 1, payment_amount: 1, coupon_discount: 1, points_used: 1, items: 1 });
  let rows = [];
  for await (const o of cur) {
    if (isGroupBuy(o)) continue; // 공동구매 주문 제외
    if (type && bucketOf(o) !== type) continue;
    rows.push({
      order_id: o.order_id, member_id: o.member_id || '', order_date: o.order_date,
      payment_amount: N(o.payment_amount), coupon_discount: N(o.coupon_discount), points_used: N(o.points_used),
      products: (o.items || []).map((it) => `${it.product_name}${N(it.quantity) > 1 ? '×' + N(it.quantity) : ''}`).slice(0, 10),
    });
  }
  rows.sort((a, b) => (b.points_used + b.coupon_discount) - (a.points_used + a.coupon_discount) || b.payment_amount - a.payment_amount);
  rows = rows.slice(0, limit);
  // 쿠폰 사용 버킷이면 "어떤 쿠폰을 썼는지" 부착 (order_coupons 영구캐시에서 즉시)
  if (!type || type === 'both' || type === 'couponOnly') {
    try {
      const cmap = await couponsLib.couponNamesFor(rows.map((r) => r.order_id));
      rows.forEach((r) => { r.coupons = cmap[r.order_id] || []; });
    } catch (_) { rows.forEach((r) => { r.coupons = []; }); }
  }
  if (withPII) {
    const pii = await customers.getMany(rows.map((r) => r.member_id).filter(Boolean));
    rows = rows.map((r) => ({ ...r, name: (pii[r.member_id] && pii[r.member_id].name) || (r.member_id ? '' : '(비회원)') }));
  }
  return { type, label: BUCKET_LABEL[type] || type, start: start || null, end: end || null, count: rows.length, rows };
}

// [공동구매] 주문 모으기
async function groupBuy(start, end) {
  const cur = await scan(start, end, { order_id: 1, member_id: 1, first_order: 1, items: 1 });
  const orders = new Set(); const members = new Set(); const newSet = new Set();
  let sales = 0, qty = 0; const prod = {};
  for await (const o of cur) {
    let hit = false;
    for (const it of (o.items || [])) {
      if (!/공동구매/.test(it.product_name || '')) continue;
      hit = true;
      sales += N(it.payment_amount); qty += N(it.quantity);
      const nm = it.product_name;
      const p = (prod[nm] = prod[nm] || { name: nm, qty: 0, sales: 0, orders: new Set() });
      p.qty += N(it.quantity); p.sales += N(it.payment_amount); p.orders.add(o.order_id);
    }
    if (hit) { orders.add(o.order_id); if (o.member_id) members.add(o.member_id); if (o.first_order) newSet.add(o.order_id); }
  }
  const products = Object.values(prod).map((p) => ({ name: p.name, qty: p.qty, sales: Math.round(p.sales), orders: p.orders.size })).sort((a, b) => b.sales - a.sales);
  return {
    start: start || null, end: end || null,
    orders: orders.size, members: members.size, newOrders: newSet.size,
    sales: Math.round(sales), qty, aov: orders.size ? Math.round(sales / orders.size) : 0,
    productCount: products.length, products: products.slice(0, 30),
  };
}

module.exports = { benefitUsage, benefitOrders, groupBuy };
