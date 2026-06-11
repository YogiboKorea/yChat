'use strict';

/**
 * 주문 적재(ingest) — 최근 N개월 주문을 onlinedata DB의 orders_raw 에 누적.
 * Cafe24 /orders 는 긴 기간을 한 번에 못 받으므로 30일 청크로 끊어 수집.
 * items 포함(상품별 세그먼트용). 정규화해 용량 최소화.
 */

const c = require('./cafe24');
const store = require('./store');

const COLL = 'orders_raw';
const META = 'sync_meta';
const N = (v) => (Number.isFinite(+v) ? +v : 0);
const day = (s) => String(s || '').slice(0, 10);

function pad(n) { return String(n).padStart(2, '0'); }
function fmt(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

// [start,end] 를 chunkDays 이하 구간들로 분할
function chunkRanges(startDate, endDate, chunkDays = 30) {
  const out = []; const oneDay = 86400000;
  let cur = new Date(startDate);
  const last = new Date(endDate);
  while (cur <= last) {
    const from = new Date(cur);
    const to = new Date(Math.min(last.getTime(), from.getTime() + (chunkDays - 1) * oneDay));
    out.push([fmt(from), fmt(to)]);
    cur = new Date(to.getTime() + oneDay);
  }
  return out;
}

function normalize(o) {
  const items = (o.items || []).map((it) => ({
    product_no: it.product_no != null ? String(it.product_no) : (it.product_code || ''),
    product_name: it.product_name || it.product_name_default || '',
    quantity: N(it.quantity),
    product_price: N(it.product_price),
    payment_amount: N(it.payment_amount),
    coupon_discount: N(it.coupon_discount_price),
    direct_discount: N(it.additional_discount_price), // 기간할인(상품 직접 할인)
    option_value: it.option_value || '',               // "색상=Eng / 한글"
    is_bundle: it.product_bundle === 'T',              // 세트(번들) 상품
    bundle_name: it.product_bundle_name || '',
  }));
  return {
    order_id: o.order_id,
    member_id: (o.member_id && String(o.member_id).trim()) || '',
    is_member: !!(o.member_id && String(o.member_id).trim()),
    order_date: day(o.order_date),
    paid: o.paid === 'T',
    canceled: o.canceled === 'T',
    first_order: o.first_order === 'T',
    payment_amount: N(o.payment_amount),
    coupon_discount: N(o.actual_order_amount && o.actual_order_amount.coupon_discount_price),
    points_used: N(o.actual_order_amount && o.actual_order_amount.points_spent_amount) + N(o.actual_order_amount && o.actual_order_amount.credits_spent_amount),
    items,
    syncedAt: new Date().toISOString(),
  };
}

async function ensureIndexes() {
  const coll = await store.collection(COLL);
  try { await coll.createIndex({ order_id: 1 }, { unique: true }); } catch (_) {}
  try { await coll.createIndex({ member_id: 1 }); } catch (_) {}
  try { await coll.createIndex({ order_date: 1 }); } catch (_) {}
}

// 임의 [start,end] 구간 주문 동기화 (30일 청크, items 포함, upsert)
async function _syncWindow(startFmt, endFmt, metaExtra, onProgress) {
  await ensureIndexes();
  const coll = await store.collection(COLL);
  const ranges = chunkRanges(startFmt, endFmt, 30);

  let total = 0, chunkIdx = 0;
  for (const [s, e] of ranges) {
    chunkIdx++;
    const orders = await c.adminPaginate('/orders',
      { shop_no: 1, start_date: s, end_date: e, date_type: 'order_date', embed: 'items' },
      'orders', { limit: 500, maxPages: 400 });
    if (orders.length) {
      const ops = orders.map((o) => {
        const doc = normalize(o);
        return { updateOne: { filter: { order_id: doc.order_id }, update: { $set: doc }, upsert: true } };
      });
      await coll.bulkWrite(ops, { ordered: false });
      total += orders.length;
    }
    if (onProgress) onProgress({ chunk: chunkIdx, chunks: ranges.length, range: [s, e], orders: orders.length, total });
  }

  const meta = { _id: 'orders_meta', from: startFmt, to: endFmt, count: total, syncedAt: new Date().toISOString(), ...metaExtra };
  try { const m = await store.collection(META); await m.updateOne({ _id: 'orders_meta' }, { $set: meta }, { upsert: true }); } catch (_) {}
  return meta;
}

// 최근 N개월 주문 동기화 (기본 12개월)
async function syncOrders(months = 12, { onProgress } = {}) {
  const end = new Date();
  const start = new Date(); start.setMonth(start.getMonth() - months);
  return _syncWindow(fmt(start), fmt(end), { months }, onProgress);
}

// 이번 달(또는 지정 월) 주문 동기화 — 'YYYY-MM' 또는 미지정 시 현재 달
async function syncMonth(ym, { onProgress } = {}) {
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth();
  if (ym && /^\d{4}-\d{2}$/.test(ym)) { y = +ym.slice(0, 4); m = +ym.slice(5, 7) - 1; }
  const start = new Date(y, m, 1);
  const lastDay = new Date(y, m + 1, 0);
  const end = lastDay > now ? now : lastDay; // 미래 날짜는 오늘까지만
  return _syncWindow(fmt(start), fmt(end), { month: `${y}-${pad(m + 1)}` }, onProgress);
}

// 임의 구간
async function syncRange(start, end, { onProgress } = {}) {
  return _syncWindow(start, end, { range: [start, end] }, onProgress);
}

async function syncStatus() {
  try {
    const m = await store.collection(META);
    const meta = await m.findOne({ _id: 'orders_meta' });
    const coll = await store.collection(COLL);
    const count = await coll.countDocuments({});
    return { meta, count };
  } catch (e) { return { meta: null, count: 0, error: String(e.message) }; }
}

module.exports = { syncOrders, syncMonth, syncRange, syncStatus, COLL };
