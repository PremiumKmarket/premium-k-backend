// api/auth/register.js
const bcrypt = require('bcryptjs');
const db = require('../../lib/db');
const { sendSms, toE164US } = require('../../lib/sms');
const { signupDecision } = require('../../lib/signupRules');

const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

const TIER_LABEL = { tier1: '플래티늄 Platinum', tier2: '골드 Gold', tier3: '실버 Silver' };
const ERP_PATH = 'ERP → 📄 인보이스 → 🛒 Site Order 회원·매출 관리';

function signupHeadline(d) {
  return d.approved ? `신규 회원가입 · 자동 승인 (${TIER_LABEL[d.tier]})` : '신규 회원가입 승인 요청';
}
function tierReason(d) {
  if (d.reason === 'restaurant') return ' (가입 즉시 자동 승인 — 레스토랑 이름 입력)';
  if (d.reason === 'address') return ' (가입 즉시 자동 승인 — 주소 입력)';
  if (d.reason === 'incomplete_address') return ' (승인 대기 — 주소가 불완전함)';
  return ' (승인 대기 — 레스토랑 이름·주소 없음)';
}

async function notifyAdminOfNewRegistration({ phone, email, companyName, address, repName, decision }) {
  const { EMAILJS_SERVICE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY, EMAILJS_TEMPLATE_ID, ADMIN_NOTIFY_EMAIL } = process.env;

  if (!EMAILJS_SERVICE_ID || !EMAILJS_PUBLIC_KEY || !EMAILJS_PRIVATE_KEY || !EMAILJS_TEMPLATE_ID) {
    console.warn('[notifyAdmin] EmailJS env vars not fully set — skipping registration notification email.');
    return;
  }

  const d = decision;
  const message =
    `===== ${signupHeadline(d)} =====\n\n` +
    `휴대폰번호 : ${phone}\n` +
    `이메일     : ${email || '—'}\n` +
    `상호명     : ${companyName || '—'}\n` +
    `레스토랑 이름 : ${d.restaurantName || '—'}\n` +
    `배송주소   : ${address || '—'}\n` +
    `담당 영업사원 : ${repName || '—'}\n` +
    `등급       : ${TIER_LABEL[d.tier]}${tierReason(d)}\n\n` +
    (d.approved
      ? `등급이 맞지 않으면 ${ERP_PATH}에서 바꿔주세요.`
      : `${ERP_PATH}에서 승인해주세요.`);

  try {
    const res = await fetchFn('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        accessToken: EMAILJS_PRIVATE_KEY,
        template_params: {
          rep_name: repName || '시스템',
          customer_name: `[${d.approved ? '회원가입 자동승인 ' + TIER_LABEL[d.tier] : '회원가입 승인요청'}] ${phone}${repName ? ' · 담당: ' + repName : ''}`,
          order_total: '0.00',
          date: new Date().toLocaleString('ko-KR'),
          message,
          to_email: ADMIN_NOTIFY_EMAIL || 'info@tronicholdings.com',
        },
      }),
    });
    const text = await res.text();
    console.log('[notifyAdmin] EmailJS response status:', res.status, '| body:', text);
  } catch (e) {
    console.error('[notifyAdmin] Failed to send registration notification email:', e.message, e.stack);
  }
}

async function notifySmsOfNewRegistration({ phone, companyName, repName, decision }) {
  const adminPhone = toE164US(process.env.ADMIN_PHONE_NUMBER);
  if (!adminPhone) {
    console.warn('[notifySms] ADMIN_PHONE_NUMBER not set — skipping SMS.');
    return;
  }
  const d = decision;
  const body =
    (d.approved
      ? `[Premium K] New registration auto-approved 신규 가입 자동승인: ${TIER_LABEL[d.tier]}\n`
      : `[Premium K] New registration awaiting approval 신규 회원가입 승인요청\n`) +
    `Phone 전화번호: ${phone}\n` +
    `Company 상호명: ${companyName || '—'}\n` +
    `Restaurant 레스토랑: ${d.restaurantName || '—'}\n` +
    `Sales Rep 담당영업사원: ${repName || '—'}\n` +
    (d.approved ? `등급 변경: ${ERP_PATH}` : `승인: ${ERP_PATH}`);
  await sendSms({ to: adminPhone, body });
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const { phone, password, repName } = body;
    const email = body.email ? String(body.email).trim().slice(0, 200) : '';
    const companyName = body.companyName ? String(body.companyName).trim().slice(0, 120) : '';
    const address = body.address ? String(body.address).trim().slice(0, 300) : '';

    if (!phone || !/^[0-9]{9,15}$/.test(phone.replace(/[^0-9]/g, ''))) {
      return res.status(400).json({ error: 'INVALID_PHONE', message: 'Please enter a valid phone number. 휴대폰 번호를 정확히 입력해주세요.' });
    }
    if (!password || !/^[0-9]{6}$/.test(password)) {
      return res.status(400).json({ error: 'INVALID_PASSWORD', message: 'Password must be 6 digits. 비밀번호는 숫자 6자리로 입력해주세요.' });
    }

    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const existing = await db.query('SELECT id FROM users WHERE phone = $1', [cleanPhone]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'PHONE_EXISTS', message: 'This phone number is already registered. Please log in. 이미 등록된 휴대폰 번호입니다.' });
    }

    // 2026-10-16 — 레스토랑 이름을 넣으면 바로 플래티늄, 주소를 넣으면 바로 골드 (lib/signupRules.js)
    const decision = signupDecision({ address, restaurantName: body.restaurantName });
    const storedCompany = companyName || decision.restaurantName;   // 상호명을 비워 두면 레스토랑 이름을 상호명으로

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO users (phone, password_hash, email, company_name, address, rep_name, approved, approved_at, tier)
       VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $7 THEN now() ELSE NULL END, $8) RETURNING id, phone, approved, tier`,
      [cleanPhone, passwordHash, email || null, storedCompany || null, address || null, repName || null, decision.approved, decision.tier]
    );

    await db.query(
      `INSERT INTO behavior_events (user_id, phone, event_type, detail) VALUES ($1,$2,'register',$3)`,
      [rows[0].id, cleanPhone, JSON.stringify({
        email, address, restaurantName: decision.restaurantName || null,
        autoApproved: decision.approved, tier: decision.tier, reason: decision.reason,
      })]
    );

    await notifyAdminOfNewRegistration({ phone: cleanPhone, email, companyName: storedCompany, address, repName, decision }).catch((e) => {
      console.error('[register] notifyAdminOfNewRegistration threw:', e.message);
    });
    await notifySmsOfNewRegistration({ phone: cleanPhone, companyName: storedCompany, repName, decision }).catch((e) => {
      console.error('[register] notifySmsOfNewRegistration threw:', e.message);
    });

    if (decision.approved) {
      const en = decision.tier === 'tier1' ? 'Platinum' : 'Gold';
      const ko = decision.tier === 'tier1' ? '플래티늄' : '골드';
      return res.status(201).json({
        message: `Welcome! Your account is approved as ${en}. Log in to see wholesale prices. 가입이 완료되어 ${ko} 등급으로 바로 승인되었습니다.`,
        approved: true,
        tier: decision.tier,
      });
    }
    return res.status(201).json({
      message: 'Registration received. Prices will be visible once an admin approves your account. 가입 신청이 접수되었습니다.',
      approved: false,
      tier: decision.tier,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'An error occurred during registration. 가입 처리 중 오류가 발생했습니다.' });
  }
};
