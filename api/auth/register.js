// api/auth/register.js
const bcrypt = require('bcryptjs');
const db = require('../../lib/db');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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

    return res.status(201).json({
      message: '가입 신청이 접수되었습니다. 관리자 승인 후 가격 조회가 가능합니다.',
      approved: false,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: '가입 처리 중 오류가 발생했습니다.' });
  }
};
