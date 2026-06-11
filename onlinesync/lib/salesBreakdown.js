'use strict';

/**
 * 총매출 분해 — 카테고리(상품그룹) × 등급(스탠다드/프리미엄/프리미엄 플러스).
 * 등급 = 상품명 기준: 아무것도 없으면 스탠다드, '프리미엄', '프리미엄 플러스'(=비즈 충전재 등급 차이).
 * computeOverview 의 라이브 주문(raw)으로 계산 → 총매출 수치와 일치.
 */

const N = (v) => (Number.isFinite(+v) ? +v : 0);

// 충전재(비즈) 등급 — EPP는 프리미엄으로 합침(상품명에 EPP 없음)
const TIERS = ['스탠다드', '프리미엄', '프리미엄플러스', '기타'];
const BIZ_CATS = new Set(['소파', '바디필로우', '메이트']); // 충전재(등급) 있는 본품 빈백
// 한 상품을 단일 카테고리에 귀속 (우선순위)
const CAT_PRIORITY = ['소파', '바디필로우', '메이트', '서포트/롤', '커버', '리필/비즈'];

// 충전재 등급 — 본품만 등급, 그 외(커버/비즈/액세서리)는 '기타'
function detectTier(name, cat) {
  if (cat && !BIZ_CATS.has(cat)) return '기타';
  const s = String(name || '');
  if (/프리미엄/.test(s)) {
    if (/플러스|\+/.test(s)) return '프리미엄플러스';
    return '프리미엄'; // EPP 포함 모두 프리미엄
  }
  return '스탠다드';
}

// 제품 라인(사이즈/모델) — 비즈(등급)별 구매 분해용. 본품(소파/바디필로우/메이트)만 의미 있음.
const LINE_KEYWORDS = ['맥스', '미디', '미니', '라운저', '드롭', '슬림', '피라미드', '오토만',
  '줄라', '트레이보', '럭스', '롤 맥스', '롤 미디', '롤 미니', '롤 메이트', '카터필러', '메가 문', '문 필로우', '서포트', '메이트'];
function detectLine(name) {
  const s = String(name || '');
  for (const k of LINE_KEYWORDS) if (s.includes(k)) return k.replace('롤 ', '롤');
  return '기타';
}

// 상품명 기반 분류 (카테고리 매핑 누락 보완) — 요기보 제품 라인
function categoryByName(name) {
  const s = String(name || '');
  if (/커버/.test(s)) return '커버';
  if (/비즈|리필|충전재|이너/.test(s)) return '리필/비즈';
  if (/필로우|서포트|\b롤\b|롤\s|카터필러|캐터필러/.test(s)) return '바디필로우';
  if (/메이트|스퀴지보|카카오|디즈니|산리오|캐릭터|쿠로미|마이멜로디/.test(s)) return '메이트';
  if (/맥스|미디|미니|라운저|드롭|슬림|피라미드|오토만|줄라|트레이보|럭스|믹스|모듈러|바주|메가|문\s*필로우|소파|빈백/.test(s)) return '소파';
  return '기타';
}

function categoryOf(productGroups, productNo, productName) {
  // [공동구매] 태그 상품은 "공동구매" 카테고리로 우선 분류 (본래 카테고리보다 우선)
  if (/공동구매/.test(String(productName || ''))) return '공동구매';
  const gs = productGroups[String(productNo || '')] || [];
  for (const c of CAT_PRIORITY) if (gs.includes(c)) return c;
  return categoryByName(productName); // 카테고리 매핑에 없으면 상품명으로
}

const blankTiers = () => Object.fromEntries(TIERS.map((t) => [t, { sales: 0, qty: 0 }]));

// orders(raw, embed items) × productGroups → 카테고리/충전재/라인 분해
function salesByCategoryTier(orders, productGroups) {
  const cats = {}; const lines = {};
  const tierTotals = blankTiers();
  let grand = 0, grandQty = 0;

  for (const o of (orders || [])) {
    if (o.paid !== 'T' || o.canceled === 'T') continue;
    for (const it of (o.items || [])) {
      const amt = N(it.payment_amount), qty = N(it.quantity);
      if (amt === 0 && qty === 0) continue;
      const cat = categoryOf(productGroups, it.product_no, it.product_name);
      const tier = detectTier(it.product_name, cat);
      const c = (cats[cat] = cats[cat] || { cat, total: 0, qty: 0, tiers: blankTiers() });
      c.total += amt; c.qty += qty; c.tiers[tier].sales += amt; c.tiers[tier].qty += qty;
      tierTotals[tier].sales += amt; tierTotals[tier].qty += qty; grand += amt; grandQty += qty;

      if (BIZ_CATS.has(cat)) {
        const line = detectLine(it.product_name);
        const L = (lines[line] = lines[line] || { line, total: 0, qty: 0, tiers: blankTiers() });
        L.total += amt; L.qty += qty; L.tiers[tier].sales += amt; L.tiers[tier].qty += qty;
      }
    }
  }

  const tiersOut = (tmap) => Object.fromEntries(TIERS.map((t) => [t, { sales: Math.round(tmap[t].sales), qty: tmap[t].qty }]));
  const order = ['공동구매', ...CAT_PRIORITY, '기타'];
  const rows = Object.values(cats).map((c) => ({
    cat: c.cat, total: Math.round(c.total), qty: c.qty, tiers: tiersOut(c.tiers), share: grand ? c.total / grand : 0,
  })).sort((a, b) => order.indexOf(a.cat) - order.indexOf(b.cat));

  const byLine = Object.values(lines).map((L) => ({
    line: L.line, total: Math.round(L.total), qty: L.qty, tiers: tiersOut(L.tiers),
  })).sort((a, b) => b.total - a.total);

  return {
    grand: Math.round(grand), grandQty,
    TIERS,
    tiers: TIERS.map((t) => ({ tier: t, sales: Math.round(tierTotals[t].sales), qty: tierTotals[t].qty, share: grand ? tierTotals[t].sales / grand : 0, qtyShare: grandQty ? tierTotals[t].qty / grandQty : 0 })),
    rows, byLine,
  };
}

module.exports = { salesByCategoryTier, detectTier, detectLine, categoryOf, TIERS };
