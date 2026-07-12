// lib/pricing.js
// 고객 등급(Tier)별 가격 계산 공용 헬퍼.
//
// Tier 1 (월매출 $20,000+ 홀세일러): 기존 DB 가격 그대로 (배수 1.00)
// Tier 2 (식당/마켓 등 $2,000~$20,000): 기존 가격의 +10% (배수 1.10)
// Tier 3 (소상공인/샵인샵 등 $2,000 이하): 기존 가격의 +15% (배수 1.15)
//
// 박스(케이스) 단가는 보기 편하도록 소수점을 항상 $XX.00 또는 $XX.50 로
// "올림" 처리합니다 (James 요청). 개당 참고가는 박스단가/박스당수량으로
// 자동 계산되며 별도 반올림 없이 그대로 표기합니다 (기존과 동일).

const TIER_MULTIPLIERS = {
  tier1: 1.00,
  tier2: 1.10,
  tier3: 1.15,
};

const DEFAULT_TIER = 'tier3';

function normalizeTier(tier) {
  return TIER_MULTIPLIERS[tier] ? tier : DEFAULT_TIER;
}

// $XX.00 또는 $XX.50 단위로 올림 처리
// (부동소수점 오차로 45*1.10 같은 계산이 49.500000000000014 처럼 나올 수 있어,
//  먼저 센트 단위로 반올림해 오차를 제거한 뒤 0.50 단위로 올림합니다)
function roundUpToHalf(amount) {
  const cents = Math.round(amount * 100) / 100;
  return Math.ceil(cents * 2 - 1e-9) / 2;
}

// 상품 하나에 등급별 가격을 적용합니다.
// rowToProduct()가 만든 { price, ctnPrice, ctnQty, tbd, ... } 객체를 받아
// 같은 모양의 객체를 등급 반영된 가격으로 반환합니다.
function applyTierPricing(product, tier) {
  const t = normalizeTier(tier);

  // 가격 문의(TBD) 상품이나 박스가격이 없는 상품은 등급 배수를 적용하지 않습니다.
  if (product.tbd || product.ctnPrice === undefined || product.ctnPrice === null) {
    return product;
  }

  // Tier 1은 "기존 가격 그대로"이므로 반올림 없이 원래 값을 그대로 씁니다.
  // (Tier 2/3만 계산 후 $XX.00 / $XX.50 단위로 올림합니다)
  if (t === 'tier1') return product;

  const multiplier = TIER_MULTIPLIERS[t];
  const tieredCtnPrice = roundUpToHalf(Number(product.ctnPrice) * multiplier);
  const ctnQty = product.ctnQty || null;
  const tieredUnitPrice = ctnQty ? tieredCtnPrice / ctnQty : Number(product.price);

  return {
    ...product,
    ctnPrice: tieredCtnPrice,
    price: tieredUnitPrice,
  };
}

function applyTierPricingToAll(products, tier) {
  return products.map((p) => applyTierPricing(p, tier));
}

module.exports = { TIER_MULTIPLIERS, DEFAULT_TIER, normalizeTier, roundUpToHalf, applyTierPricing, applyTierPricingToAll };
