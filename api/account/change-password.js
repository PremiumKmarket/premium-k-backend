// api/account/change-password.js
const bcrypt = require('bcryptjs');
const db = require('../../lib/db');
const { getUserFromToken, getBearerToken } = require('../../lib/auth');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUserFromToken(getBearerToken(req));
  if (!user) return res.status(401).json({ error: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });

  try {
    const { currentPassword, newPassword } = req.body;
    const ok = await bcrypt.compare(currentPassword || '', user.password_hash);
    if (!ok) return res.status(401).json({ error: 'WRONG_PASSWORD', message: '현재 비밀번호가 올바르지 않습니다.' });

    if (!newPassword || !/^[0-9]{6}$/.test(newPassword)) {
      return res.status(400).json({ error: 'INVALID_PASSWORD', message: '새 비밀번호는 숫자 6자리로 입력해주세요.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, user.id]);

    return res.json({ message: '비밀번호가 변경되었습니다.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: '처리 중 오류가 발생했습니다.' });
  }
};
