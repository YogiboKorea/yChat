'use strict';

/**
 * 고객 개인정보(PII) 조회 — /customersprivacy?member_id (프로빙 확인).
 * 세그먼트 결과 회원만 골라 조회 → 개인정보 최소 수집. onlinedata.customers 에 캐시.
 * created_date(가입일) 기반 가입기간(tenure) 판정에 사용.
 */

const c = require('./cafe24');
const store = require('./store');

const COLL = 'customers';
const TTL_MS = 7 * 24 * 3600 * 1000; // 7일 캐시(연락처/가입일은 거의 불변)
const PII_VER = 2; // PII 필드 스키마 버전(2=마케팅 수신 sms/news_mail 추가) — 불일치 캐시는 미스 처리로 자동 재호출

const PII_FIELDS = ['member_id', 'name', 'cellphone', 'phone', 'email', 'created_date',
  'last_login_date', 'group_no', 'gender', 'birthday', 'member_authentication', 'join_path', 'member_type',
  'sms', 'news_mail', 'thirdparty_agree']; // sms=SMS수신, news_mail=이메일수신, thirdparty_agree=제3자제공

function pick(o) {
  const r = {};
  for (const k of PII_FIELDS) if (k in o) r[k] = o[k];
  return r;
}

async function fetchOne(memberId) {
  const j = await c.adminGet('/customersprivacy', { shop_no: 1, member_id: memberId, limit: 1 });
  const row = (j.customersprivacy || [])[0];
  return row ? pick(row) : null;
}

// 간단 동시성 풀
async function mapPool(items, worker, concurrency = 6) {
  const out = new Array(items.length); let i = 0;
  async function run() { while (i < items.length) { const k = i++; try { out[k] = await worker(items[k]); } catch (_) { out[k] = null; } } }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, run));
  return out;
}

// 여러 회원 PII 일괄 조회 (캐시 우선 → 미스만 라이브)
async function getMany(memberIds) {
  const ids = [...new Set(memberIds.filter(Boolean))];
  const result = {};
  let coll = null;
  if (store.configured()) { try { coll = await store.collection(COLL); } catch (_) {} }

  const misses = [];
  if (coll) {
    const fresh = Date.now() - TTL_MS;
    const docs = await coll.find({ member_id: { $in: ids } }).toArray();
    const byId = Object.fromEntries(docs.map((d) => [d.member_id, d]));
    for (const id of ids) {
      const d = byId[id];
      if (d && d._piiVer === PII_VER && d._fetchedAt && new Date(d._fetchedAt).getTime() > fresh) result[id] = d;
      else misses.push(id); // 캐시 없음 / TTL 만료 / 스키마 구버전 → 재호출
    }
  } else {
    misses.push(...ids);
  }

  if (misses.length) {
    const fetched = await mapPool(misses, fetchOne, 6);
    const ops = [];
    misses.forEach((id, idx) => {
      const row = fetched[idx];
      if (row) {
        row._fetchedAt = new Date().toISOString();
        row._piiVer = PII_VER;
        result[id] = row;
        if (coll) ops.push({ updateOne: { filter: { member_id: id }, update: { $set: row }, upsert: true } });
      }
    });
    if (coll && ops.length) { try { await coll.bulkWrite(ops, { ordered: false }); } catch (_) {} }
  }

  return result; // member_id → PII
}

module.exports = { getMany, fetchOne, PII_FIELDS };
