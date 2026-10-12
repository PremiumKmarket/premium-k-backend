// lib/erpStaff.js
//
// ERP → Site Order 직원 명단 연결 (관리자 화면 "ERP 직원 불러오기").
// ERP의 GET /api/site-orders/staff-roster 를 서버 간 비밀키로 읽어와서, Site Order 계정과 맞춰 볼
// 계획(plan)을 만든다. 브라우저는 ERP에 직접 접근하지 않고, 비밀키는 이 서버 환경변수에만 있다.
//
// 계획 종류 (ERP 재직 직원 1명당 하나)
//   CREATE   Site Order 계정 없음 → 새 직원 계정 (처음 비밀번호 000000, 첫 로그인 때 변경)
//   CONVERT  같은 번호의 일반 계정 있음 → 직원으로 전환 (비밀번호·주문 내역 그대로)
//   LINK     같은 번호의 직원 계정 있음(관리자 화면에서 직접 만든 것) → ERP 직원 번호만 연결
//   OK       이미 ERP 직원 번호로 연결된 직원 계정 있음 → 할 일 없음
//   SKIP_*   번호 없음/형식 오류, 직원끼리 번호 중복, 관리자 계정(자동으로 건드리지 않음)
// 그리고 ERP에서 퇴사(비활성)로 바뀐 직원:
//   DEACTIVATE  ERP 번호로 연결된 직원 계정인데 ERP 재직 명단에 없음 → 직원 표시만 끔 (선택 사항)
const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

const ERP_BASE = () => process.env.TRONIC_ERP_BASE_URL;
const SECRET = () => process.env.PREMIUM_K_SERVER_SECRET;
const TIMEOUT_MS = 8000;

function normPhone(raw) {
  let d = String(raw || '').replace(/[^0-9]/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d;
}

async function fetchRoster() {
  if (!ERP_BASE() || !SECRET()) {
    const e = new Error('ERP 연결 설정이 없습니다 (TRONIC_ERP_BASE_URL / PREMIUM_K_SERVER_SECRET). Vercel 환경변수를 확인해주세요.');
    e.code = 'ERP_NOT_CONFIGURED'; throw e;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetchFn(`${ERP_BASE().replace(/\/+$/, '')}/api/site-orders/staff-roster`, {
      headers: { 'x-premium-k-server-secret': SECRET() }, signal: controller.signal,
    });
    if (resp.status === 401) { const e = new Error('ERP가 연결 비밀키를 거절했습니다. 두 서버의 PREMIUM_K_SERVER_SECRET 값이 같은지 확인해주세요.'); e.code = 'ERP_AUTH'; throw e; }
    if (!resp.ok) { const e = new Error(`ERP 응답 오류 (${resp.status}). ERP가 최신 버전으로 배포됐는지 확인해주세요.`); e.code = 'ERP_HTTP'; throw e; }
    const data = await resp.json();
    if (!Array.isArray(data.staff)) { const e = new Error('ERP 응답 형식이 올바르지 않습니다.'); e.code = 'ERP_FORMAT'; throw e; }
    return { staff: data.staff, inactiveIds: (data.inactiveIds || []).map(String) };
  } catch (e) {
    if (e.name === 'AbortError') { const t = new Error('ERP 응답이 없습니다 (시간 초과).'); t.code = 'ERP_TIMEOUT'; throw t; }
    if (!e.code) { const t = new Error('ERP에 연결하지 못했습니다.'); t.code = 'ERP_UNREACHABLE'; throw t; }
    throw e;
  } finally { clearTimeout(timer); }
}

// roster: [{erpStaffId, name, phone}], users: Site Order users 행 (id, phone, is_admin, is_staff, erp_staff_id, company_name, tier, approved)
function computePlan(roster, users) {
  const byErp = new Map(), byPhone = new Map();
  for (const u of users) {
    if (u.erp_staff_id) byErp.set(String(u.erp_staff_id), u);
    byPhone.set(normPhone(u.phone), u);
  }
  const rows = roster.map(s => ({ erpStaffId: String(s.erpStaffId), name: String(s.name || '').trim(), phone: normPhone(s.phone) }));
  const phoneCount = {};
  rows.forEach(r => { if (r.phone) phoneCount[r.phone] = (phoneCount[r.phone] || 0) + 1; });
  const activeIds = new Set(rows.map(r => r.erpStaffId));
  const plan = rows.map(r => {
    const linked = byErp.get(r.erpStaffId);
    if (linked) return { ...r, action: 'OK', userId: linked.id };
    if (!/^[0-9]{10}$/.test(r.phone)) return { ...r, action: 'SKIP_PHONE' };
    if (phoneCount[r.phone] > 1) return { ...r, action: 'SKIP_DUP' };
    const u = byPhone.get(r.phone);
    if (!u) return { ...r, action: 'CREATE' };
    if (u.is_admin) return { ...r, action: 'SKIP_ADMIN', userId: u.id, current: u.company_name || '' };
    if (u.erp_staff_id) return { ...r, action: 'SKIP_OTHER_ERP', userId: u.id, current: u.company_name || '' };
    if (u.is_staff) return { ...r, action: 'LINK', userId: u.id, current: u.company_name || '' };
    return { ...r, action: 'CONVERT', userId: u.id, current: u.company_name || '' };
  });
  const deactivate = users
    .filter(u => u.is_staff && u.erp_staff_id && !activeIds.has(String(u.erp_staff_id)))
    .map(u => ({ userId: u.id, erpStaffId: String(u.erp_staff_id), name: u.rep_name || u.company_name || '', phone: normPhone(u.phone), action: 'DEACTIVATE' }));
  const counts = {};
  plan.concat(deactivate).forEach(p => { counts[p.action] = (counts[p.action] || 0) + 1; });
  return { plan, deactivate, counts };
}

async function loadUsersForPlan(q) {
  const { rows } = await q(
    `SELECT id, phone, is_admin, is_staff, erp_staff_id, company_name, rep_name, tier, approved FROM users`);
  return rows;
}

module.exports = { fetchRoster, computePlan, loadUsersForPlan, normPhone };
