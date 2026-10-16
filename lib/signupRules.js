// lib/signupRules.js — 가입할 때 자동으로 정하는 승인·등급 (회사 결정 2026-10-16, James 승인)
//
//   레스토랑 이름을 넣고 가입        → 승인 없이 바로 플래티늄(tier1)
//   레스토랑 이름 없이 주소를 넣고 가입 → 승인 없이 바로 골드(tier2)
//   둘 다 없음 (또는 주소가 불완전)    → 지금처럼 실버(tier3)로 승인 대기
//
// 레스토랑 이름·주소는 고객이 직접 넣은 값이라 확인된 사실은 아님 → 관리자 알림과 ERP 회원 목록에
// "가입 자동 승인"으로 표시하고, C-Level·Director가 ERP에서 언제든 등급을 바꿀 수 있다.

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

// 반환: { approved, tier, restaurantName, reason }
//   reason: 'restaurant' | 'address' | 'incomplete_address' | 'no_address'
function signupDecision({ address, restaurantName }) {
  const rn = cleanRestaurantName(restaurantName);
  if (rn) return { approved: true, tier: 'tier1', restaurantName: rn, reason: 'restaurant' };
  if (isCompleteAddress(address)) return { approved: true, tier: 'tier2', restaurantName: '', reason: 'address' };
  const reason = String(address || '').trim() ? 'incomplete_address' : 'no_address';
  return { approved: false, tier: 'tier3', restaurantName: '', reason };
}

module.exports = { cleanRestaurantName, isCompleteAddress, signupDecision };
