const bcrypt = require('bcryptjs');
const db = require('../../lib/db');
const { createSession } = require('../../lib/auth');

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
    const { phone, password, deviceId } = req.body;
    const cleanPhone = (phone || '').replace(/[^0-9]/g, '');

    const { rows } = await db.query('SELECT * FROM users WHERE phone = $1', [cleanPhone]);
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ error: 'NOT_FOUND', message: '등록되지 않은 휴대폰 번호입니다. 먼저 회원가입해주세요.' });
    }

    const ok = await bcrypt.compare(password || '', user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'WRONG_PASSWORD', message: '비밀번호가 올바르지 않습니다.' });
    }

    const token = await createSession(user.id);

    await db.query(
      `INSERT INTO behavior_events (user_id, phone, device_id, event_type) VALUES ($1,$2,$3,'login')`,
      [user.id, cleanPhone, deviceId || null]
    );

    return res.json({
      token,
      approved: user.approved,
      email: user.email,
      companyName: user.company_name,
      isAdmin: user.is_admin,
      message: user.approved ? '로그인되었습니다.' : '로그인되었습니다. 다만 아직 관리자 승인 전이라 가격은 승인 후에 보입니다.',
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: '로그인 처리 중 오류가 발생했습니다.' });
  }
};
