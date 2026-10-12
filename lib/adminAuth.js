// lib/adminAuth.js
//
// 관리자 API(api/admin/users.js, api/admin/insights.js)를 누가 부르는지 확인한다.
// 두 가지 길이 있다.
//   1) Site Order 관리자 화면(admin.html): 로그인 세션 토큰 + users.is_admin
//   2) ERP "Site Order 관리" 메뉴 (v2.5 통합): ERP 서버가 서버 간 비밀키(x-premium-k-server-secret)와
//      ERP 로그인 사용자 정보(x-erp-actor-id / x-erp-actor-role / x-erp-actor-name)를 함께 보낸다.
//      브라우저는 비밀키를 모르므로 이 길은 ERP 서버만 쓸 수 있다. ERP에서도 같은 권한을 먼저 확인하고,
//      여기서 한 번 더 확인한다 (이중 확인).
//
// ERP 역할별 권한 (회사 결정: 회원 승급은 C-Level·Director만, 영업사원은 모든 거래처 실적 조회)
//   보기   (회원 목록·매출·고객 활동·가격표) : admin(C-Level), manager(Director), sales, accounting
//   바꾸기 (승인·등급·직원·비밀번호·삭제)     : admin, manager
//   Site Order 관리자 지정/해제               : admin 만
const crypto = require('crypto');
const { getUserFromToken, getBearerToken } = require('./auth');

const ERP_VIEW_ROLES = ['admin', 'manager', 'sales', 'accounting'];
const ERP_MANAGE_ROLES = ['admin', 'manager'];

function secretMatches(given) {
  const expected = process.env.PREMIUM_K_SERVER_SECRET;
  if (!expected || typeof given !== 'string' || !given) return false;
  // 길이까지 숨기기 위해 양쪽을 같은 길이(SHA-256)로 만든 뒤 비교
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function header(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

// 돌려주는 값: null(거절) 또는 { via, canManage, canGrantAdmin, id?, erpUserId?, erpRole?, name? }
async function resolveAdmin(req) {
  const secret = header(req, 'x-premium-k-server-secret');
  if (secret !== undefined) {
    // 비밀키를 보냈으면 반드시 ERP 경로로만 판단 (틀리면 세션 토큰으로 넘어가지 않고 거절)
    if (!secretMatches(secret)) return null;
    const erpUserId = String(header(req, 'x-erp-actor-id') || '').trim();
    const erpRole = String(header(req, 'x-erp-actor-role') || '').trim();
    if (!/^[0-9]+$/.test(erpUserId) || !ERP_VIEW_ROLES.includes(erpRole)) return null;
    let name = '';
    try { name = decodeURIComponent(String(header(req, 'x-erp-actor-name') || '')).slice(0, 80); } catch { name = ''; }
    return {
      via: 'erp', id: null, erpUserId, erpRole, name,
      canManage: ERP_MANAGE_ROLES.includes(erpRole),
      canGrantAdmin: erpRole === 'admin',
    };
  }
  const user = await getUserFromToken(getBearerToken(req));
  if (!user || !user.is_admin) return null;
  return { ...user, via: 'site', canManage: true, canGrantAdmin: true };
}

module.exports = { resolveAdmin, ERP_VIEW_ROLES, ERP_MANAGE_ROLES };
