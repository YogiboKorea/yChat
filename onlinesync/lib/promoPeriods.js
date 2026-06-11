'use strict';

/**
 * 월별 전사 프로모션 기간 — MongoDB(onlinedata.promo_periods)에 저장, 화면에서 편집.
 * 정의된 기간 동안의 %할인 쿠폰 사용 주문 = 그 프로모션 성과.
 *   { month:'YYYY-MM', name, start:'YYYY-MM-DD', end:'YYYY-MM-DD' }
 */

const store = require('./store');
const COLL = 'promo_periods';

async function setPromo(month, name, start, end) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) throw new Error('month 형식 오류(YYYY-MM)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) throw new Error('기간(start/end) 형식 오류(YYYY-MM-DD)');
  const c = await store.collection(COLL);
  const doc = { month, name: name || `${month} 전사프로모션`, start, end, updatedAt: new Date().toISOString() };
  await c.updateOne({ month }, { $set: doc }, { upsert: true });
  return doc;
}

async function listPromos() {
  if (!store.configured()) return [];
  try { const c = await store.collection(COLL); return c.find({}).sort({ month: -1 }).limit(60).toArray(); } catch (_) { return []; }
}

async function getPromo(month) {
  if (!store.configured()) return null;
  try { const c = await store.collection(COLL); return c.findOne({ month }); } catch (_) { return null; }
}

async function deletePromo(month) {
  try { const c = await store.collection(COLL); await c.deleteOne({ month }); return true; } catch (_) { return false; }
}

module.exports = { setPromo, listPromos, getPromo, deletePromo };
