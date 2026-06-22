'use strict';

/**
 * 몰별 프로모션(설정) — onlinedata.mall_promotions.
 *   몰을 선택하고, Cafe24 상품 리스트에서 대상 상품을 추가한 뒤, 상품별 할인율(%)을 직접 입력해 등록한다.
 *   (기존 전사 promo_periods 를 대체하는 새 모델 — 몰·상품·할인율까지 관리)
 *
 *   { _id, mall, name, start:'YYYY-MM-DD', end:'YYYY-MM-DD',
 *     products:[{ productNo, productName, price, discountRate }], createdAt, updatedAt }
 *
 *   mall: '자사몰' | '스마트스토어' | 기타 채널 그룹명(쿠팡·롯데·신세계…)
 */

const store = require('./store');
const { ObjectId } = require('mongodb');

const COLL = 'mall_promotions';

function cleanProducts(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((p) => ({
    productNo: String(p.productNo || p.product_no || ''),
    productName: String(p.productName || p.product_name || '').trim(),
    price: Math.round(Number(p.price) || 0),
    discountRate: Math.max(0, Math.min(100, Number(p.discountRate) || 0)),
    coupon: String(p.coupon || '').trim(),       // 상품별 쿠폰(자유 텍스트: 쿠폰명/코드/혜택)
    source: p.source === 'smartstore' ? 'smartstore' : 'cafe24',
  })).filter((p) => p.productNo || p.productName);
}

// 자사몰: 프로모션에 연결한 Cafe24 쿠폰 스냅샷 (쿠폰이 삭제돼도 '어떤 쿠폰이었다' 기록 유지)
function cleanCoupons(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((cp) => ({
    coupon_no: String(cp.coupon_no || ''),
    coupon_name: String(cp.coupon_name || '').trim(),
    benefitText: String(cp.benefitText || cp.benefit || ''),
    targetLabel: String(cp.targetLabel || ''),
    productNos: Array.isArray(cp.productNos) ? cp.productNos.map((x) => String(x)) : [],
    savedAt: cp.savedAt || new Date().toISOString(),
  })).filter((cp) => cp.coupon_no || cp.coupon_name);
}

function cleanTrafficTargets(t) {
  t = t || {};
  return {
    visits: Math.round(+t.visits || 0),                    // 일평균 방문수 목표
    signups: Math.round((+t.signups || 0) * 10) / 10,      // 일평균 가입수 목표
    purchaseRate: +t.purchaseRate || 0,                    // 구매율 목표(0~1)
    signupRate: +t.signupRate || 0,                        // 가입률 목표(0~1)
  };
}
function clean(b) {
  return {
    mall: String(b.mall || '').trim(),
    name: String(b.name || '').trim(),
    start: String(b.start || ''),
    end: String(b.end || ''),
    memo: String(b.memo || '').trim(),       // 상세 프로모션 계획(자유 메모)
    target: Math.round(+b.target || 0),      // 프로모션 목표 매출
    trafficTargets: cleanTrafficTargets(b.trafficTargets), // 트래픽 KPI 목표(일평균)
    products: cleanProducts(b.products),
    coupons: cleanCoupons(b.coupons),        // 연결 쿠폰 스냅샷(자사몰)
  };
}

async function setPromotion(b) {
  const d = clean(b);
  if (!d.mall) throw new Error('몰을 선택하세요');
  if (!d.name) throw new Error('프로모션명을 입력하세요');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.start) || !/^\d{4}-\d{2}-\d{2}$/.test(d.end)) throw new Error('기간(시작/종료) 형식 오류(YYYY-MM-DD)');
  if (d.end < d.start) throw new Error('종료일이 시작일보다 빠릅니다');
  const c = await store.collection(COLL);
  d.updatedAt = new Date().toISOString();
  if (b.id) {
    await c.updateOne({ _id: new ObjectId(String(b.id)) }, { $set: d });
    return { id: String(b.id), ...d };
  }
  d.createdAt = d.updatedAt;
  const r = await c.insertOne(d);
  return { id: String(r.insertedId), ...d };
}

async function listPromotions(mall) {
  if (!store.configured()) return [];
  try {
    const c = await store.collection(COLL);
    const q = mall ? { mall } : {};
    const arr = await c.find(q).sort({ start: -1 }).limit(300).toArray();
    return arr.map((d) => ({ id: String(d._id), mall: d.mall, name: d.name, start: d.start, end: d.end, memo: d.memo || '', target: d.target || 0, trafficTargets: d.trafficTargets || null, products: d.products || [], coupons: d.coupons || [], updatedAt: d.updatedAt }));
  } catch (_) { return []; }
}

// 특정 몰/날짜에 진행중인 프로모션 (③ 분석 재연결용으로 추후 사용)
async function activeFor(mall, date) {
  if (!store.configured()) return [];
  try {
    const c = await store.collection(COLL);
    const q = { start: { $lte: date }, end: { $gte: date } };
    if (mall) q.mall = mall;
    const arr = await c.find(q).toArray();
    return arr.map((d) => ({ id: String(d._id), mall: d.mall, name: d.name, start: d.start, end: d.end, products: d.products || [] }));
  } catch (_) { return []; }
}

async function deletePromotion(id) {
  try { const c = await store.collection(COLL); await c.deleteOne({ _id: new ObjectId(String(id)) }); return true; } catch (_) { return false; }
}

module.exports = { setPromotion, listPromotions, activeFor, deletePromotion };
