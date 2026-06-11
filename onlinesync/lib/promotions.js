'use strict';

/**
 * 프로모션 구매 고객 관리 — "쿠폰 다운로드 → 구매" 를 고객 단위로 분리.
 *
 * 데이터: 쿠폰/issues 는 라이브(Cafe24), 주문은 로컬 거울(orders_raw) 조인.
 *   · 다운로드 고객수  = 기간 내 발급(issue) distinct member_id
 *   · 구매 고객수      = 그 중 사용(used_coupon='T') distinct member_id
 *   · 구매율           = 구매 고객수 / 다운로드 고객수
 *   · 신규/기존        = 사용 주문의 first_order 기준
 *   · 구매 상품 리스트 = 사용 주문 items 롤업
 *   · 구매 고객 명단   = member_id + PII(이름/연락처/가입일/등급) (요청 시)
 */

const c = require('./cafe24');
const store = require('./store');
const customers = require('./customers');
const { fetchIssuesInRange, targetSummary, benefitSummary, mapPool } = require('./coupons');
const { monthsBetween } = require('./segments');

const ORDERS = 'orders_raw';
const N = (v) => (Number.isFinite(+v) ? +v : 0);
const uniq = (arr) => [...new Set(arr.filter(Boolean))];

async function ordersByIds(orderIds) {
  if (!orderIds.length) return new Map();
  const coll = await store.collection(ORDERS);
  const docs = await coll.find({ order_id: { $in: orderIds } }).toArray();
  return new Map(docs.map((o) => [o.order_id, o]));
}

// 기간 내 모든 활성 쿠폰의 다운로드→구매 성과(고객 단위)
async function couponPerformance(start, end) {
  const s = c.ymd(start), e = c.ymd(end);
  const all = await c.adminPaginate('/coupons', { shop_no: 1 }, 'coupons', { limit: 100, maxPages: 5 });
  const candidates = all
    .filter((cp) => cp.deleted !== 'T' && N(cp.issued_count) > 0)
    .sort((a, b) => N(b.issued_count) - N(a.issued_count)).slice(0, 200);

  const results = await mapPool(candidates, async (cp) => {
    const issues = await fetchIssuesInRange(cp.coupon_no, s, e);
    if (!issues.length) return null;

    const downloaded = uniq(issues.map((i) => i.member_id));
    const used = issues.filter((i) => i.used_coupon === 'T');
    const purchasedMembers = uniq(used.map((i) => i.member_id));
    const orderIds = uniq(used.map((i) => i.related_order_id));
    const orderMap = await ordersByIds(orderIds);

    let revenue = 0;
    const newSet = new Set(), retSet = new Set();
    const prodAgg = {}; // product_no → {name, qty, amount, buyers:Set}
    for (const u of used) {
      const o = orderMap.get(u.related_order_id);
      if (!o) continue;
      revenue += N(o.payment_amount);
      (o.first_order ? newSet : retSet).add(o.member_id);
      for (const it of (o.items || [])) {
        const no = String(it.product_no || '');
        if (!no) continue;
        const g = (prodAgg[no] = prodAgg[no] || { product_no: no, name: it.product_name || no, qty: 0, amount: 0, buyers: new Set() });
        g.qty += N(it.quantity); g.amount += N(it.payment_amount); g.buyers.add(o.member_id);
      }
    }
    const products = Object.values(prodAgg)
      .map((g) => ({ product_no: g.product_no, name: g.name, qty: g.qty, amount: Math.round(g.amount), buyers: g.buyers.size }))
      .sort((a, b) => b.amount - a.amount);

    return {
      coupon_no: cp.coupon_no,
      coupon_name: cp.coupon_name,
      benefit: benefitSummary(cp),
      target: targetSummary(cp),
      downloaded: downloaded.length,        // 다운로드 고객수
      purchased: purchasedMembers.length,   // 구매 고객수
      purchaseRate: downloaded.length ? purchasedMembers.length / downloaded.length : 0,
      newBuyers: newSet.size,
      returningBuyers: retSet.size,
      revenue: Math.round(revenue),
      productCount: products.length,
      products: products.slice(0, 15),
      buyerMemberIds: purchasedMembers,
    };
  }, 8);

  const coupons = results.filter(Boolean).sort((a, b) => b.purchased - a.purchased || b.revenue - a.revenue);
  const totals = coupons.reduce((t, r) => {
    t.downloaded += r.downloaded; t.purchased += r.purchased; t.revenue += r.revenue;
    t.newBuyers += r.newBuyers; t.returningBuyers += r.returningBuyers; return t;
  }, { downloaded: 0, purchased: 0, revenue: 0, newBuyers: 0, returningBuyers: 0, coupons: coupons.length });
  totals.purchaseRate = totals.downloaded ? totals.purchased / totals.downloaded : 0;

  // ── 전사 프로모션 = 할인율(%)별 그룹 (그달 고객이 사용한 %쿠폰으로 유추) ──
  const rateMap = {};
  let promoRevenue = 0, promoPurchased = 0;
  for (const c of coupons) {
    if (c.benefit.kind !== 'percent' || !c.benefit.value) continue; // %할인 쿠폰만 = 전사 프로모션
    const r = c.benefit.value;
    const g = (rateMap[r] = rateMap[r] || { rate: r, coupons: 0, downloaded: 0, purchased: 0, revenue: 0, newBuyers: 0, prod: {} });
    g.coupons++; g.downloaded += c.downloaded; g.purchased += c.purchased; g.revenue += c.revenue; g.newBuyers += c.newBuyers;
    for (const p of c.products) { const x = (g.prod[p.product_no] = g.prod[p.product_no] || { name: p.name, qty: 0, amount: 0 }); x.qty += p.qty; x.amount += p.amount; }
    promoRevenue += c.revenue; promoPurchased += c.purchased;
  }
  const byRate = Object.values(rateMap).map((g) => ({
    rate: g.rate, coupons: g.coupons, downloaded: g.downloaded, purchased: g.purchased, revenue: g.revenue, newBuyers: g.newBuyers,
    aov: g.purchased ? Math.round(g.revenue / g.purchased) : 0,
    topProducts: Object.values(g.prod).sort((a, b) => b.amount - a.amount).slice(0, 3).map((p) => ({ ...p, amount: Math.round(p.amount) })),
  })).sort((a, b) => b.revenue - a.revenue);
  const promo = { revenue: Math.round(promoRevenue), purchased: promoPurchased, share: totals.revenue ? promoRevenue / totals.revenue : 0, byRate };

  return { start: s, end: e, scanned: candidates.length, totals, coupons, promo };
}

// 특정 쿠폰의 구매 고객 명단(PII 포함) — "프로모션 구매 고객 나눠서 관리"의 상세 리스트
async function couponBuyers(couponNo, start, end, { withPII = true } = {}) {
  const s = c.ymd(start), e = c.ymd(end);
  const issues = await fetchIssuesInRange(couponNo, s, e);
  const used = issues.filter((i) => i.used_coupon === 'T');
  const orderIds = uniq(used.map((i) => i.related_order_id));
  const orderMap = await ordersByIds(orderIds);

  // member_id → 구매행 (해당 쿠폰)
  const byMember = {};
  for (const u of used) {
    const o = orderMap.get(u.related_order_id);
    const mid = u.member_id || (o && o.member_id) || '';
    if (!mid) continue;
    const row = (byMember[mid] = byMember[mid] || { member_id: mid, orders: 0, amount: 0, isNew: false, products: new Set(), usedDate: u.used_date });
    row.orders += 1;
    if (o) {
      row.amount += N(o.payment_amount);
      if (o.first_order) row.isNew = true;
      for (const it of (o.items || [])) if (it.product_name) row.products.add(it.product_name);
    }
  }

  let rows = Object.values(byMember).map((r) => ({
    member_id: r.member_id, orders: r.orders, amount: Math.round(r.amount),
    isNew: r.isNew, usedDate: r.usedDate ? String(r.usedDate).slice(0, 10) : '',
    products: [...r.products].slice(0, 20),
  }));

  if (withPII) {
    const pii = await customers.getMany(rows.map((r) => r.member_id));
    rows = rows.map((r) => {
      const p = pii[r.member_id] || {};
      const tenure = p.created_date ? monthsBetween(p.created_date) : null;
      return {
        ...r,
        name: p.name || '', cellphone: p.cellphone || p.phone || '', email: p.email || '',
        created_date: p.created_date ? String(p.created_date).slice(0, 10) : '',
        tenureMonths: tenure, group_no: p.group_no != null ? p.group_no : '',
        segment: r.isNew ? '신규구매' : '기존구매',
      };
    });
  }
  rows.sort((a, b) => b.amount - a.amount);
  return { coupon_no: couponNo, start: s, end: e, count: rows.length, rows };
}

module.exports = { couponPerformance, couponBuyers };
