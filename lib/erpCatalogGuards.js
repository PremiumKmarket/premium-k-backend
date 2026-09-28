// lib/erpCatalogGuards.js  v1.0 — ERP → Site Order 동기화 공통 안전 검사 (1차·2차 공용)
//
// 형식상 유효한 값이라도 입력 실수일 수 있다. 예) THFZSF0059: 박스 $70, 낱개 $2 인데 ERP 입수 1 →
// 사이트에 "1개입 $70"으로 잘못 반영됨(2026-09-25). 여기 검사에 걸리면 자동 반영하지 않고 확인 목록으로 보낸다.
// 어떤 경우에도 값을 새로 계산해 채우거나 0으로 대신하지 않는다.
//
// 판정 코드
//  REVIEW_QTY_TO_ONE   현재 사이트 입수 > 1 인데 ERP 새 입수 = 1 (35→1, 24→1). 1→1, 실제 1입 상품은 정상.
//  REVIEW_DATA_MISSING 박스가·입수·낱개가 중 하나라도 없음(비어 있음/0) → 비율을 계산할 수 없음
//  REVIEW_RATIO        박스가 ÷ (입수 × 낱개가) 가 0.65 ~ 1.35 밖
//  REVIEW_PRICE_JUMP   (2차) 현재 낱개가 대비 50% 초과 변동

const RATIO_MIN = 0.65;
const RATIO_MAX = 1.35;
const PRICE_JUMP = 0.5;

/** 양의 숫자면 그 값, 아니면 null (0·빈 값·문자는 모두 null — 0으로 계산하지 않는다) */
const pos = (v) => {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** 박스가·입수·낱개가 일치 검사. 셋 중 하나라도 없으면 계산하지 않고 DATA_MISSING */
function ratioCheck(ctnPrice, ctnQty, piecePrice) {
  const c = pos(ctnPrice), q = pos(ctnQty), p = pos(piecePrice);
  if (c == null || q == null || p == null) {
    const miss = [c == null && '박스가', q == null && '입수', p == null && '낱개가'].filter(Boolean).join('·');
    return { code: 'REVIEW_DATA_MISSING', ratio: null, reason: `${miss} 없음 — 비율 계산 불가` };
  }
  const ratio = Math.round((c / (q * p)) * 1000) / 1000;
  if (ratio < RATIO_MIN || ratio > RATIO_MAX) {
    return { code: 'REVIEW_RATIO', ratio, reason: `박스가 ${c} ÷ (입수 ${q} × 낱개가 ${p}) = ${ratio} — 허용 ${RATIO_MIN}~${RATIO_MAX} 밖` };
  }
  return { code: null, ratio };
}

/** 입수가 1로 떨어지는지 */
function qtyToOne(curQty, newQty) {
  const c = pos(curQty);
  return c != null && c > 1 && Number(newQty) === 1;
}

/** 낱개가 급변 — 현재 낱개가가 있을 때만 비교. 없으면 null(호출하는 쪽에서 따로 분류) */
function priceJump(curPrice, newPrice) {
  const c = pos(curPrice), n = pos(newPrice);
  if (c == null || n == null) return null;
  const rate = Math.abs(n - c) / c;
  return { jump: rate > PRICE_JUMP, rate: Math.round(rate * 1000) / 10 };   // rate: % 소수 1자리
}

module.exports = { pos, ratioCheck, qtyToOne, priceJump, RATIO_MIN, RATIO_MAX, PRICE_JUMP };
