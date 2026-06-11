'use strict';

/**
 * 스마트스토어 주문 수집 — onlinedata DB의 smartstore_orders 에 저장.
 *
 * 네이버 커머스 주문 조회 플로우:
 *   1) 변경상품주문 조회  GET /external/v1/pay-order/seller/product-orders/last-changed-statuses
 *        ?lastChangedFrom & lastChangedTo (ISO8601 +09:00, 최대 24시간) → productOrderId 목록
 *   2) 상품주문 상세 조회  POST /external/v1/pay-order/seller/product-orders/query
 *        { productOrderIds: [...최대 300] } → 주문 상세
 *
 * 응답 필드명은 첫 실데이터로 최종 확정(아래 normalize 는 방어적으로 여러 후보 키 처리).
 */

const ss = require('./smartstore');
const store = require('./store');

const COLL = 'smartstore_orders';
const META = 'sync_meta';
const N = (v) => (Number.isFinite(+v) ? +v : 0);

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
// KST ISO8601
function iso(d) { return `${fmtDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.000+09:00`; }

function chunk24h(start, end) {
  const out = []; const H = 3600 * 1000;
  let cur = new Date(start);
  const last = new Date(end);
  while (cur < last) {
    const from = new Date(cur);
    const to = new Date(Math.min(last.getTime(), from.getTime() + 24 * H - 1000));
    out.push([from, to]);
    cur = new Date(to.getTime() + 1000);
  }
  return out;
}

function pick(obj, keys, dflt) {
  for (const k of keys) {
    let v = obj;
    for (const part of k.split('.')) { v = v == null ? undefined : v[part]; }
    if (v != null && v !== '') return v;
  }
  return dflt;
}

// 확정된 네이버 커머스 productOrder 스키마 기준 정규화
function normalize(entry) {
  const po = entry.productOrder || entry.product_order || entry;
  const od = entry.order || {};
  const dateRaw = pick(od, ['paymentDate', 'orderDate'], pick(po, ['paymentDate', 'placeOrderDate'], ''));
  const status = pick(po, ['productOrderStatus'], '');
  return {
    channel: 'smartstore',
    product_order_id: String(pick(po, ['productOrderId'], pick(entry, ['productOrderId'], ''))),
    order_id: String(pick(od, ['orderId'], pick(po, ['orderId'], ''))),
    order_date: String(dateRaw).slice(0, 10),
    status,
    canceled: /CANCEL|RETURN/i.test(status),
    purchase_decided: status === 'PURCHASE_DECIDED',
    product_name: pick(po, ['productName'], ''),
    product_id: String(pick(po, ['productId', 'originProductNo'], '')),
    option_value: pick(po, ['productOption'], ''),
    quantity: N(pick(po, ['quantity'], 0)),
    payment_amount: N(pick(po, ['totalPaymentAmount'], 0)),
    product_amount: N(pick(po, ['totalProductAmount'], 0)),
    discount: N(pick(po, ['productDiscountAmount'], 0)) + N(pick(po, ['sellerBurdenStoreDiscountAmount'], 0)),
    // 할인 유형별 (네이버 쿠폰 마스터 API는 없으나 주문에 유형별 금액 제공)
    discount_immediate: N(pick(po, ['productImediateDiscountAmount', 'productImmediateDiscountAmount'], 0)), // 즉시할인
    discount_product_coupon: N(pick(po, ['productProductDiscountAmount'], 0)),                               // 상품쿠폰
    discount_store_coupon: N(pick(po, ['sellerBurdenStoreDiscountAmount'], 0)),                              // 스토어쿠폰
    delivery_discount: N(pick(po, ['deliveryDiscountAmount'], 0)),                                           // 배송비할인
    applied_coupons: Array.isArray(po.appliedCoupons) ? po.appliedCoupons : [],
    delivery_fee: N(pick(po, ['deliveryFeeAmount'], 0)),
    settlement: N(pick(po, ['expectedSettlementAmount'], 0)),
    commission: N(pick(po, ['paymentCommission'], 0)) + N(pick(po, ['saleCommission'], 0)) + N(pick(po, ['channelCommission'], 0)),
    inflow_path: pick(po, ['inflowPath'], ''),
    inflow_path_add: pick(po, ['inflowPathAdd'], ''),
    // 주문(order) 단위 결제정보 — 분석 시 order_id로 중복제거
    payment_means: pick(od, ['paymentMeans'], ''),           // 신용카드 간편결제 등
    pay_location: pick(od, ['payLocationType'], ''),         // MOBILE / PC
    naver_mileage: N(pick(od, ['naverMileagePaymentAmount'], 0)), // 네이버 마일리지(포인트) 사용 = 적립금 대응
    charge_amount: N(pick(od, ['chargeAmountPaymentAmount'], 0)), // 충전금 결제
    pay_later: N(pick(od, ['payLaterPaymentAmount'], 0)),    // 후불결제
    order_discount: N(pick(od, ['orderDiscountAmount'], 0)),
    is_membership: !!pick(od, ['isMembershipSubscribed'], false), // 네이버플러스 멤버십
    // 주문자 식별(재구매·비즈유도 분석용) — 네이버는 연락처/이름을 마스킹 제공할 수 있음
    orderer_id: String(pick(od, ['ordererId', 'ordererNo'], '')),
    orderer_name: pick(od, ['ordererName'], ''),
    orderer_tel: pick(od, ['ordererTel', 'ordererTelNo'], ''),
    syncedAt: new Date().toISOString(),
  };
}

async function ensureIndexes() {
  const coll = await store.collection(COLL);
  try { await coll.createIndex({ product_order_id: 1 }, { unique: true }); } catch (_) {}
  try { await coll.createIndex({ order_date: 1 }); } catch (_) {}
}

// 변경상품주문 ID 수집 (24h 창, moreSequence 페이지네이션)
async function collectChangedIds(fromD, toD, onProgress) {
  const ids = new Set();
  const windows = chunk24h(fromD, toD);
  let wi = 0;
  for (const [f, t] of windows) {
    wi++;
    let moreSequence = null, guard = 0;
    do {
      const params = { lastChangedFrom: iso(f), lastChangedTo: iso(t) };
      if (moreSequence) params.moreSequence = moreSequence;
      const j = await ss.apiGet('/external/v1/pay-order/seller/product-orders/last-changed-statuses', params);
      const data = j.data || j;
      const list = data.lastChangeStatuses || data.lastChangedStatuses || [];
      for (const x of list) { const id = x.productOrderId || x.productOrderID; if (id) ids.add(String(id)); }
      moreSequence = (data.more && (data.more.moreSequence)) || data.moreSequence || null;
      guard++;
    } while (moreSequence && guard < 50);
    if (onProgress) onProgress({ window: wi, windows: windows.length, range: [iso(f), iso(t)], ids: ids.size });
  }
  return [...ids];
}

// 상세 조회 (300개씩) → 정규화 → upsert
async function fetchAndStore(ids) {
  await ensureIndexes();
  const coll = await store.collection(COLL);
  let stored = 0;
  for (let i = 0; i < ids.length; i += 300) {
    const batch = ids.slice(i, i + 300);
    const j = await ss.apiPost('/external/v1/pay-order/seller/product-orders/query', { productOrderIds: batch });
    const data = j.data || j;
    const list = Array.isArray(data) ? data : (data.productOrders || []);
    if (list.length) {
      const ops = list.map((e) => { const d = normalize(e); return { updateOne: { filter: { product_order_id: d.product_order_id }, update: { $set: d }, upsert: true } }; });
      await coll.bulkWrite(ops, { ordered: false });
      stored += list.length;
    }
  }
  return stored;
}

async function syncRange(start, end, { onProgress } = {}) {
  const fromD = new Date(start + 'T00:00:00+09:00');
  const endD = new Date(end + 'T23:59:59+09:00');
  const now = new Date();
  const toD = endD > now ? now : endD;
  const ids = await collectChangedIds(fromD, toD, onProgress);
  const stored = await fetchAndStore(ids);
  const meta = { _id: 'smartstore_meta', from: start, to: fmtDate(toD), changed: ids.length, stored, syncedAt: new Date().toISOString() };
  try { const m = await store.collection(META); await m.updateOne({ _id: 'smartstore_meta' }, { $set: meta }, { upsert: true }); } catch (_) {}
  return meta;
}

async function syncMonth(ym, opts) {
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth();
  if (ym && /^\d{4}-\d{2}$/.test(ym)) { y = +ym.slice(0, 4); m = +ym.slice(5, 7) - 1; }
  const start = `${y}-${pad(m + 1)}-01`;
  const last = new Date(y, m + 1, 0);
  return syncRange(start, fmtDate(last), opts);
}

async function syncStatus() {
  try {
    const m = await store.collection(META);
    const meta = await m.findOne({ _id: 'smartstore_meta' });
    const coll = await store.collection(COLL);
    return { meta, count: await coll.countDocuments({}) };
  } catch (e) { return { meta: null, count: 0, error: String(e.message) }; }
}

module.exports = { syncRange, syncMonth, syncStatus, collectChangedIds, normalize, COLL };
