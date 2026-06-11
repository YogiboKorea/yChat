'use strict';

/**
 * 카탈로그 — 상품 그룹(카테고리 집합)을 product_no 집합으로 해석하고 DB 캐시.
 * /products?category={no} 사용(프로빙 확인). 상품 카탈로그는 자주 안 바뀌므로 24h 캐시.
 */

const c = require('./cafe24');
const store = require('./store');
const { groups } = require('../config/groups');

const COLL = 'product_groups';
const TTL_MS = 24 * 3600 * 1000;

async function fetchCategoryProductNos(catNo) {
  const rows = await c.adminPaginate('/products',
    { shop_no: 1, category: catNo, fields: 'product_no,product_name' },
    'products', { limit: 100, maxPages: 100 });
  return rows.map((p) => ({ no: String(p.product_no), name: p.product_name }));
}

// 그룹 → product_no 집합 (+ product_no → 그룹들, product_no → 이름)
async function resolveGroupSets({ force = false } = {}) {
  // 캐시 확인
  if (!force && store.configured()) {
    try {
      const coll = await store.collection(COLL);
      const doc = await coll.findOne({ _id: 'groupsets' });
      if (doc && doc.builtAt && (Date.now() - new Date(doc.builtAt).getTime() < TTL_MS)) {
        return hydrate(doc.map, doc.names);
      }
    } catch (_) {}
  }

  // 라이브 해석
  const map = {};      // group → [product_no]
  const names = {};    // product_no → name
  for (const [g, cats] of Object.entries(groups)) {
    const set = new Set();
    for (const cat of cats) {
      let rows = [];
      try { rows = await fetchCategoryProductNos(cat); } catch (_) { rows = []; }
      for (const r of rows) { set.add(r.no); if (r.name) names[r.no] = r.name; }
    }
    map[g] = [...set];
  }

  if (store.configured()) {
    try {
      const coll = await store.collection(COLL);
      await coll.updateOne({ _id: 'groupsets' }, { $set: { _id: 'groupsets', map, names, builtAt: new Date().toISOString() } }, { upsert: true });
    } catch (_) {}
  }
  return hydrate(map, names);
}

function hydrate(map, names) {
  const sets = {};                 // group → Set(product_no)
  const productGroups = {};        // product_no → [group]
  for (const [g, arr] of Object.entries(map)) {
    sets[g] = new Set(arr);
    for (const no of arr) (productGroups[no] = productGroups[no] || []).push(g);
  }
  return { sets, productGroups, names: names || {}, groupNames: Object.keys(map), counts: Object.fromEntries(Object.entries(map).map(([g, a]) => [g, a.length])) };
}

module.exports = { resolveGroupSets };
