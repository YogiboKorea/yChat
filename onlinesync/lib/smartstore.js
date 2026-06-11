'use strict';

/**
 * 스마트스토어 — 네이버 커머스 API 클라이언트.
 *   인증: client_secret_sign = Base64( bcrypt(client_id + "_" + timestamp, client_secret) )
 *         POST https://api.commerce.naver.com/external/v1/oauth2/token (client_credentials, type=SELF)
 *   토큰은 ~3시간 유효 → 메모리 캐시.
 *
 *   .env:  NAVER_COMMERCE_CLIENT_ID, NAVER_COMMERCE_CLIENT_SECRET
 *          (커머스 API 센터 https://apicenter.commerce.naver.com 에서 애플리케이션 등록 후 발급)
 */

const { loadEnv } = require('./env');
loadEnv();
let bcrypt;
try { bcrypt = require('bcryptjs'); } catch (_) { bcrypt = null; }

const BASE = 'https://api.commerce.naver.com';
const CLIENT_ID = process.env.NAVER_COMMERCE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.NAVER_COMMERCE_CLIENT_SECRET || '';

function enabled() { return !!(CLIENT_ID && CLIENT_SECRET && bcrypt); }

let _token = null, _exp = 0;

// 전자서명 생성: Base64(bcrypt(client_id + "_" + timestamp, client_secret))
function sign(timestamp) {
  if (!bcrypt) throw new Error("bcryptjs 미설치 — 'npm install bcryptjs'");
  const hashed = bcrypt.hashSync(`${CLIENT_ID}_${timestamp}`, CLIENT_SECRET); // client_secret = bcrypt salt
  return Buffer.from(hashed, 'utf-8').toString('base64');
}

async function getToken(force) {
  if (!force && _token && Date.now() < _exp - 60000) return _token;
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('NAVER_COMMERCE_CLIENT_ID/SECRET 미설정 (.env)');
  const ts = Date.now();
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    timestamp: String(ts),
    grant_type: 'client_credentials',
    client_secret_sign: sign(ts),
    type: 'SELF',
  });
  const r = await fetch(`${BASE}/external/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch (_) { throw new Error(`네이버 토큰 응답 파싱 실패 (HTTP ${r.status}): ${txt.slice(0, 160)}`); }
  if (!r.ok || !j.access_token) throw new Error(`네이버 토큰 발급 실패 (HTTP ${r.status}): ${j.message || j.error || JSON.stringify(j).slice(0, 200)}`);
  _token = j.access_token;
  _exp = Date.now() + (Number(j.expires_in) || 10800) * 1000;
  return _token;
}

// 호출 간격 제어(레이트리밋 회피) + 429 백오프 재시도
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN_GAP = Number(process.env.NAVER_MIN_GAP_MS || 450);
let _lastReq = 0;
async function throttle() {
  const wait = MIN_GAP - (Date.now() - _lastReq);
  if (wait > 0) await sleep(wait);
  _lastReq = Date.now();
}

async function request(method, endpoint, { params, body } = {}, attempt = 0) {
  const token = await getToken(attempt === -1);
  const u = new URL(BASE + endpoint);
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') u.searchParams.set(k, String(v));
  const opt = { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }

  await throttle();
  const r = await fetch(u, opt);
  if (r.status === 401 && attempt >= 0) return request(method, endpoint, { params, body }, -1); // 토큰 강제 재발급 후 1회
  if (r.status === 429 && attempt < 5) { await sleep(1000 * (attempt + 1)); return request(method, endpoint, { params, body }, attempt + 1); }
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch (_) { throw new Error(`네이버 응답 파싱 실패 (HTTP ${r.status}): ${txt.slice(0, 160)}`); }
  if (r.status >= 400) {
    const err = new Error(`네이버 커머스 HTTP ${r.status}: ${j.message || j.code || JSON.stringify(j).slice(0, 200)}`);
    err.status = r.status; err.body = j; throw err;
  }
  return j;
}

const apiGet = (endpoint, params) => request('GET', endpoint, { params });
const apiPost = (endpoint, body, params) => request('POST', endpoint, { body, params });

module.exports = { enabled, getToken, apiGet, apiPost, BASE, CLIENT_ID };
