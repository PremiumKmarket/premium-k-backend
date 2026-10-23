// api/auth/login.js
//
// v8.7 (2026-10-24) — ERP 직원은 따로 등록하지 않아도 로그인된다 (회사 결정 2026-10: ERP 직원은 휴대폰 번호 + 000000으로 첫 로그인).
//   · Site Order에 없는 번호인데 ERP 재직 직원 번호와 같으면 → 비밀번호 000000일 때 직원 계정을 바로 만든다
//     (승인됨·플래티늄·직원, 첫 로그인 때 본인 비밀번호로 변경 필수 — 관리자 화면 "ERP 직원 불러오기"의 CREATE와 같은 계정)
//   · 이미 있는 일반 계정(직원·관리자 아님, ERP 연결 없음)의 번호가 ERP 재직 직원이면 → 비밀번호가 맞을 때 직원으로 전환
//     (비밀번호·주문 내역은 그대로 — "ERP 직원 불러오기"의 CONVERT와 같음)
//   · ERP에 연결이 안 되거나, 같은 번호가 ERP 직원 2명 이상에게 있으면 자동으로 하지 않는다(지금처럼 로그인만).
const bcrypt = require('bcryptjs');
const db = require('../../lib/db');
const { createSession } = require('../../lib/auth');
const { findActiveStaffByPhone } = require('../../lib/erpStaff');

const STAFF_FIRST_PASSWORD = '000000';
const CUSTOMER_CHECK_CACHE_MS = 5 * 60 * 1000;   // 일반 고객 로그인 때는 5분 안에 받아 둔 ERP 직원 명단을 다시 씀

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function logEvent(userId, phone, deviceId, eventType, detail) {
  return db.query(
    `INSERT INTO behavior_events (user_id, phone, device_id, event_type, detail) VALUES ($1,$2,$3,$4,$5)`,
    [userId, phone, deviceId || null, eventType, detail ? JSON.stringify(detail) : null]
  ).catch(() => {});
}

// ERP 직원 번호로 직원 계정 만들기. 같은 번호·같은 ERP 직원 계정이 그 사이 생겼으면 그 계정을 돌려준다.
async function createStaffAccount(phone, staff) {
  const hash = await bcrypt.hash(STAFF_FIRST_PASSWORD, 10);
  const ins = await db.query(
    `INSERT INTO users (phone, password_hash, company_name, rep_name, approved, approved_at, tier, is_staff, must_change_password, erp_staff_id)
     VALUES ($1, $2, $3, $4, TRUE, now(), 'tier1', TRUE, TRUE, $5)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [phone, hash, 'Premium K Staff · ' + staff.name, staff.name, staff.erpStaffId]
  );
  if (ins.rows[0]) return { user: ins.rows[0], created: true };
  const again = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);
  return { user: again.rows[0] || null, created: false };
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { phone, password, deviceId } = req.body || {};
    const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
    const pw = String(password || '');

    const { rows } = await db.query('SELECT * FROM users WHERE phone = $1', [cleanPhone]);
    let user = rows[0];
    let staffResult = null;   // 'CREATE' | 'CONVERT'
    let convertTo = null;

    if (!user) {
      // Site Order에 없는 번호 — ERP 재직 직원이면 첫 로그인(000000)으로 직원 계정을 만든다 (명단은 매번 새로 확인)
      const staff = await findActiveStaffByPhone(cleanPhone);
      if (staff) {
        if (pw !== STAFF_FIRST_PASSWORD) {
          return res.status(401).json({ error: 'STAFF_FIRST_LOGIN', message: 'Premium K staff: for your first login, use password 000000. Premium K 직원은 처음 로그인할 때 비밀번호 000000을 넣어주세요.' });
        }
        const linked = await db.query('SELECT id FROM users WHERE erp_staff_id = $1', [staff.erpStaffId]);
        if (!linked.rows[0]) {
          const r = await createStaffAccount(cleanPhone, staff);
          user = r.user;
          if (r.created) staffResult = 'CREATE';
        }
      }
      if (!user) {
        return res.status(401).json({ error: 'NOT_FOUND', message: 'Phone number not found. Please register first. 등록되지 않은 휴대폰 번호입니다. 먼저 회원가입을 해주세요.' });
      }
    } else if (!user.is_staff && !user.is_admin && !user.erp_staff_id) {
      // 이미 가입한 일반 계정 — 번호가 ERP 재직 직원이면 비밀번호 확인 뒤 직원으로 전환
      convertTo = await findActiveStaffByPhone(cleanPhone, { maxAgeMs: CUSTOMER_CHECK_CACHE_MS });
    }

    const ok = await bcrypt.compare(pw, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'WRONG_PASSWORD', message: 'Incorrect password. 비밀번호가 올바르지 않습니다.' });
    }

    if (convertTo) {
      const linked = await db.query('SELECT id FROM users WHERE erp_staff_id = $1', [convertTo.erpStaffId]);
      if (!linked.rows[0]) {
        const up = await db.query(
          `UPDATE users SET is_staff = TRUE, erp_staff_id = $2, tier = 'tier1', approved = TRUE, approved_at = COALESCE(approved_at, now()),
                  company_name = COALESCE(NULLIF(btrim(company_name), ''), $3), rep_name = COALESCE(NULLIF(btrim(rep_name), ''), $4)
            WHERE id = $1 AND NOT is_admin AND NOT is_staff AND erp_staff_id IS NULL
            RETURNING *`,
          [user.id, convertTo.erpStaffId, 'Premium K Staff · ' + convertTo.name, convertTo.name]
        ).catch((e) => { console.warn('[staff-login] convert failed:', e.message); return { rows: [] }; });
        if (up.rows[0]) { user = up.rows[0]; staffResult = 'CONVERT'; }
      }
    }

    const token = await createSession(user.id);

    await logEvent(user.id, cleanPhone, deviceId, 'login');
    if (staffResult) {
      await logEvent(user.id, cleanPhone, deviceId, 'staff_auto_link', { result: staffResult, erpStaffId: user.erp_staff_id || null });
      console.log(`[staff-login] ${staffResult} user ${user.id} ← ERP staff ${user.erp_staff_id} (…${cleanPhone.slice(-4)})`);
    }

    return res.json({
      token,
      approved: user.approved,
      tier: user.tier,
      email: user.email,
      companyName: user.company_name,
      isAdmin: user.is_admin,
      createdAt: user.created_at,
      repName: user.rep_name,
      isStaff: !!user.is_staff,
      staffLinked: staffResult,   // 'CREATE' | 'CONVERT' | null — 화면 안내용
      // 직원 계정은 첫 로그인(초기 비밀번호) 후 본인 비밀번호로 바꿔야 가격·주문이 열립니다.
      mustChangePassword: !!user.must_change_password,
      message: user.must_change_password
        ? 'Please set your own 6-digit password to continue. 계속하려면 본인 비밀번호 6자리로 바꿔주세요.'
        : (user.approved ? 'Logged in. 로그인되었습니다.' : 'Logged in. Prices will be visible once an admin approves your account. 다만 아직 관리자 승인 전이라 가격은 승인 후에 보입니다.'),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'An error occurred while logging in. 로그인 처리 중 오류가 발생했습니다.' });
  }
};
