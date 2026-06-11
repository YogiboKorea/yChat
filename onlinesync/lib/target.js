'use strict';

/**
 * 월 목표 매출 달성률 — 채널별(자사몰=orders_raw, 스마트스토어=smartstore_orders).
 * 목표값은 MongoDB(onlinedata.targets, 월별)에 저장하고 화면에서 편집.
 * DB에 해당 월이 없으면 config/targets.js 기본값 사용.
 */

const store = require('./store');
const cfg = require('../config/targets');

const TCOLL = 'targets';
const PAID_SS = ['PAYED', 'DELIVERING', 'DELIVERED', 'PURCHASE_DECIDED', 'EXCHANGED'];
const N = (v) => (Number.isFinite(+v) ? +v : 0);
function pad(n) { return String(n).padStart(2, '0'); }

async function getTargets(ym) {
  if (store.configured()) {
    try { const c = await store.collection(TCOLL); const doc = await c.findOne({ month: ym }); if (doc) return { cafe24: N(doc.cafe24), smartstore: N(doc.smartstore) }; } catch (_) {}
  }
  return cfg.monthly[ym] || cfg.default;
}

async function setTarget(ym, cafe24, smartstore) {
  if (!/^\d{4}-\d{2}$/.test(ym || '')) throw new Error('month 형식 오류(YYYY-MM)');
  const c = await store.collection(TCOLL);
  const doc = { month: ym, cafe24: N(cafe24), smartstore: N(smartstore), updatedAt: new Date().toISOString() };
  await c.updateOne({ month: ym }, { $set: doc }, { upsert: true });
  return doc;
}

async function listTargets() {
  if (!store.configured()) return [];
  try { const c = await store.collection(TCOLL); return c.find({}).sort({ month: -1 }).limit(60).toArray(); } catch (_) { return []; }
}

async function sumField(coll, match) {
  const c = await store.collection(coll);
  const r = await c.aggregate([{ $match: match }, { $group: { _id: null, sum: { $sum: '$payment_amount' }, orders: { $sum: 1 } } }]).toArray();
  return r[0] ? { sum: r[0].sum || 0, orders: r[0].orders || 0 } : { sum: 0, orders: 0 };
}

async function targetStatus(month) {
  const now = new Date();
  const ym = (month && /^\d{4}-\d{2}$/.test(month)) ? month : `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const y = +ym.slice(0, 4), m = +ym.slice(5, 7);
  const t = await getTargets(ym);

  const start = `${ym}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end = `${ym}-${pad(lastDay)}`;
  const isCurrent = (y === now.getFullYear() && m === now.getMonth() + 1);
  const elapsed = isCurrent ? now.getDate() : lastDay;
  const remaining = Math.max(0, lastDay - elapsed);

  const [ca, ss] = await Promise.all([
    sumField('orders_raw', { order_date: { $gte: start, $lte: end }, paid: true, canceled: false }),
    sumField('smartstore_orders', { order_date: { $gte: start, $lte: end }, canceled: { $ne: true }, status: { $in: PAID_SS } }),
  ]);

  const build = (target, actual) => {
    const rate = target ? actual / target : 0;
    const paceTarget = target * (elapsed / lastDay);
    const remain = Math.max(0, target - actual);
    return {
      target, actual: Math.round(actual), rate,
      vsPace: Math.round(actual - paceTarget),
      remain: Math.round(remain),
      needPerDay: remaining ? Math.round(remain / remaining) : 0,
      forecast: elapsed ? Math.round(actual / elapsed * lastDay) : 0,
    };
  };

  return {
    month: ym, totalDays: lastDay, elapsedDays: elapsed, remainingDays: remaining,
    targetSource: 'db-or-config',
    cafe24: build(t.cafe24, ca.sum),
    smartstore: build(t.smartstore, ss.sum),
  };
}

module.exports = { targetStatus, getTargets, setTarget, listTargets };
