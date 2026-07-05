// api/auth/confirm-reset.js
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
    const { token, newPassword } = req.body;
    if (!token) return res.status(400).json({ error: 'MISSING_TOKEN', message: '재설정 링크가 올바르지 않습니다.' });
    if (!newPassword || !/^[0-9]{6}$/.test(newPassword)) {
      return res.status(400).json({ error: 'INVALID_PASSWORD', message: '비밀번호는 숫자 6자리로 입력해주세요.' });
    }

    const { rows } = await db.query(
      `SELECT * FROM password_resets WHERE token = $1 AND used = false AND expires_at > now()`,
      [token]
    );
    const reset = rows[0];
    if (!reset) {
      return res.status(400).json({ error: 'INVALID_OR_EXPIRED', message: '재설정 링크가 만료되었거나 이미 사용되었습니다. 다시 요청해주세요.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, reset.user_id]);
    await db.query('UPDATE password_resets SET used = true WHERE token = $1', [token]);
    await db.query('DELETE FROM sessions WHERE user_id = $1', [reset.user_id]);

    return res.json({ message: '비밀번호가 변경되었습니다. 새 비밀번호로 로그인해주세요.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: '처리 중 오류가 발생했습니다.' });
  }
};
