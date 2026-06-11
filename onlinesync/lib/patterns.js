'use strict';

/**
 * 구매 패턴 분석 — 고객 PII 없이 "어떻게 샀나" 만 집계.
 *   · 커버 동시구매(attach): 본품(소파/바디필로우/메이트) 주문 중 커버를 함께 산 비율
 *   · 주문 구성: 단품(1종) vs 복수상품(2종+) = 묶음구매
 *   · 그룹별 매출
 * 데이터: orders_raw + catalog(상품그룹). API 재호출 없음.
 */

const store = require('./store');
const catalog = require('./catalog');

const ORDERS = 'orders_raw';
const N = (v) => (Number.isFinite(+v) ? +v : 0);
const MAIN = ['소파', '바디필로우', '메이트']; // 본품

async function purchasePatterns(start, end) {
  const { productGroups } = await catalog.resolveGroupSets();
  const coll = await store.collection(ORDERS);
  const q = { paid: true, canceled: false };
  if (start || end) { q.order_date = {}; if (start) q.order_date.$gte = start; if (end) q.order_date.$lte = end; }
  const cursor = coll.find(q, { projection: { items: 1, payment_amount: 1 } });

  let total = 0, totalSales = 0;
  let single = 0, singleSales = 0, multi = 0, multiSales = 0;       // 주문 구성
  let mainOrders = 0, mainSales = 0, coverAttach = 0, coverAttachSales = 0; // 커버 attach
  let coverOnly = 0, coverOnlySales = 0;
  const groupSales = {}; // 그룹별 매출(주문에 그룹 포함 시 주문결제액 귀속? → 아이템 단위 매출 사용)

  for await (const o of cursor) {
    total++;
    const amt = N(o.payment_amount);
    totalSales += amt;
    const items = o.items || [];
    const distinct = new Set(items.map((i) => String(i.product_no || '')));
    if (distinct.size >= 2) { multi++; multiSales += amt; } else { single++; singleSales += amt; }

    const groups = new Set();
    let allCover = items.length > 0;
    for (const it of items) {
      const gs = productGroups[String(it.product_no || '')] || [];
      for (const g of gs) { groups.add(g); groupSales[g] = (groupSales[g] || 0) + N(it.payment_amount); }
      if (!gs.includes('커버')) allCover = false;
    }
    const hasCover = groups.has('커버');
    const hasMain = MAIN.some((g) => groups.has(g));
    if (hasMain) { mainOrders++; mainSales += amt; if (hasCover) { coverAttach++; coverAttachSales += amt; } }
    if (allCover && items.length) { coverOnly++; coverOnlySales += amt; }
  }

  const r = (n) => Math.round(n);
  return {
    start: start || null, end: end || null,
    total, totalSales: r(totalSales),
    composition: {
      single: { orders: single, sales: r(singleSales), ratio: total ? single / total : 0 },
      multi: { orders: multi, sales: r(multiSales), ratio: total ? multi / total : 0 }, // 묶음(복수상품) 구매
    },
    coverAttach: {
      mainOrders, mainSales: r(mainSales),
      attachOrders: coverAttach, attachSales: r(coverAttachSales),
      attachRate: mainOrders ? coverAttach / mainOrders : 0,
      coverOnlyOrders: coverOnly, coverOnlySales: r(coverOnlySales),
    },
    groupSales: Object.entries(groupSales).map(([group, sales]) => ({ group, sales: r(sales) })).sort((a, b) => b.sales - a.sales),
  };
}

module.exports = { purchasePatterns };
