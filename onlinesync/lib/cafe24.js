'use strict';

/**
 * Cafe24 통합 클라이언트 — 두 API 군을 하나의 읽기전용 토큰으로 호출.
 *
 *  1) Admin API   : https://{mall}.cafe24api.com/api/v2/admin/...   (주문/상품/쿠폰)
 *  2) Analytics API: https://ca-api.cafe24data.com/...              (유입/방문/UTM)
 *
 * 토큰 정책 (mkboard 와 동일):
 *   - yogiChat 이 Cafe24 OAuth 토큰의 "단일 소유자". 공유 MongoDB(tokens 컬렉션)에 저장하고 자동 갱신.
 *   - 여기서는 토큰을 "읽기 전용"으로만 사용. 직접 refresh 하지 않는다(1회용 refresh_token 회전 충돌 방지).
 *   - 401 시: DB 최신 토큰을 한 번 다시 읽어 재시도(yogiChat 이 이미 회전시켰을 수 있음). 그래도 실패하면 에러.
 */

const { loadEnv } = require('./env');
loadEnv();

const { MongoClient } = require('mongodb');

const MALL = process.env.CAFE24_MALL_ID || 'yogibo';
const API_VERSION = process.env.CAFE24_API_VERSION || '2025-12-01';
const ADMIN_BASE = `https://${MALL}.cafe24api.com/api/v2/admin`;
const CA_BASE = 'https://ca-api.cafe24data.com';

const TOKEN_URI = process.env.CAFE24_TOKEN_URI || process.env.MONGODB_URI;
const TOKEN_DB = process.env.CAFE24_TOKEN_DB || 'yogibo';
const TOKEN_COLL = process.env.CAFE24_TOKEN_COLLECTION || 'tokens';

function enabled() { return !!(TOKEN_URI && MALL); }

// ── 토큰 (읽기 전용, 60초 캐시) ──
let _client = null;
let _cache = { token: null, at: 0 };

async function readToken(force) {
  if (!force && _cache.token && Date.now() - _cache.at < 60000) return _cache.token;
  if (!TOKEN_URI) throw new Error('CAFE24_TOKEN_URI(또는 MONGODB_URI) 미설정');
  if (!_client) { _client = new MongoClient(TOKEN_URI, { serverSelectionTimeoutMS: 8000 }); await _client.connect(); }
  const doc = await _client.db(TOKEN_DB).collection(TOKEN_COLL).findOne({});
  if (!doc || !doc.accessToken) throw new Error('Cafe24 토큰 없음 (yogiChat tokens 컬렉션 확인)');
  _cache = { token: doc.accessToken, at: Date.now() };
  return doc.accessToken;
}

// ── 공통 GET (401 시 토큰 재읽기 후 1회 재시도) ──
async function httpGet(base, endpoint, params, useVersionHeader, _retry, _rl) {
  const token = await readToken(_retry);
  const u = new URL(base + endpoint);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null && v !== '') u.searchParams.set(k, String(v));
  }
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (useVersionHeader) headers['X-Cafe24-Api-Version'] = API_VERSION;

  const r = await fetch(u, { headers });
  if (r.status === 401 && !_retry) return httpGet(base, endpoint, params, useVersionHeader, true, _rl);
  if (r.status === 429 && (_rl || 0) < 5) {       // 레이트리밋 → Retry-After 또는 지수백오프 후 재시도
    const ra = Number(r.headers.get('Retry-After')) || 0;
    const wait = ra > 0 ? ra * 1000 : 400 * Math.pow(2, _rl || 0);
    await new Promise((res) => setTimeout(res, wait));
    return httpGet(base, endpoint, params, useVersionHeader, _retry, (_rl || 0) + 1);
  }
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); }
  catch (_) { throw new Error(`Cafe24 응답 파싱 실패 (HTTP ${r.status}): ${txt.slice(0, 160)}`); }
  if (r.status >= 400) {
    const msg = (j && (j.message || j.error || (j.error_description))) || JSON.stringify(j).slice(0, 200);
    const err = new Error(`Cafe24 HTTP ${r.status}: ${msg}`);
    err.status = r.status; err.body = j;
    throw err;
  }
  return j;
}

// Admin API: 버전 헤더 필요
function adminGet(endpoint, params) { return httpGet(ADMIN_BASE, endpoint, params, true); }

// Analytics API: mall_id 쿼리 필요, 버전 헤더 불필요
function caGet(endpoint, params) {
  return httpGet(CA_BASE, endpoint, { mall_id: MALL, ...(params || {}) }, false);
}

// ── 페이지네이션 헬퍼 ──
// Admin: 최대 100/페이지. key = 응답 배열 키(orders/coupons/products...)
async function adminPaginate(endpoint, params, key, { limit = 100, maxPages = 200 } = {}) {
  let offset = 0; const out = [];
  for (let i = 0; i < maxPages; i++) {
    const j = await adminGet(endpoint, { ...params, limit, offset });
    const arr = (j && j[key]) || [];
    out.push(...arr);
    if (arr.length < limit) break;
    offset += limit;
  }
  return out;
}

// Analytics: 최대 1000/페이지
async function caPaginate(endpoint, params, key, { limit = 1000, maxPages = 100 } = {}) {
  let offset = 0; const out = [];
  for (let i = 0; i < maxPages; i++) {
    const j = await caGet(endpoint, { ...params, limit, offset });
    const arr = (j && j[key]) || [];
    out.push(...arr);
    if (arr.length < limit) break;
    offset += limit;
  }
  return out;
}

async function close() { if (_client) { try { await _client.close(); } catch (_) {} _client = null; } }

// YYYYMMDD | YYYY-MM-DD → YYYY-MM-DD
function ymd(s) {
  const d = String(s || '').replace(/-/g, '');
  return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : String(s);
}

module.exports = {
  enabled, readToken, close, ymd,
  MALL, API_VERSION, ADMIN_BASE, CA_BASE,
  adminGet, caGet, adminPaginate, caPaginate,
};
