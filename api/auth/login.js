// api/auth/login.js
//
// v8.7 (2026-10-24)
// ① ERP 직원 첫 로그인 — 회사 결정(2026-10): ERP 직원은 따로 가입하지 않고 휴대폰 번호 + 000000으로 처음 로그인.
//    Site Order에 그 번호(1을 붙인 11자리 포함)로 된 계정이 하나도 없고, 비밀번호가 000000이고,
//    번호가 ERP 재직 직원 딱 1명과 같을 때만 직원 계정을 만든다 (승인·플래티늄·직원, 첫 로그인 때 본인 비밀번호로 변경 필수
//    — 관리자 화면 "ERP 직원 불러오기"의 CREATE와 같은 계정). 만들면 관리자에게 문자로 알린다.
//    · 비밀번호가 000000이 아니면 ERP를 보지 않는다(어떤 번호가 직원 번호인지 알려 주지 않도록).
//    · 이미 가입한 일반 계정을 로그인만으로 직원으로 바꾸지는 않는다(가입 때 번호 본인 확인이 없어서) —
//      관리자 화면 "ERP 직원 불러오기"에서 확인하고 전환한다.
// ② 로그인 실패 제한 — 같은 번호 15분에 10번, 같은 접속(IP) 15분에 20번 틀리면 15분 동안 막는다(비밀번호 6자리 대입 방지).
// ③ 번호 정리 — "1-213-…"처럼 11자리로 넣어도 10자리 계정을 찾는다(같은 사람 계정이 둘로 나뉘지 않게).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../../lib/db');
const { createSession } = require('../../lib/auth');
const { findActiveStaffByPhone, normPhone } = require('../../lib/erpStaff');
const { sendSms, toE164US } = require('../../lib/sms');

const STAFF_FIRST_PASSWORD = '000000';
const ROSTER_MAX_AGE_MS = 60 * 1000;
const FAIL_WINDOW = '15 minutes';
const MAX_FAILS_PER_PHONE = 10;   // 2026-10-24 대표님 결정: 같은 번호 15분에 10번
const MAX_FAILS_PER_IP = 20;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function ipHash(req) {
  const ip = String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || '').split(',')[0].trim();
  return ip ? crypto.createHash('sha256').update('pk-ip|' + ip).digest('hex').slice(0, 16) : 'unknown';
}

function logEvent(userId, phone, deviceId, eventType, detail) {
  return db.query(
    `INSERT INTO behavior_events (user_id, phone, device_id, event_type, detail) VALUES ($1,$2,$3,$4,$5)`,
    [userId, phone, deviceId || null, eventType, detail ? JSON.stringify(detail) : null]
  ).catch(() => {});
}

// 같은 번호(10자리·11자리 둘 다)로 된 계정. 넣은 그대로의 번호가 있으면 그것을 먼저 쓴다(예전 11자리 계정 호환).
async function findAccount(cleanPhone, p10) {
  const variants = [...new Set([cleanPhone, p10, /^[0-9]{10}$/.test(p10) ? '1' + p10 : null].filter(Boolean))];
  const { rows } = await db.query('SELECT * FROM users WHERE phone = ANY($1::text[])', [variants]);
  return { user: rows.find((u) => u.phone === cleanPhone) || rows.find((u) => u.phone === p10) || rows[0] || null, any: rows.length > 0 };
}

async function tooManyFailures(p10, ih) {
  try {
    const { rows } = await db.query(
      `SELECT count(*) FILTER (WHERE phone = $1)::int AS by_phone,
              count(*) FILTER (WHERE detail::text ~ ('"ip": ?"' || $2 || '"'))::int AS by_ip
         FROM behavior_events
        WHERE event_type = 'login_failed' AND created_at > now() - interval '${FAIL_WINDOW}'`,
      [p10, ih]);
    const r = rows[0] || {};
    return (r.by_phone || 0) >= MAX_FAILS_PER_PHONE || (ih !== 'unknown' && (r.by_ip || 0) >= MAX_FAILS_PER_IP);
  } catch (e) {
    console.error('[login] failure count failed:', e.message);
    return false;   // 셀 수 없으면 로그인은 막지 않는다
  }
}

async function createStaffAccount(p10, staff) {
  const hash = await bcrypt.hash(STAFF_FIRST_PASSWORD, 10);
  const ins = await db.query(
    `INSERT INTO users (phone, password_hash, company_name, rep_name, approved, approved_at, tier, is_staff, must_change_password, erp_staff_id)
     VALUES ($1, $2, $3, $4, TRUE, now(), 'tier1', TRUE, TRUE, $5)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [p10, hash, 'Premium K Staff · ' + staff.name, staff.name, staff.erpStaffId]
  );
  if (ins.rows[0]) return { user: ins.rows[0], created: true };
  const again = await db.query('SELECT * FROM users WHERE phone = $1', [p10]);
  return { user: again.rows[0] || null, created: false };
}

async function notifyAdminStaffCreated(staff, p10) {
  const adminPhone = toE164US(process.env.ADMIN_PHONE_NUMBER);
  if (!adminPhone) return;
  await sendSms({
    to: adminPhone,
    body: `[Premium K] 직원 계정 자동 생성 (ERP 직원 첫 로그인)\n${staff.name} · 번호 끝 ${p10.slice(-4)}\n본인이 아니면 ERP → Site Order 회원·매출 관리에서 확인해주세요.`,
  }).catch(() => {});
}

const NOT_FOUND_MSG = 'Phone number not found. Please register first. 등록되지 않은 휴대폰 번호입니다. 먼저 회원가입을 해주세요. (Premium K staff: please follow the first-login guide from the office. Premium K 직원은 회사에서 받은 첫 로그인 안내를 확인해주세요.)';

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { phone, password, deviceId } = req.body || {};
    const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
    const p10 = normPhone(cleanPhone);
    const pw = String(password || '');
    const ih = ipHash(req);

    if (await tooManyFailures(p10, ih)) {
      return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS', message: 'Too many failed attempts. Please try again in 15 minutes. 로그인 실패가 너무 많습니다. 15분 뒤에 다시 시도해주세요.' });
    }
    const fail = async (status, body) => {
      await logEvent(null, p10, deviceId, 'login_failed', { ip: ih, reason: body.error });
      return res.status(status).json(body);
    };

    let { user, any } = await findAccount(cleanPhone, p10);
    let staffCreated = null;

    if (!user && !any && pw === STAFF_FIRST_PASSWORD && /^[0-9]{10}$/.test(p10)) {
      // 계정 없는 번호 + 000000 → ERP 재직 직원이면 직원 계정을 만든다
      const staff = await findActiveStaffByPhone(p10, { maxAgeMs: ROSTER_MAX_AGE_MS });
      if (staff) {
        const linked = await db.query('SELECT id FROM users WHERE erp_staff_id = $1', [staff.erpStaffId]);
        if (!linked.rows[0]) {
          const r = await createStaffAccount(p10, staff);
          user = r.user;
          if (r.created) staffCreated = staff;
        }
      }
    }
    if (!user) return fail(401, { error: 'NOT_FOUND', message: NOT_FOUND_MSG });

    const ok = await bcrypt.compare(pw, user.password_hash);
    if (!ok) return fail(401, { error: 'WRONG_PASSWORD', message: 'Incorrect password. 비밀번호가 올바르지 않습니다.' });

    const token = await createSession(user.id);

    await logEvent(user.id, user.phone, deviceId, 'login');
    if (staffCreated) {
      await logEvent(user.id, user.phone, deviceId, 'staff_auto_link', { result: 'CREATE', erpStaffId: user.erp_staff_id || null, ip: ih });
      console.log(`[staff-login] CREATE user ${user.id} ← ERP staff ${user.erp_staff_id} (…${p10.slice(-4)})`);
      await notifyAdminStaffCreated(staffCreated, p10);
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
      staffLinked: staffCreated ? 'CREATE' : null,
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
