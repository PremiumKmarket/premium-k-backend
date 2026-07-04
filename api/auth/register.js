// api/auth/register.js
const bcrypt = require('bcryptjs');
const db = require('../../lib/db');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function notifyAdminOfNewRegistration({ phone, email, companyName, address }) {
  const { EMAILJS_SERVICE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY, EMAILJS_TEMPLATE_ID, ADMIN_NOTIFY_EMAIL } = process.env;
  if (!EMAILJS_SERVICE_ID || !EMAILJS_PUBLIC_KEY || !EMAILJS_PRIVATE_KEY || !EMAILJS_TEMPLATE_ID) {
    console.warn('EmailJS env vars not fully set — skipping registration notification email.');
    return;
  }
  const message =
    `===== 신규 회원가입 승인 요청 =====\n\n` +
    `휴대폰번호 : ${phone}\n` +
    `이메일     : ${email || '—'}\n` +
    `상호명     : ${companyName || '—'}\n` +
    `배송주소   : ${address || '—'}\n\n` +
    `관리자 페이지에서 승인해주세요:\n` +
    `https://premium-k-backend.vercel.app/admin.html`;

  try {
    await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        accessToken: EMAILJS_PRIVATE_KEY,
        template_params: {
          rep_name: '시스템',
          customer_name: `[회원가입 승인요청] ${phone}`,
          order_total: '0.00',
          date: new Date().toLocaleString('ko-KR'),
          message,
          to_email: ADMIN_NOTIFY_EMAIL || 'info@tronicholdings.com',
        },
      }),
    });
  } catch (e) {
    console.error('Failed to send registration notification email:', e.message);
  }
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { phone, password, email, companyName, address } = req.body;

    if (!phone || !/^[0-9]{9,15}$/.test(phone.replace(/[^0-9]/g, ''))) {
      return res.status(400).json({ error: 'INVALID_PHONE', message: '휴대폰 번호를 정확히 입력해주세요.' });
    }
    if (!password || !/^[0-9]{6}$/.test(password)) {
      return res.status(400).json({ error: 'INVALID_PASSWORD', message: '비밀번호는 숫자 6자리로 입력해주세요.' });
    }

    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const existing = await db.query('SELECT id FROM users WHERE phone = $1', [cleanPhone]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'PHONE_EXISTS', message: '이미 등록된 휴대폰 번호입니다. 로그인해주세요.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO users (phone, password_hash, email, company_name, address, approved)
       VALUES ($1,$2,$3,$4,$5,false) RETURNING id, phone, approved`,
      [cleanPhone, passwordHash, email || null, companyName || null, address || null]
    );

    await db.query(
      `INSERT INTO behavior_events (user_id, phone, event_type, detail) VALUES ($1,$2,'register',$3)`,
      [rows[0].id, cleanPhone, JSON.stringify({ email, address })]
    );

    await notifyAdminOfNewRegistration({ phone: cleanPhone, email, companyName, address }).catch(() => {});

    return res.status(201).json({
      message: '가입 신청이 접수되었습니다. 관리자 승인 후 가격 조회가 가능합니다.',
      approved: false,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: '가입 처리 중 오류가 발생했습니다.' });
  }
};
