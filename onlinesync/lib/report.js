'use strict';

/**
 * 종합 리포트 — 세 집계를 묶고 DB 캐시로 API 호출을 최소화.
 *
 *  computeOverview(s,e): 라이브 API로 유입/회원·비회원/상품프로모션/쿠폰깔때기 산출.
 *  getOverview(s,e,{force}): 캐시 우선. 과거 구간은 영구, 오늘 포함 구간은 TTL.
 */

const c = require('./cafe24');
const analytics = require('./analytics');
const ordersLib = require('./orders');
const couponsLib = require('./coupons');
const tagPromotions = require('./tagPromotions');
const catalog = require('./catalog');
const { salesByCategoryTier } = require('./salesBreakdown');
const store = require('./store');

const SHOP = (process.env.CAFE24_MALL_ID || 'yogibo');
const STALE_MIN = Number(process.env.STALE_MIN || 60); // 오늘 포함 구간 캐시 신선도(분)

const REFRESH_DAYS = Number(process.env.REFRESH_DAYS || 7); // 재취합 버튼 윈도우(오늘~N일 전)
function pad(n) { return String(n).padStart(2, '0'); }
function fmt(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayStr() { return fmt(new Date()); }
function yesterdayStr() { const d = new Date(); d.setDate(d.getDate() - 1); return fmt(d); }
function minusDays(n) { const d = new Date(); d.setDate(d.getDate() - n); return fmt(d); }

// force: 전체 재집계(캐시 무시). forceFunnel: 무거운 쿠폰 funnel 스캔까지 강제(미지정 시 force 따름).
//  "오늘 재취합"은 force=true·forceFunnel=false 로 주문/매출만 빠르게 갱신하고 funnel 은 캐시 사용.
async function computeOverview(s, e, { force = false, forceFunnel } = {}) {
  const ff = forceFunnel === undefined ? force : forceFunnel;
  const [inflow, orders] = await Promise.all([
    analytics.inflowReport(s, e),
    ordersLib.fetchOrdersSmart(s, e), // 동기화된 구간은 orders_raw(Mongo)에서 — Cafe24 라이브 페이지네이션 회피
  ]);
  const members = ordersLib.memberReport(orders, s, e);
  const productPromo = couponsLib.productPromotion(orders);
  const directPromo = tagPromotions.summaryFromLiveOrders(orders); // 다이렉트/태그 프로모션 매출
  const { productGroups } = await catalog.resolveGroupSets();
  const salesBreakdown = salesByCategoryTier(orders, productGroups); // 총매출 카테고리×등급 분해
  const orderMap = new Map(orders.map((o) => [o.order_id, o]));
  const funnel = await couponsLib.couponFunnel(s, e, orderMap, { force: ff }); // 무거운 쿠폰 스캔은 캐시 우선(배포는 pending)
  return { start: s, end: e, ordersCount: orders.length, inflow, members, productPromo, directPromo, salesBreakdown, funnel };
}

function isFresh(doc, end) {
  if (!doc || !doc.overview) return false;
  if (end < todayStr()) return true; // 과거 구간 = 불변 → 영구 캐시
  const ageMin = (Date.now() - new Date(doc.computedAt).getTime()) / 60000;
  return ageMin < STALE_MIN;
}

async function getOverview(start, end, { force = false, forceFunnel } = {}) {
  const s = c.ymd(start), e = c.ymd(end);
  const key = `${SHOP}:${s}:${e}`;
  const readOnly = process.env.READ_ONLY === '1';

  if (!force && store.configured()) {
    try {
      const cached = await store.getCache(key);
      if (isFresh(cached, e)) {
        return { ...cached.overview, _cache: { hit: true, computedAt: cached.computedAt } };
      }
      // 배포(READ_ONLY): 만료된 today-포함 구간이라도 마지막 정상 캐시를 그대로 서빙(저하된 라이브 재계산 회피).
      //  새로 고침은 로컬 동기화/워밍이 캐시를 갱신하면 자동 반영.
      if (readOnly && cached && cached.overview) {
        return { ...cached.overview, _cache: { hit: true, stale: true, computedAt: cached.computedAt } };
      }
    } catch (_) { /* 캐시 조회 실패 시 라이브로 진행 */ }
  }

  const overview = await computeOverview(s, e, { force, forceFunnel });
  const computedAt = new Date().toISOString();
  // pending(쿠폰 미집계) 결과는 정상 캐시를 덮어쓰지 않음 — 저하된 결과를 TTL 동안 고정하는 것 방지
  const funnelPending = overview.funnel && overview.funnel.pending;
  if (store.configured() && !funnelPending) {
    try { await store.putCache({ key, shop: SHOP, start: s, end: e, overview, computedAt }); } catch (_) {}
  }
  return { ...overview, _cache: { hit: false, computedAt } };
}

// 최근 N일(오늘~N일 전) 재취합: 겹치는 캐시 삭제 후 라이브 강제 재집계.
async function refreshRecent(days = REFRESH_DAYS) {
  const end = todayStr();
  const start = minusDays(days);
  let deleted = 0;
  if (store.configured()) {
    try { deleted = await store.deleteOverlapping(start, end); } catch (_) {}
  }
  const overview = await getOverview(start, end, { force: true }); // 재계산 + 윈도우 캐시 재저장
  return { start, end, days, deleted, ...overview };
}

module.exports = { getOverview, computeOverview, refreshRecent, todayStr, yesterdayStr, REFRESH_DAYS, STALE_MIN };
