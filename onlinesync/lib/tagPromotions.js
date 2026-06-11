'use strict';

/**
 * 상품태그 프로모션 — 상품명 [브래킷]([클리어런스]/[공동구매]/[리퍼 한정수량]...) 단위 매출 집계.
 * 고객 PII 불필요 — 프로모션별 "구매상품 + 구매총액 + 기간" 만.
 *   · 한 상품 다중태그 가능 → 각 태그에 귀속
 *   · 기간할인(direct_discount) 함께 집계
 * 데이터: orders_raw 만 (API 재호출 없음).
 */

const store = require('./store');
const customers = require('./customers');
const { monthsBetween } = require('./segments');

const ORDERS = 'orders_raw';
const N = (v) => (Number.isFinite(+v) ? +v : 0);

function extractTags(name) {
  const out = []; const re = /\[([^\]]+)\]/g; let m;
  while ((m = re.exec(String(name || '')))) { const t = m[1].trim(); if (t) out.push(t); }
  return out;
}

async function scan(start, end, projection) {
  const coll = await store.collection(ORDERS);
  const q = { paid: true, canceled: false };
  if (start || end) { q.order_date = {}; if (start) q.order_date.$gte = start; if (end) q.order_date.$lte = end; }
  return coll.find(q, { projection });
}

// 태그별 프로모션 매출 (집계)
async function tagPromotionSales(start, end) {
  const cursor = await scan(start, end, { order_id: 1, items: 1 });
  const map = {};
  for await (const o of cursor) {
    for (const it of (o.items || [])) {
      const tags = extractTags(it.product_name);
      if (!tags.length) continue;
      for (const tag of tags) {
        const t = (map[tag] = map[tag] || { tag, orders: new Set(), qty: 0, sales: 0, directDiscount: 0, couponDiscount: 0, products: {} });
        t.orders.add(o.order_id);
        t.qty += N(it.quantity);
        t.sales += N(it.payment_amount);
        t.directDiscount += N(it.direct_discount);
        t.couponDiscount += N(it.coupon_discount);
        const pno = String(it.product_no || '');
        const p = (t.products[pno] = t.products[pno] || { product_no: pno, name: it.product_name, qty: 0, sales: 0 });
        p.qty += N(it.quantity); p.sales += N(it.payment_amount);
      }
    }
  }
  const rows = Object.values(map).map((t) => ({
    tag: t.tag, orders: t.orders.size, qty: t.qty, sales: Math.round(t.sales),
    directDiscount: Math.round(t.directDiscount), couponDiscount: Math.round(t.couponDiscount),
    totalDiscount: Math.round(t.directDiscount + t.couponDiscount),
    productCount: Object.keys(t.products).length,
  })).sort((a, b) => b.sales - a.sales);

  const totals = rows.reduce((s, r) => { s.sales += r.sales; s.qty += r.qty; s.orders += r.orders; s.directDiscount += r.directDiscount; s.couponDiscount += r.couponDiscount; return s; }, { sales: 0, qty: 0, orders: 0, directDiscount: 0, couponDiscount: 0, tags: rows.length });
  return { start: start || null, end: end || null, totals, tags: rows };
}

// 특정 태그 상세 — 상품별 매출 + 일별 추이 (집계, PII 없음)
async function tagPromotionDetail(tag, start, end) {
  const cursor = await scan(start, end, { order_id: 1, order_date: 1, items: 1 });
  const products = {}; const daily = {};
  let sales = 0, qty = 0, directDiscount = 0; const orders = new Set();
  for await (const o of cursor) {
    let daySales = 0;
    for (const it of (o.items || [])) {
      if (!extractTags(it.product_name).includes(tag)) continue;
      const amt = N(it.payment_amount);
      orders.add(o.order_id);
      sales += amt; qty += N(it.quantity); directDiscount += N(it.direct_discount); daySales += amt;
      const pno = String(it.product_no || '');
      const p = (products[pno] = products[pno] || { product_no: pno, name: it.product_name, qty: 0, sales: 0, orders: new Set() });
      p.qty += N(it.quantity); p.sales += amt; p.orders.add(o.order_id);
    }
    if (daySales > 0) daily[o.order_date] = (daily[o.order_date] || 0) + daySales;
  }
  return {
    tag, start: start || null, end: end || null,
    sales: Math.round(sales), qty, orders: orders.size, directDiscount: Math.round(directDiscount),
    products: Object.values(products).map((p) => ({ product_no: p.product_no, name: p.name, qty: p.qty, sales: Math.round(p.sales), orders: p.orders.size })).sort((a, b) => b.sales - a.sales),
    daily: Object.entries(daily).map(([date, v]) => ({ date, sales: Math.round(v) })).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

// 라이브 주문 배열에서 다이렉트/태그 프로모션 매출 요약 (overview KPI용; raw 주문 필드 사용)
function summaryFromLiveOrders(orders) {
  let sales = 0, directDiscount = 0; const ord = new Set();
  for (const o of (orders || [])) {
    if (o.paid !== 'T' || o.canceled === 'T') continue;
    for (const it of (o.items || [])) {
      const hasTag = extractTags(it.product_name).length > 0;
      const dd = N(it.additional_discount_price);
      if (hasTag || dd > 0) { sales += N(it.payment_amount); ord.add(o.order_id); }
      directDiscount += dd;
    }
  }
  return { sales: Math.round(sales), orders: ord.size, directDiscount: Math.round(directDiscount) };
}

// 특정 태그 구매 고객 명단 (PII) — 클릭 드릴다운용
async function tagPromotionBuyers(tag, start, end, { withPII = true } = {}) {
  const cursor = await scan(start, end, { order_id: 1, member_id: 1, first_order: 1, items: 1 });
  const byMember = {};
  for await (const o of cursor) {
    let amount = 0; const prods = new Set();
    for (const it of (o.items || [])) {
      if (!extractTags(it.product_name).includes(tag)) continue;
      amount += N(it.payment_amount);
      if (it.product_name) prods.add(it.product_name);
    }
    if (amount <= 0 && !prods.size) continue;
    const mid = o.member_id || '';
    const key = mid || `guest:${o.order_id}`;
    const r = (byMember[key] = byMember[key] || { member_id: mid, is_member: !!mid, orders: 0, amount: 0, isNew: false, products: new Set() });
    r.orders += 1; r.amount += amount; if (o.first_order) r.isNew = true;
    prods.forEach((p) => r.products.add(p));
  }
  let rows = Object.values(byMember).map((r) => ({
    member_id: r.member_id, is_member: r.is_member, orders: r.orders, amount: Math.round(r.amount),
    isNew: r.isNew, products: [...r.products].slice(0, 20),
  }));
  if (withPII) {
    const pii = await customers.getMany(rows.filter((r) => r.is_member).map((r) => r.member_id));
    rows = rows.map((r) => {
      const p = pii[r.member_id] || {};
      const tenure = p.created_date ? monthsBetween(p.created_date) : null;
      return {
        ...r, name: p.name || (r.is_member ? '' : '(비회원)'), cellphone: p.cellphone || p.phone || '', email: p.email || '',
        created_date: p.created_date ? String(p.created_date).slice(0, 10) : '', tenureMonths: tenure,
        group_no: p.group_no != null ? p.group_no : '', segment: r.isNew ? '신규구매' : (r.is_member ? '기존구매' : '비회원'),
      };
    });
  }
  rows.sort((a, b) => b.amount - a.amount);
  return { tag, start: start || null, end: end || null, count: rows.length, rows };
}

module.exports = { tagPromotionSales, tagPromotionDetail, tagPromotionBuyers, summaryFromLiveOrders, extractTags };
