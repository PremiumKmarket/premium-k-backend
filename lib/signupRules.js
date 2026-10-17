// lib/signupRules.js — 가입할 때 자동으로 정하는 승인·등급 (회사 결정 2026-10-16, James 승인)
//
//   가입 화면 "레스토랑 검색"에서 고른 식당            → 무조건 바로 플래티늄(tier1)  (2026-10-17 James 결정)
//   레스토랑 이름 + 주소, 구글로 실제 식당 확인됨      → 승인 없이 바로 플래티늄(tier1)
//   레스토랑 확인 안 됨·확인 실패·확인 꺼짐 + 주소       → 바로 골드(tier2), 관리자가 확인 후 플래티늄으로 올림
//   레스토랑 이름 없이 주소                            → 바로 골드(tier2)
//   주소 없음 / 주소 불완전                            → 지금처럼 실버(tier3) 승인 대기
//   플래티늄은 구글 확인이 실제로 된 경우에만 (구글 키가 없거나 응답이 없으면 골드로 시작 — 안전한 쪽).
//
// 레스토랑 이름·주소는 고객이 직접 넣은 값 → 관리자 알림과 ERP 회원 목록에 "가입 자동 승인"과 구글 확인 결과를 보여 준다.

const ZIP_RE = /\b\d{5}(?:-\d{4})?\b/g;

// 레스토랑 이름: 앞뒤 공백 정리, 120자까지, 글자(영문·한글 등)가 2자 이상 있어야 인정
function cleanRestaurantName(v) {
  const s = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const letters = (s.match(/[A-Za-z가-힣぀-ヿ一-鿿]/g) || []).length;
  return letters >= 2 ? s : '';
}

// 미국 주소로 볼 수 있는 최소 조건: 10자 이상, 우편번호 5자리, 번지(우편번호 외 숫자), 글자 단어
function isCompleteAddress(address) {
  const s = String(address || '').replace(/\s+/g, ' ').trim();
  if (s.length < 10 || s.length > 300) return false;
  if (!s.match(ZIP_RE)) return false;
  if (!/[A-Za-z가-힣]{2,}/.test(s)) return false;
  return /\d/.test(s.replace(ZIP_RE, ''));
}

// check: 구글 확인 결과 { status: 'selected'|'verified'|'not_found'|'error'|'off'|'no_address'|'limit' } — 없으면 확인 안 된 것으로 본다
// 반환: { approved, tier, restaurantName, reason }
//   reason: 'restaurant_selected' | 'restaurant_verified' | 'restaurant_unverified' (골드) |
//           'address' | 'restaurant_no_address' | 'incomplete_address' | 'no_address'
function signupDecision({ address, restaurantName, check }) {
  const rn = cleanRestaurantName(restaurantName);
  const addrOk = isCompleteAddress(address);
  const verified = !!(check && check.status === 'verified');
  if (rn && check && check.status === 'selected') return { approved: true, tier: 'tier1', restaurantName: rn, reason: 'restaurant_selected' };
  if (rn) {
    if (addrOk && verified) return { approved: true, tier: 'tier1', restaurantName: rn, reason: 'restaurant_verified' };
    if (addrOk) return { approved: true, tier: 'tier2', restaurantName: rn, reason: 'restaurant_unverified' };
    return { approved: false, tier: 'tier3', restaurantName: rn, reason: 'restaurant_no_address' };
  }
  if (addrOk) return { approved: true, tier: 'tier2', restaurantName: '', reason: 'address' };
  const reason = String(address || '').trim() ? 'incomplete_address' : 'no_address';
  return { approved: false, tier: 'tier3', restaurantName: '', reason };
}

module.exports = { cleanRestaurantName, isCompleteAddress, signupDecision };
