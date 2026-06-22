'use strict';

/**
 * 전사 프로모션 목표 — onlinedata.promo_targets.
 *   한 프로모션 = 한 문서: 채널별 목표매출(자사몰/스마트스토어/외부채널) + 트래픽 목표(자사몰 기준).
 *   { _id, name, start:'YYYY-MM-DD', end:'YYYY-MM-DD',
 *     channels:{자사몰,스마트스토어,외부채널}(원), trafficTargets:{visits,signups,purchaseRate,signupRate}, updatedAt }
 *   리포트 TARGET_CONFIG.promotions 가 이 데이터를 읽어 '전사 프로모션 목표 페이스'를 그린다.
 */

const store = require('./store');
let ObjectId; try { ({ ObjectId } = require('mongodb')); } catch (_) {}
const COLL = 'promo_targets';
const N = (v) => (Number.isFinite(+v) ? +v : 0);

function clean(b) {
  const ch = b.channels || {};
  const tt = b.trafficTargets || {};
  return {
    name: String(b.name || '').trim(),
    start: String(b.start || ''),
    end: String(b.end || ''),
    channels: { 자사몰: Math.round(N(ch.자사몰)), 스마트스토어: Math.round(N(ch.스마트스토어)), 외부채널: Math.round(N(ch.외부채널)) },
    trafficTargets: { visits: Math.round(N(tt.visits)), signups: Math.round(N(tt.signups) * 10) / 10, purchaseRate: N(tt.purchaseRate), signupRate: N(tt.signupRate) },
  };
}

async function setTarget(b) {
  const d = clean(b);
  if (!d.name) throw new Error('프로모션명을 입력하세요');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.start) || !/^\d{4}-\d{2}-\d{2}$/.test(d.end)) throw new Error('기간(시작/종료) 형식 오류(YYYY-MM-DD)');
  if (d.end < d.start) throw new Error('종료일이 시작일보다 빠릅니다');
  const c = await store.collection(COLL);
  d.updatedAt = new Date().toISOString();
  if (b.id && ObjectId) { await c.updateOne({ _id: new ObjectId(String(b.id)) }, { $set: d }); return { id: String(b.id), ...d }; }
  d.createdAt = d.updatedAt;
  const r = await c.insertOne(d);
  return { id: String(r.insertedId), ...d };
}

async function listTargets() {
  if (!store.configured()) return [];
  try {
    const c = await store.collection(COLL);
    const arr = await c.find({}).sort({ start: -1 }).limit(100).toArray();
    return arr.map((d) => ({ id: String(d._id), name: d.name, start: d.start, end: d.end, channels: d.channels || {}, trafficTargets: d.trafficTargets || {}, updatedAt: d.updatedAt }));
  } catch (_) { return []; }
}

async function deleteTarget(id) {
  try { const c = await store.collection(COLL); if (ObjectId) await c.deleteOne({ _id: new ObjectId(String(id)) }); return true; } catch (_) { return false; }
}

// 기존 등록된 프로모션(mall_promotions)을 (name+기간) 단위로 묶어 promo_targets 에 시드 — 목표는 0(입력 대기).
async function seedFromPromotions() {
  const mp = require('./mallPromotions');
  const existing = await listTargets();
  const have = new Set(existing.map((t) => `${t.name}|${t.start}|${t.end}`));
  let promos = [];
  try { promos = await mp.listPromotions(); } catch (_) {}
  const groups = new Map();
  for (const p of (promos || [])) { if (!p.start || !p.end || !p.name) continue; const k = `${p.name}|${p.start}|${p.end}`; if (!groups.has(k)) groups.set(k, { name: p.name, start: p.start, end: p.end }); }
  let added = 0;
  for (const [k, g] of groups) { if (have.has(k)) continue; await setTarget({ ...g, channels: {}, trafficTargets: {} }); added++; }
  return { added, total: groups.size };
}

module.exports = { setTarget, listTargets, deleteTarget, seedFromPromotions };
