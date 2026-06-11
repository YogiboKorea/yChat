'use strict';

/**
 * 세그먼트 엔진 — orders_raw(누적 주문) + catalog(상품그룹) + customers(PII) 기반.
 * API 재호출 없이 DB에서 고객 프로필을 만들고 조건으로 추출.
 *
 *  · 고객 프로필: member_id → 구매상품/그룹, 첫·마지막 주문, 주문수, 총구매액
 *  · 세그먼트 예: "커버만 구매", "커버 구매 + 가입 N개월+"
 *  · 결과에 PII(이름/연락처/이메일/가입일) 부착 + CSV용 평면 행
 */

const store = require('./store');
const catalog = require('./catalog');
const customers = require('./customers');
const { ignoreNameRegex } = require('../config/groups');

const ORDERS = 'orders_raw';
const N = (v) => (Number.isFinite(+v) ? +v : 0);

function monthsBetween(fromIso, to = new Date()) {
  const f = new Date(fromIso); if (isNaN(f)) return null;
  return (to.getFullYear() - f.getFullYear()) * 12 + (to.getMonth() - f.getMonth()) - (to.getDate() < f.getDate() ? 1 : 0);
}

// orders_raw → 회원별 프로필 (회원만; 비회원 제외)
async function buildProfiles({ start, end } = {}) {
  const coll = await store.collection(ORDERS);
  const q = { is_member: true, paid: true, canceled: false };
  if (start || end) { q.order_date = {}; if (start) q.order_date.$gte = start; if (end) q.order_date.$lte = end; }

  const { sets, productGroups, names } = await catalog.resolveGroupSets();

  const profiles = new Map(); // member_id → profile
  const cursor = coll.find(q, { projection: { member_id: 1, order_id: 1, order_date: 1, payment_amount: 1, first_order: 1, items: 1 } });

  for await (const o of cursor) {
    const mid = o.member_id;
    let p = profiles.get(mid);
    if (!p) { p = { member_id: mid, orders: 0, spend: 0, firstDate: o.order_date, lastDate: o.order_date, productNos: new Set(), groups: new Set(), hadFirstOrder: false }; profiles.set(mid, p); }
    p.orders += 1;
    p.spend += N(o.payment_amount);
    if (o.order_date < p.firstDate) p.firstDate = o.order_date;
    if (o.order_date > p.lastDate) p.lastDate = o.order_date;
    if (o.first_order) p.hadFirstOrder = true;
    for (const it of (o.items || [])) {
      if (ignoreNameRegex && ignoreNameRegex.test(it.product_name || '')) continue;
      const no = String(it.product_no || '');
      if (!no) continue;
      p.productNos.add(no);
      for (const g of (productGroups[no] || [])) p.groups.add(g);
    }
  }
  return { profiles, sets, productGroups, names };
}

// 특정 그룹을 "구매" 또는 "그 그룹만 구매" 한 회원 추출
//  mode: 'bought' | 'only'
async function segmentByGroup(group, { mode = 'bought', tenureMonths = 0, start, end, withPII = true, limit = 2000 } = {}) {
  const { profiles, sets, productGroups, names } = await buildProfiles({ start, end });
  const groupSet = sets[group];
  if (!groupSet) throw new Error(`알 수 없는 상품그룹: ${group} (config/groups.js 확인)`);

  const matched = [];
  for (const p of profiles.values()) {
    const boughtGroup = p.groups.has(group);
    if (!boughtGroup) continue;
    if (mode === 'only') {
      // 모든 구매 상품이 group 에 속해야 함(분류 안 된 상품이 있으면 제외)
      let onlyThis = true;
      for (const no of p.productNos) { if (!groupSet.has(no)) { onlyThis = false; break; } }
      if (!onlyThis) continue;
    }
    matched.push(p);
  }

  // PII 부착 + 가입기간 필터
  let rows = matched.map((p) => ({
    member_id: p.member_id,
    orders: p.orders,
    spend: Math.round(p.spend),
    firstDate: p.firstDate,
    lastDate: p.lastDate,
    groups: [...p.groups],
    products: [...p.productNos].map((no) => names[no] || no).slice(0, 20),
  }));

  let piiMap = {};
  if (withPII) piiMap = await customers.getMany(rows.map((r) => r.member_id));

  rows = rows.map((r) => {
    const pii = piiMap[r.member_id] || {};
    const tenure = pii.created_date ? monthsBetween(pii.created_date) : null;
    return {
      ...r,
      name: pii.name || '', cellphone: pii.cellphone || pii.phone || '', email: pii.email || '',
      created_date: pii.created_date ? String(pii.created_date).slice(0, 10) : '',
      tenureMonths: tenure, group_no: pii.group_no != null ? pii.group_no : '',
    };
  });

  if (tenureMonths > 0) rows = rows.filter((r) => r.tenureMonths != null && r.tenureMonths >= tenureMonths);

  rows.sort((a, b) => b.spend - a.spend);
  const total = rows.length;
  return {
    group, mode, tenureMonths, start: start || null, end: end || null,
    groupProductCount: groupSet.size,
    count: total,
    rows: rows.slice(0, limit),
  };
}

const BIZ_CACHE = 'bizpromote_cache';

// 주문 데이터 변경 감지 지문 — 마지막 동기화 시각 + 문서 수. 변동 없으면 캐시 결과를 그대로 사용.
async function ordersFingerprint() {
  let syncedAt = '', count = 0;
  try { const m = await (await store.collection('sync_meta')).findOne({ _id: 'orders_meta' }); syncedAt = (m && m.syncedAt) || ''; } catch (_) {}
  try { count = await (await store.collection(ORDERS)).estimatedDocumentCount(); } catch (_) {}
  return `${syncedAt}|${count}`;
}

// 비즈 구매 유도 대상 — 본품(빈백) 구매 후 N개월 경과했는데 비즈(리필) 미구매 회원
//  결과를 bizpromote_cache 에 저장 → 클릭하면 무조건 DB에 저장된 이전 결과를 먼저 반환(캐시 우선).
//  새 주문이 들어와 지문이 달라졌으면 stale=true 로 표시만 하고, 실제 재계산은 force(↻ 최신 재계산)일 때만.
async function bizPromote(months = 3, { withPII = true, limit = 3000, force = false } = {}) {
  const fp = await ordersFingerprint();
  let cacheColl = null;
  try { cacheColl = await store.collection(BIZ_CACHE); } catch (_) {}
  if (!force && withPII && cacheColl) {
    const hit = await cacheColl.findOne({ _id: `m${months}` });
    if (hit) {
      // 지문이 달라도(새 주문 존재) 일단 저장된 데이터를 우선 반환 — stale 플래그로 갱신 가능 여부만 안내
      return {
        months,
        count: hit.count,
        rows: (hit.rows || []).slice(0, limit),
        cached: true,
        stale: hit.fingerprint !== fp,
        builtAt: hit.builtAt,
      };
    }
  }

  const { productGroups, names } = await catalog.resolveGroupSets();
  const coll = await store.collection(ORDERS);
  const MAIN = ['소파', '바디필로우', '메이트'];
  const profiles = new Map();
  const cursor = coll.find({ is_member: true, paid: true, canceled: false }, { projection: { member_id: 1, order_date: 1, items: 1 } });
  for await (const o of cursor) {
    const mid = o.member_id; if (!mid) continue;
    let p = profiles.get(mid);
    if (!p) { p = { member_id: mid, mainDate: null, mainProducts: new Set(), hasBiz: false, bizDate: null }; profiles.set(mid, p); }
    for (const it of (o.items || [])) {
      const gs = productGroups[String(it.product_no || '')] || [];
      if (gs.some((g) => MAIN.includes(g))) { if (!p.mainDate || o.order_date > p.mainDate) p.mainDate = o.order_date; p.mainProducts.add(it.product_name); }
      if (gs.includes('리필/비즈')) { p.hasBiz = true; if (!p.bizDate || o.order_date > p.bizDate) p.bizDate = o.order_date; }
    }
  }
  let rows = [];
  for (const p of profiles.values()) {
    if (!p.mainDate || p.hasBiz) continue;             // 본품 미구매 or 비즈 이미 구매 → 제외
    const m = monthsBetween(p.mainDate);
    if (m == null || m < months) continue;             // N개월 미경과 → 제외
    rows.push({ member_id: p.member_id, mainDate: p.mainDate, monthsSince: m, products: [...p.mainProducts].slice(0, 10) });
  }
  if (withPII) {
    const pii = await customers.getMany(rows.map((r) => r.member_id));
    rows = rows.map((r) => {
      const x = pii[r.member_id] || {};
      const tenure = x.created_date ? monthsBetween(x.created_date) : null;
      const sms = x.sms === 'T', mail = x.news_mail === 'T';
      return {
        ...r, name: x.name || '', cellphone: x.cellphone || x.phone || '', email: x.email || '',
        created_date: x.created_date ? String(x.created_date).slice(0, 10) : '', tenureMonths: tenure, group_no: x.group_no != null ? x.group_no : '',
        smsAgree: sms, mailAgree: mail, marketing: (sms || mail) ? '동의' : '거부',
      };
    });
  }
  rows.sort((a, b) => b.monthsSince - a.monthsSince);
  const out = { months, count: rows.length, rows: rows.slice(0, limit) };
  const builtAt = new Date().toISOString();
  // 결과 캐시 저장 (PII 포함 정상 계산일 때만)
  if (withPII && cacheColl) {
    try { await cacheColl.updateOne({ _id: `m${months}` }, { $set: { ...out, fingerprint: fp, builtAt } }, { upsert: true }); } catch (_) {}
  }
  return { ...out, cached: false, stale: false, builtAt };
}

async function listGroups() {
  const { counts } = await catalog.resolveGroupSets();
  return counts; // { group: productCount }
}

module.exports = { buildProfiles, segmentByGroup, bizPromote, listGroups, monthsBetween };
