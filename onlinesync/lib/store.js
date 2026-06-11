'use strict';

/**
 * 분석 결과 캐시 저장소 — onlineData 전용 DB(기본 'onlinedata').
 * 같은 Mongo 클러스터를 쓰되 별도 DB라 yogiChat/mkboard 데이터에 침범하지 않음.
 *
 * report_cache: 구간(start~end)별 집계 결과 스냅샷.
 *   - 과거 구간(end < 오늘)은 불변 → 영구 캐시(라이브 API 재호출 0).
 *   - 오늘/어제 포함 구간만 TTL 후 갱신.
 */

const { loadEnv } = require('./env');
loadEnv();
const { MongoClient } = require('mongodb');

const URI = process.env.ONLINEDATA_URI || process.env.CAFE24_TOKEN_URI || process.env.MONGODB_URI;
const DB_NAME = process.env.ONLINEDATA_DB || 'onlinedata';
const COLL = 'report_cache';

// 서버리스(Vercel)에서 콜드/웜 인보케이션 간 커넥션 재사용 — globalThis 캐시
const _g = globalThis;
_g.__onlinedata = _g.__onlinedata || { client: null, db: null, promise: null, indexed: false };

function configured() { return !!URI; }

async function db() {
  const g = _g.__onlinedata;
  if (g.db) return g.db;
  if (!URI) throw new Error('ONLINEDATA_URI(또는 MONGODB_URI) 미설정');
  if (!g.promise) {
    const client = new MongoClient(URI, { serverSelectionTimeoutMS: 8000, maxPoolSize: 10 });
    g.promise = client.connect().then((c) => { g.client = c; g.db = c.db(DB_NAME); return g.db; });
  }
  const database = await g.promise;
  if (!g.indexed) { try { await database.collection(COLL).createIndex({ key: 1 }, { unique: true }); } catch (_) {} g.indexed = true; }
  return database;
}

// 임의 컬렉션 접근 (ingest/segments 용)
async function collection(name) {
  const d = await db();
  return d.collection(name);
}

async function getCache(key) {
  const d = await db();
  return d.collection(COLL).findOne({ key });
}

async function putCache(doc) {
  const d = await db();
  await d.collection(COLL).updateOne({ key: doc.key }, { $set: doc }, { upsert: true });
}

async function listCache() {
  const d = await db();
  return d.collection(COLL).find({}, { projection: { overview: 0 } }).sort({ computedAt: -1 }).limit(100).toArray();
}

// 구간 [start,end] 과 겹치는 모든 캐시 삭제 (오늘 포함 가변구간 재취합용).
// 겹침 조건: cached.start <= end AND cached.end >= start
async function deleteOverlapping(start, end) {
  const d = await db();
  const r = await d.collection(COLL).deleteMany({ start: { $lte: end }, end: { $gte: start } });
  return r.deletedCount || 0;
}

async function close() { const g = _g.__onlinedata; if (g.client) { try { await g.client.close(); } catch (_) {} g.client = null; g.db = null; g.promise = null; } }

module.exports = { configured, collection, getCache, putCache, listCache, deleteOverlapping, close, DB_NAME };
