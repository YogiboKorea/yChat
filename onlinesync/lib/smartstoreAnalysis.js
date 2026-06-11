'use strict';

/**
 * 스마트스토어 판매 분석 — smartstore_orders 기반. Cafe24와 "동일 양식" 산출.
 *   KPI(매출/정산/수수료/할인/주문/객단가/수량)
 *   salesBreakdown(카테고리×충전재 + 제품라인×충전재) ← Cafe24 총매출 분해와 동일
 *   patterns(단품/복수, 커버 동시구매) · categoryDist · fillerDist · productTop · colorTop · inflow · weekday
 * 네이버 주문은 상품주문 1건 = 1 상품. 주문(order_id)로 묶어 구매패턴 계산.
 */

const store = require('./store');
const { detectTier, detectLine, categoryOf, TIERS } = require('./salesBreakdown');

const COLL = 'smartstore_orders';
const N = (v) => (Number.isFinite(+v) ? +v : 0);
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const PAID = new Set(['PAYED', 'DELIVERING', 'DELIVERED', 'PURCHASE_DECIDED', 'EXCHANGED']);
const BIZ_CATS = new Set(['소파', '바디필로우', '메이트']);
const MAIN = ['소파', '바디필로우', '메이트'];

// 네이버 쿠폰/할인 클래스코드 → 한글 라벨
const COUPON_LABEL = {
  NMP_PRD_DCNT: '상품 할인쿠폰', NMP_PRD_DUP_DCNT: '상품 중복할인', NMP_PRD_IMDT_DCNT: '상품 즉시할인',
  NMP_STORE_DCNT: '스토어 할인쿠폰', NMP_STORE_DUP_DCNT: '스토어 중복할인',
  NMP_DLV_DCNT: '배송비 할인쿠폰', NMP_MULTI_DCNT: '복수구매 할인', SELLER_STORE_DCNT: '판매자 스토어할인',
};
function couponLabel(code) { return COUPON_LABEL[code] || code; }
function cleanName(name) { return String(name || '').replace(/^(\s*\[[^\]]+\]\s*)+/, '').replace(/^요기보\s*/, '').trim(); }
function parseColor(ov) {
  const m = String(ov || '').match(/색상\s*[:=]\s*(.+)/);
  if (!m) return null;
  const parts = m[1].split('/').map((x) => x.trim()).filter(Boolean);
  return parts.length > 1 ? parts[1] : parts[0];
}
const blankTiers = () => Object.fromEntries(TIERS.map((t) => [t, { sales: 0, qty: 0 }]));

async function analyze(start, end) {
  const coll = await store.collection(COLL);
  const q = { canceled: { $ne: true } };
  if (start || end) { q.order_date = {}; if (start) q.order_date.$gte = start; if (end) q.order_date.$lte = end; }
  const cursor = coll.find(q);

  const catD = {}, fillerD = {}, prodD = {}, colorD = {}, wd = {}, inflowD = {}, deD = {};
  const cats = {}, lines = {}, tierTotals = blankTiers();
  const orders = {}; // order_id → { groups:Set, products:Set, sales }
  const orderIds = new Set();
  let linesCnt = 0, qty = 0, revenue = 0, settlement = 0, commission = 0, discount = 0, grand = 0, grandQty = 0;
  let immDisc = 0, prodCpnDisc = 0, storeCpnDisc = 0, delivDisc = 0, couponOrders = 0;
  const couponAgg = {};
  const catQty = {};

  for await (const o of cursor) {
    if (!PAID.has(o.status)) continue;
    linesCnt++; orderIds.add(o.order_id);
    const aQty = N(o.quantity), amt = N(o.payment_amount);
    qty += aQty; revenue += amt; settlement += N(o.settlement); commission += N(o.commission); discount += N(o.discount);
    immDisc += N(o.discount_immediate); prodCpnDisc += N(o.discount_product_coupon); storeCpnDisc += N(o.discount_store_coupon); delivDisc += N(o.delivery_discount);
    const ac = Array.isArray(o.applied_coupons) ? o.applied_coupons : [];
    if (ac.length) {
      couponOrders++;
      for (const cp of ac) {
        const nm = cp.couponName || cp.name || cp.couponClassName || couponLabel(cp.couponClassCode) || cp.couponId || '쿠폰';
        const camt = N(cp.couponDiscountAmount || cp.discountAmount || cp.amount || cp.benefitAmount);
        (couponAgg[nm] = couponAgg[nm] || { name: nm, orders: 0, discount: 0 }); couponAgg[nm].orders++; couponAgg[nm].discount += camt;
      }
    }

    const cat = categoryOf({}, o.product_id, o.product_name);
    const tier = detectTier(o.product_name, cat);

    // 분포
    (catD[cat] = catD[cat] || { cat, qty: 0, sales: 0 }); catD[cat].qty += aQty; catD[cat].sales += amt; catQty[cat] = (catQty[cat] || 0) + aQty;
    (fillerD[tier] = fillerD[tier] || { tier, qty: 0, sales: 0 }); fillerD[tier].qty += aQty; fillerD[tier].sales += amt;
    const nm = cleanName(o.product_name) || o.product_name;
    (prodD[nm] = prodD[nm] || { name: nm, qty: 0, sales: 0, tier }); prodD[nm].qty += aQty; prodD[nm].sales += amt;
    const color = parseColor(o.option_value);
    if (color) { (colorD[color] = colorD[color] || { color, qty: 0, sales: 0 }); colorD[color].qty += aQty; colorD[color].sales += amt; }

    // 할인 이벤트 = 즉시할인(다이렉트 할인) 진행 상품
    if (N(o.discount_immediate) > 0) {
      const dn = cleanName(o.product_name) || o.product_name;
      const de = (deD[dn] = deD[dn] || { name: dn, tier: detectTier(o.product_name, cat), qty: 0, sales: 0, immediate: 0, total: 0, _orders: new Set() });
      de.qty += aQty; de.sales += amt; de.immediate += N(o.discount_immediate); de.total += N(o.discount); de._orders.add(o.order_id);
    }
    const d = new Date(o.order_date + 'T00:00:00'); const dow = isNaN(d) ? 0 : d.getDay();
    (wd[dow] = wd[dow] || { dow, label: WD[dow], orders: 0, sales: 0 }); wd[dow].orders++; wd[dow].sales += amt;
    const ip = o.inflow_path || '(미상)';
    (inflowD[ip] = inflowD[ip] || { inflow: ip, orders: 0, sales: 0 }); inflowD[ip].orders++; inflowD[ip].sales += amt;

    // 매출 분해 (카테고리×충전재)
    const c = (cats[cat] = cats[cat] || { cat, total: 0, qty: 0, tiers: blankTiers() });
    c.total += amt; c.qty += aQty; c.tiers[tier].sales += amt; c.tiers[tier].qty += aQty;
    tierTotals[tier].sales += amt; tierTotals[tier].qty += aQty; grand += amt; grandQty += aQty;
    if (BIZ_CATS.has(cat)) {
      const line = detectLine(o.product_name);
      const L = (lines[line] = lines[line] || { line, total: 0, qty: 0, tiers: blankTiers() });
      L.total += amt; L.qty += aQty; L.tiers[tier].sales += amt; L.tiers[tier].qty += aQty;
    }

    // 주문 단위(구매패턴)
    const od = (orders[o.order_id] = orders[o.order_id] || { groups: new Set(), products: new Set(), sales: 0 });
    od.products.add(o.product_id || nm); if (cat) od.groups.add(cat); od.sales += amt;
  }

  // 구매패턴 집계
  let single = 0, singleSales = 0, multi = 0, multiSales = 0, mainOrders = 0, coverAttach = 0, coverOnly = 0;
  for (const od of Object.values(orders)) {
    if (od.products.size >= 2) { multi++; multiSales += od.sales; } else { single++; singleSales += od.sales; }
    const hasCover = od.groups.has('커버'); const hasMain = MAIN.some((g) => od.groups.has(g));
    if (hasMain) { mainOrders++; if (hasCover) coverAttach++; }
    if (hasCover && [...od.groups].every((g) => g === '커버')) coverOnly++;
  }

  const arr = (obj, k = 'qty') => Object.values(obj).sort((a, b) => b[k] - a[k]);
  const round = (o) => ({ ...o, sales: Math.round(o.sales) });
  const tiersOut = (tmap) => Object.fromEntries(TIERS.map((t) => [t, { sales: Math.round(tmap[t].sales), qty: tmap[t].qty }]));
  const order = ['공동구매', '소파', '바디필로우', '메이트', '서포트/롤', '커버', '리필/비즈', '기타'];
  const oc = orderIds.size;

  return {
    channel: 'smartstore', start: start || null, end: end || null,
    kpis: {
      orders: oc, lines: linesCnt, qty,
      revenue: Math.round(revenue), settlement: Math.round(settlement), commission: Math.round(commission), discount: Math.round(discount),
      aov: oc ? Math.round(revenue / oc) : 0, commissionRate: revenue ? commission / revenue : 0,
      sofaQty: catQty['소파'] || 0, bodyQty: catQty['바디필로우'] || 0, totalQty: qty,
      discountTypes: [
        { type: '즉시할인', amount: Math.round(immDisc) },
        { type: '상품쿠폰', amount: Math.round(prodCpnDisc) },
        { type: '스토어쿠폰', amount: Math.round(storeCpnDisc) },
        { type: '배송비할인', amount: Math.round(delivDisc) },
      ],
      couponOrders,
    },
    coupons: arr(couponAgg, 'discount').map((c) => ({ ...c, discount: Math.round(c.discount) })),
    salesBreakdown: {
      grand: Math.round(grand), grandQty, TIERS,
      tiers: TIERS.map((t) => ({ tier: t, sales: Math.round(tierTotals[t].sales), qty: tierTotals[t].qty, share: grand ? tierTotals[t].sales / grand : 0, qtyShare: grandQty ? tierTotals[t].qty / grandQty : 0 })),
      rows: Object.values(cats).map((c) => ({ cat: c.cat, total: Math.round(c.total), qty: c.qty, tiers: tiersOut(c.tiers), share: grand ? c.total / grand : 0 })).sort((a, b) => order.indexOf(a.cat) - order.indexOf(b.cat)),
      byLine: Object.values(lines).map((L) => ({ line: L.line, total: Math.round(L.total), qty: L.qty, tiers: tiersOut(L.tiers) })).sort((a, b) => b.total - a.total),
    },
    patterns: {
      total: oc, totalSales: Math.round(revenue),
      composition: { single: { orders: single, sales: Math.round(singleSales), ratio: oc ? single / oc : 0 }, multi: { orders: multi, sales: Math.round(multiSales), ratio: oc ? multi / oc : 0 } },
      coverAttach: { mainOrders, attachOrders: coverAttach, attachRate: mainOrders ? coverAttach / mainOrders : 0, coverOnlyOrders: coverOnly },
    },
    categoryDist: arr(catD).map((c) => round({ ...c, share: qty ? c.qty / qty : 0 })),
    fillerDist: arr(fillerD).map((c) => round({ ...c, share: qty ? c.qty / qty : 0 })),
    productTop: arr(prodD).slice(0, 30).map((p) => round({ ...p, share: qty ? p.qty / qty : 0 })),
    colorTop: arr(colorD).slice(0, 25).map(round),
    discountEvents: arr(deD, 'sales').map((d) => ({
      name: d.name, tier: d.tier, orders: d._orders.size, qty: d.qty,
      sales: Math.round(d.sales), immediate: Math.round(d.immediate), total: Math.round(d.total),
      discountRate: (d.sales + d.total) ? d.total / (d.sales + d.total) : 0,
    })).slice(0, 50),
    inflow: arr(inflowD, 'sales').slice(0, 15).map(round),
    weekday: Array.from({ length: 7 }, (_, i) => wd[i] ? round(wd[i]) : { dow: i, label: WD[i], orders: 0, sales: 0 }),
  };
}

// 범용 드릴다운 — 카드/행 클릭 시 그 조건에 해당하는 주문·상품 상세 (smartstore_orders)
//  kind: pattern(single|multi|coverAttach|coverOnly|mainOrders) / category / tier / product / color
//        / inflow / weekday(0~6) / coupon / means / device / discountEvent
async function detailOrders(start, end, kind, value, { limit = 300 } = {}) {
  const coll = await store.collection(COLL);
  const q = { canceled: { $ne: true } };
  if (start || end) { q.order_date = {}; if (start) q.order_date.$gte = start; if (end) q.order_date.$lte = end; }
  const cursor = coll.find(q);

  const orders = new Map(); // order_id → 주문 단위 묶음
  for await (const o of cursor) {
    if (!PAID.has(o.status)) continue;
    const cat = categoryOf({}, o.product_id, o.product_name);
    const tier = detectTier(o.product_name, cat);
    const nm = cleanName(o.product_name) || o.product_name;
    const dt = new Date(o.order_date + 'T00:00:00'); const dow = isNaN(dt) ? -1 : dt.getDay();
    let od = orders.get(o.order_id);
    if (!od) {
      od = {
        order_id: o.order_id, order_date: o.order_date, dow, lines: [], groups: new Set(), productKeys: new Set(), sales: 0,
        means: o.payment_means || '(미상)', device: o.pay_location || '(미상)', inflow: o.inflow_path || '(미상)',
        coupons: Array.isArray(o.applied_coupons) ? o.applied_coupons.map((cp) => cp.couponName || cp.name || cp.couponClassName || couponLabel(cp.couponClassCode) || cp.couponId || '쿠폰') : [],
      };
      orders.set(o.order_id, od);
    }
    od.lines.push({ name: nm, cat, tier, qty: N(o.quantity), sales: N(o.payment_amount), color: parseColor(o.option_value), immediate: N(o.discount_immediate) });
    if (cat) od.groups.add(cat);
    od.productKeys.add(o.product_id || nm);
    od.sales += N(o.payment_amount);
  }

  const lineKinds = new Set(['category', 'tier', 'product', 'color', 'discountEvent']);
  const isLineKind = lineKinds.has(kind);
  const lineMatch = (ln) => {
    switch (kind) {
      case 'category': return ln.cat === value;
      case 'tier': return ln.tier === value;
      case 'product': return ln.name === value;
      case 'color': return ln.color === value;
      case 'discountEvent': return ln.name === value && ln.immediate > 0;
      default: return true;
    }
  };
  const orderMatch = (od) => {
    switch (kind) {
      case 'pattern':
        if (value === 'single') return od.productKeys.size < 2;
        if (value === 'multi') return od.productKeys.size >= 2;
        if (value === 'coverAttach') return MAIN.some((g) => od.groups.has(g)) && od.groups.has('커버');
        if (value === 'coverOnly') return od.groups.has('커버') && [...od.groups].every((g) => g === '커버');
        if (value === 'mainOrders') return MAIN.some((g) => od.groups.has(g));
        return true;
      case 'means': return od.means === value;
      case 'device': return od.device === value;
      case 'inflow': return od.inflow === value;
      case 'coupon': return od.coupons.includes(value);
      case 'weekday': return od.dow === Number(value);
      default: return true;
    }
  };

  const matched = []; const prodAgg = {}; let totalSales = 0, totalQty = 0;
  for (const od of orders.values()) {
    let ok, lines;
    if (isLineKind) { lines = od.lines.filter(lineMatch); ok = lines.length > 0; }
    else { ok = orderMatch(od); lines = od.lines; }
    if (!ok) continue;
    const oSales = isLineKind ? lines.reduce((a, l) => a + l.sales, 0) : od.sales;
    const oQty = lines.reduce((a, l) => a + l.qty, 0);
    totalSales += oSales; totalQty += oQty;
    matched.push({
      order_id: od.order_id, order_date: od.order_date, sales: Math.round(oSales),
      products: lines.map((l) => `${l.name}${l.qty > 1 ? '×' + l.qty : ''}`).slice(0, 8),
      means: od.means, device: od.device, inflow: od.inflow, coupons: od.coupons,
    });
    for (const l of lines) {
      const p = (prodAgg[l.name] = prodAgg[l.name] || { name: l.name, tier: l.tier, qty: 0, sales: 0, orders: 0 });
      p.qty += l.qty; p.sales += l.sales; p.orders++;
    }
  }
  matched.sort((a, b) => b.sales - a.sales);
  const products = Object.values(prodAgg).map((p) => ({ ...p, sales: Math.round(p.sales) })).sort((a, b) => b.sales - a.sales).slice(0, 50);
  return {
    kind, value, start: start || null, end: end || null,
    orderCount: matched.length, totalSales: Math.round(totalSales), totalQty,
    orders: matched.slice(0, limit), products,
  };
}

// 비즈(리필) 유도 대상 — 본품 구매 후 N개월 경과·리필 미구매 (주문자ID 기준)
//  네이버는 연락처/이름을 마스킹 제공 → 발송은 스토어 마케팅메시지/알림톡(센터)으로. orderer_id 미적재 시 재수집 필요.
async function bizPromote(months = 3, { limit = 3000 } = {}) {
  const coll = await store.collection(COLL);
  const cursor = coll.find({ canceled: { $ne: true } }, { projection: { orderer_id: 1, orderer_name: 1, orderer_tel: 1, order_date: 1, product_name: 1, product_id: 1, status: 1 } });
  const profiles = new Map();
  let noOrderer = 0, totalDocs = 0;
  for await (const o of cursor) {
    if (!PAID.has(o.status)) continue;
    totalDocs++;
    // 주문자 식별키: 연락처(전체 제공) 우선, 없으면 주문자ID(마스킹) — 둘 다 없으면 미적재(재수집 필요)
    const tel = (o.orderer_tel && String(o.orderer_tel).trim()) || '';
    const oid = (o.orderer_id && String(o.orderer_id).trim()) || '';
    const key = tel || oid;
    if (!key) { noOrderer++; continue; }
    const cat = categoryOf({}, o.product_id, o.product_name);
    let p = profiles.get(key);
    if (!p) { p = { key, orderer_id: oid, name: o.orderer_name || '', tel, mainDate: null, mainProducts: new Set(), hasBiz: false }; profiles.set(key, p); }
    if (!p.name && o.orderer_name) p.name = o.orderer_name;
    if (!p.tel && tel) p.tel = tel;
    if (BIZ_CATS.has(cat)) { if (!p.mainDate || o.order_date > p.mainDate) p.mainDate = o.order_date; p.mainProducts.add(cleanName(o.product_name) || o.product_name); }
    if (cat === '리필/비즈') p.hasBiz = true;
  }
  const monthsBetween = (fromIso) => { const f = new Date(fromIso); if (isNaN(f)) return null; const t = new Date(); return (t.getFullYear() - f.getFullYear()) * 12 + (t.getMonth() - f.getMonth()) - (t.getDate() < f.getDate() ? 1 : 0); };
  let rows = [];
  for (const p of profiles.values()) {
    if (!p.mainDate || p.hasBiz) continue;
    const m = monthsBetween(p.mainDate);
    if (m == null || m < months) continue;
    rows.push({ orderer_id: p.orderer_id, name: p.name, tel: p.tel, mainDate: p.mainDate, monthsSince: m, products: [...p.mainProducts].slice(0, 10) });
  }
  rows.sort((a, b) => b.monthsSince - a.monthsSince);
  return { months, count: rows.length, noOrderer, totalDocs, ordererCoverage: totalDocs ? (totalDocs - noOrderer) / totalDocs : 0, rows: rows.slice(0, limit) };
}

// 충전재/라인 셀 클릭 → 판매 제품 상세 (smartstore_orders)
async function lineTierProducts(start, end, line, tier) {
  const coll = await store.collection(COLL);
  const q = { canceled: { $ne: true } };
  if (start || end) { q.order_date = {}; if (start) q.order_date.$gte = start; if (end) q.order_date.$lte = end; }
  const cursor = coll.find(q);
  const prods = {};
  for await (const o of cursor) {
    if (!PAID.has(o.status)) continue;
    const cat = categoryOf({}, o.product_id, o.product_name);
    if (line && detectLine(o.product_name) !== line) continue;
    if (tier && detectTier(o.product_name, cat) !== tier) continue;
    const key = o.product_name || o.product_id;
    const p = (prods[key] = prods[key] || { product_name: key, qty: 0, sales: 0, orders: new Set() });
    p.qty += N(o.quantity); p.sales += N(o.payment_amount); p.orders.add(o.order_id);
  }
  const rows = Object.values(prods).map((p) => ({ product_name: p.product_name, qty: p.qty, sales: Math.round(p.sales), orders: p.orders.size })).sort((a, b) => b.sales - a.sales);
  return { line, tier, start: start || null, end: end || null, count: rows.length, rows };
}

// 결제·혜택 분석 (네이버) — 결제수단 / PC·모바일 / 네이버 마일리지(=적립금 대응) / 멤버십
//   주문(order_id) 단위 결제정보는 상품주문마다 중복저장 → order_id로 중복제거
async function paymentAnalysis(start, end) {
  const coll = await store.collection(COLL);
  const q = { canceled: { $ne: true } };
  if (start || end) { q.order_date = {}; if (start) q.order_date.$gte = start; if (end) q.order_date.$lte = end; }
  const cursor = coll.find(q, { projection: { order_id: 1, status: 1, payment_amount: 1, payment_means: 1, pay_location: 1, naver_mileage: 1, charge_amount: 1, pay_later: 1, is_membership: 1 } });

  const om = {};
  for await (const o of cursor) {
    if (!PAID.has(o.status)) continue;
    const g = (om[o.order_id] = om[o.order_id] || { means: o.payment_means || '(미상)', device: o.pay_location || '(미상)', mileage: N(o.naver_mileage), charge: N(o.charge_amount), payLater: N(o.pay_later), membership: !!o.is_membership, sales: 0 });
    g.sales += N(o.payment_amount);
  }
  const orders = Object.values(om);
  const total = orders.length;
  const totalSales = orders.reduce((a, o) => a + o.sales, 0);
  const byKey = (key, label) => {
    const m = {};
    for (const o of orders) { const k = o[key] || '(미상)'; (m[k] = m[k] || { [label]: k, orders: 0, sales: 0 }); m[k].orders++; m[k].sales += o.sales; }
    return Object.values(m).map((x) => ({ ...x, sales: Math.round(x.sales), share: total ? x.orders / total : 0 })).sort((a, b) => b.sales - a.sales);
  };
  const mileageOrders = orders.filter((o) => o.mileage > 0);
  const mileageSum = mileageOrders.reduce((a, o) => a + o.mileage, 0);
  const memberOrders = orders.filter((o) => o.membership).length;
  const chargeSum = orders.reduce((a, o) => a + o.charge, 0);
  const payLaterOrders = orders.filter((o) => o.payLater > 0).length;

  return {
    start: start || null, end: end || null, total, totalSales: Math.round(totalSales),
    byMeans: byKey('means', 'means'),
    byDevice: byKey('device', 'device'),
    mileage: { orders: mileageOrders.length, sum: Math.round(mileageSum), ratio: total ? mileageOrders.length / total : 0 },
    membership: { orders: memberOrders, ratio: total ? memberOrders / total : 0 },
    charge: { sum: Math.round(chargeSum) }, payLater: { orders: payLaterOrders },
  };
}

module.exports = { analyze, lineTierProducts, paymentAnalysis, detailOrders, bizPromote, parseColor };
