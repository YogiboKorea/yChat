'use strict';

/**
 * 프로모션(쿠폰) 성과 분석 — 두 관점.
 *
 *  A) 상품별 프로모션 성과  productPromotion(orders)
 *     - 주문 아이템 중 coupon_discount_price>0 인 항목을 상품별로 롤업(실거래 기반, 정확).
 *     - 산출: 상품별 쿠폰적용 주문수/수량/상품매출/쿠폰할인액.
 *
 *  B) 쿠폰별 발급→사용 깔때기  couponFunnel(start, end, orderMap)
 *     - 기간 내 "발급된" 쿠폰 코호트(/coupons/{no}/issues?issued_start_date..issued_end_date).
 *     - 산출: 쿠폰별 발급수→사용수→사용률→연결매출(related_order_id 조인).
 *     - issued_start_date/issued_end_date, used_coupon 필터는 프로빙으로 동작 확인됨.
 */

const c = require('./cafe24');
const store = require('./store');

const N = (v) => (Number.isFinite(+v) ? +v : 0);
const isPaidNet = (o) => o.paid === 'T' && o.canceled !== 'T';

// ── A) 상품별 프로모션 성과 (주문 아이템 기반) ──
function productPromotion(orders) {
  const byProduct = {};
  let couponOrders = 0, totalCouponDiscount = 0, totalCouponSales = 0;
  const seenCouponOrder = new Set();

  for (const o of orders) {
    if (!isPaidNet(o)) continue;
    const items = o.items || [];
    let orderHasCoupon = false;

    for (const it of items) {
      const disc = N(it.coupon_discount_price);
      if (disc <= 0) continue;
      orderHasCoupon = true;

      const pno = it.product_no != null ? String(it.product_no) : (it.product_code || '?');
      const g = (byProduct[pno] = byProduct[pno] || {
        product_no: pno, product_name: it.product_name || it.product_name_default || '(이름없음)',
        orders: new Set(), quantity: 0, sales: 0, discount: 0,
      });
      g.orders.add(o.order_id);
      g.quantity += N(it.quantity);
      g.sales += N(it.payment_amount);
      g.discount += disc;

      totalCouponSales += N(it.payment_amount);
      totalCouponDiscount += disc;
    }
    if (orderHasCoupon && !seenCouponOrder.has(o.order_id)) { seenCouponOrder.add(o.order_id); couponOrders++; }
  }

  const products = Object.values(byProduct).map((g) => ({
    product_no: g.product_no,
    product_name: g.product_name,
    orders: g.orders.size,
    quantity: g.quantity,
    sales: Math.round(g.sales),
    discount: Math.round(g.discount),
    discountRate: g.sales + g.discount ? g.discount / (g.sales + g.discount) : 0,
  })).sort((a, b) => b.sales - a.sales);

  return {
    couponOrders,
    totalCouponSales: Math.round(totalCouponSales),
    totalCouponDiscount: Math.round(totalCouponDiscount),
    products: products.slice(0, 50),
    productCount: products.length,
  };
}

// ── 간단 동시성 풀 ──
async function mapPool(items, worker, concurrency = 8) {
  const out = new Array(items.length);
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await worker(items[i], i); }
      catch (_) { out[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, run));
  return out;
}

function targetSummary(cp) {
  const prods = Array.isArray(cp.available_product_list) ? cp.available_product_list : [];
  const cats = Array.isArray(cp.available_category_list) ? cp.available_category_list : [];
  if (prods.length) return { type: '상품지정', count: prods.length, label: `상품 ${prods.length}개`, products: prods.slice(0, 200), categories: cats };
  if (cats.length) return { type: '카테고리지정', count: cats.length, label: `카테고리 ${cats.length}개`, products: [], categories: cats };
  return { type: '전체상품', count: 0, label: '전체상품', products: [], categories: [] };
}

function benefitSummary(cp) {
  if (cp.benefit_type === 'P' || cp.benefit_percentage) {
    return { kind: 'percent', text: cp.benefit_text || `${N(cp.benefit_percentage)}%`, value: N(cp.benefit_percentage) };
  }
  return { kind: 'amount', text: cp.benefit_text || `${N(cp.benefit_price).toLocaleString()}원`, value: N(cp.benefit_price) };
}

// 발급일 윈도우를 maxDays(=31) 이하 구간들로 분할 (Cafe24 issues 필터 최대 ~31일 → 초과 시 422)
function chunkRanges(s, e, maxDays = 31) {
  const out = [];
  const oneDay = 86400000;
  let cur = new Date(s + 'T00:00:00Z');
  const last = new Date(e + 'T00:00:00Z');
  while (cur <= last) {
    const from = new Date(cur);
    const to = new Date(Math.min(last.getTime(), from.getTime() + (maxDays - 1) * oneDay));
    out.push([from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)]);
    cur = new Date(to.getTime() + oneDay);
  }
  return out;
}

// 한 쿠폰의 기간내 발급 issues 전량 (31일 청크 × 페이지네이션). issues 엔드포인트 limit 상한이 낮아 limit=100.
async function fetchIssuesInRange(couponNo, s, e) {
  const ranges = chunkRanges(s, e, 31);
  const all = [];
  for (const [from, to] of ranges) {
    try {
      const part = await c.adminPaginate(`/coupons/${couponNo}/issues`,
        { shop_no: 1, issued_start_date: from, issued_end_date: to },
        'issues', { limit: 100, maxPages: 100 });
      all.push(...part);
    } catch (_) { /* 구간 실패는 건너뜀 */ }
  }
  return all;
}

// ── B) 쿠폰별 발급→사용 깔때기 (기간 발급 코호트) ──
//  쿠폰 issues API 스캔이 200개×페이지네이션으로 수십초~수분 → coupon_funnel_cache 에 구간별 저장.
//  · 캐시 우선: 호출 시 DB 저장본을 먼저 반환(지문 다르면 stale 표시만).
//  · 배포(READ_ONLY) 환경에선 캐시가 없어도 라이브 92초 스캔을 절대 돌리지 않고 'pending' 빈 결과 반환 → Vercel 타임아웃 방지.
//  · 실제 무거운 스캔은 로컬(force=true 또는 캐시 없을 때)에서만 수행하고 결과를 캐시에 적재.
const FUNNEL_CACHE = 'coupon_funnel_cache';
const SHOP_ID = process.env.CAFE24_MALL_ID || 'yogibo';

async function funnelFingerprint() {
  let syncedAt = '', count = 0;
  try { const m = await (await store.collection('sync_meta')).findOne({ _id: 'orders_meta' }); syncedAt = (m && m.syncedAt) || ''; } catch (_) {}
  try { count = await (await store.collection('orders_raw')).estimatedDocumentCount(); } catch (_) {}
  return `${syncedAt}|${count}`;
}

function emptyFunnel(s, e, pending) {
  return { start: s, end: e, totals: { issued: 0, used: 0, revenue: 0, discount: 0, coupons: 0, useRate: 0 }, coupons: [], scanned: 0, pending: !!pending };
}

// orders_raw 에서 funnel 매출 조인용 orderMap 구성 (related_order_id → 결제/쿠폰할인)
async function ordersMapFromStore(s, e) {
  const map = new Map();
  try {
    const coll = await store.collection('orders_raw');
    const rows = await coll.find({ order_date: { $gte: s, $lte: e } }, { projection: { order_id: 1, payment_amount: 1, coupon_discount: 1 } }).toArray();
    for (const o of rows) {
      map.set(o.order_id, { payment_amount: o.payment_amount, actual_order_amount: { coupon_discount_price: o.coupon_discount } });
    }
  } catch (_) {}
  return map;
}

async function couponFunnel(start, end, orderMap, { force = false } = {}) {
  const s = c.ymd(start), e = c.ymd(end);
  const fp = await funnelFingerprint();
  const key = `${SHOP_ID}:${s}:${e}`;
  let cacheColl = null;
  try { cacheColl = await store.collection(FUNNEL_CACHE); } catch (_) {}

  // 캐시 우선 — 저장본이 있으면 무조건 먼저 반환(지문 다르면 stale)
  if (!force && cacheColl) {
    const hit = await cacheColl.findOne({ _id: key });
    if (hit) {
      return { start: s, end: e, totals: hit.totals, coupons: hit.coupons || [], scanned: hit.scanned || 0, cached: true, stale: hit.fingerprint !== fp, builtAt: hit.builtAt };
    }
  }

  // force=true(워밍/일일 동기화) 일 때만 무거운 92초 라이브 스캔 수행.
  //  대시보드 읽기 경로(force=false)는 캐시 미스여도 절대 블록하지 않고 pending 반환 → 로컬·배포 모두 즉시 응답.
  if (!force) {
    return { ...emptyFunnel(s, e, true), cached: false };
  }

  const out = await computeCouponFunnel(s, e, orderMap);
  const builtAt = new Date().toISOString();
  if (cacheColl) {
    try { await cacheColl.updateOne({ _id: key }, { $set: { ...out, fingerprint: fp, builtAt } }, { upsert: true }); } catch (_) {}
  }
  return { ...out, cached: false, stale: false, builtAt };
}

// 실제 라이브 스캔(무거움) — 로컬/워밍에서만 호출
async function computeCouponFunnel(start, end, orderMap) {
  const s = c.ymd(start), e = c.ymd(end);
  orderMap = orderMap || await ordersMapFromStore(s, e);
  const all = await c.adminPaginate('/coupons', { shop_no: 1 }, 'coupons', { limit: 100, maxPages: 5 });
  const candidates = all
    .filter((cp) => cp.deleted !== 'T' && N(cp.issued_count) > 0)
    .sort((a, b) => N(b.issued_count) - N(a.issued_count))
    .slice(0, 200); // 안전 캡

  const results = await mapPool(candidates, async (cp) => {
    const issues = await fetchIssuesInRange(cp.coupon_no, s, e);
    if (!issues.length) return null; // 기간 내 발급 없음 → 제외

    let used = 0, revenue = 0, discount = 0, revenueMatched = 0;
    for (const is of issues) {
      if (is.used_coupon === 'T') {
        used++;
        const o = is.related_order_id && orderMap.get(is.related_order_id);
        if (o) {
          revenueMatched++;
          revenue += N(o.payment_amount);
          discount += N(o.actual_order_amount && o.actual_order_amount.coupon_discount_price);
        }
      }
    }
    const issued = issues.length;
    return {
      coupon_no: cp.coupon_no,
      coupon_name: cp.coupon_name,
      coupon_type: cp.coupon_type, // O: 자동발급, ...
      benefit: benefitSummary(cp),
      target: targetSummary(cp),
      issued,
      used,
      useRate: issued ? used / issued : 0,
      revenue: Math.round(revenue),
      discount: Math.round(discount),
      revenueMatched,        // related_order_id 가 기간 주문에서 조인된 건수
      issuedCountAllTime: N(cp.issued_count),
    };
  }, 8);

  const coupons = results.filter(Boolean).sort((a, b) => b.used - a.used || b.issued - a.issued);

  const totals = coupons.reduce((t, r) => {
    t.issued += r.issued; t.used += r.used; t.revenue += r.revenue; t.discount += r.discount; return t;
  }, { issued: 0, used: 0, revenue: 0, discount: 0, coupons: coupons.length });
  totals.useRate = totals.issued ? totals.used / totals.issued : 0;

  return { start: s, end: e, totals, coupons, scanned: candidates.length };
}

// ── C) 주문ID → 사용 쿠폰명 영구 캐시 (order_coupons) ──
//  주문 raw 에는 쿠폰명이 없음(금액만). issues.related_order_id 로 주문↔쿠폰명을 역매핑해 DB에 적재.
//  ⑤ 적립금·쿠폰 드릴다운은 이 캐시를 즉시 읽어 "어떤 쿠폰을 썼는지" 표시(쿼리 시 API 0회).
const OC_COLL = 'order_coupons';

async function syncCouponNames(start, end, { onProgress } = {}) {
  const s = c.ymd(start), e = c.ymd(end);
  const all = await c.adminPaginate('/coupons', { shop_no: 1 }, 'coupons', { limit: 100, maxPages: 5 });
  const candidates = all
    .filter((cp) => N(cp.issued_count) > 0)                 // 발급 이력 있는 쿠폰만 (삭제된 쿠폰도 과거 사용분 매핑 위해 포함)
    .sort((a, b) => N(b.issued_count) - N(a.issued_count))
    .slice(0, 400);                                          // 안전 캡

  const coll = await store.collection(OC_COLL);
  try { await coll.createIndex({ order_id: 1 }, { unique: true }); } catch (_) {}

  const map = new Map(); // order_id → Set(coupon_name)
  let done = 0;
  await mapPool(candidates, async (cp) => {
    const issues = await fetchIssuesInRange(cp.coupon_no, s, e);
    for (const is of issues) {
      if (is.used_coupon === 'T' && is.related_order_id) {
        let set = map.get(is.related_order_id);
        if (!set) { set = new Set(); map.set(is.related_order_id, set); }
        set.add(cp.coupon_name || `쿠폰#${cp.coupon_no}`);
      }
    }
    done++; if (onProgress) onProgress({ done, total: candidates.length, coupon: cp.coupon_name, orders: map.size });
  }, 8);

  const now = new Date().toISOString();
  const ops = [];
  for (const [oid, set] of map) {
    ops.push({ updateOne: { filter: { order_id: oid }, update: { $set: { order_id: oid, coupons: [...set], _syncedAt: now } }, upsert: true } });
  }
  for (let i = 0; i < ops.length; i += 1000) {
    try { await coll.bulkWrite(ops.slice(i, i + 1000), { ordered: false }); } catch (_) {}
  }
  return { start: s, end: e, scanned: candidates.length, mappedOrders: map.size };
}

// 주문ID 배열 → { order_id: [쿠폰명...] }  (DB 캐시에서 즉시, API 미사용)
async function couponNamesFor(orderIds) {
  const ids = [...new Set((orderIds || []).filter(Boolean))];
  if (!ids.length) return {};
  let coll;
  try { coll = await store.collection(OC_COLL); } catch (_) { return {}; }
  const docs = await coll.find({ order_id: { $in: ids } }, { projection: { order_id: 1, coupons: 1 } }).toArray();
  const out = {};
  for (const d of docs) out[d.order_id] = d.coupons || [];
  return out;
}

module.exports = { productPromotion, couponFunnel, computeCouponFunnel, chunkRanges, fetchIssuesInRange, targetSummary, benefitSummary, mapPool, syncCouponNames, couponNamesFor };
