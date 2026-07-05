// api/auth/reset.js
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../../lib/db');
const { sendEmail } = require('../../lib/emailjs');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function handleRequest(req, res) {
  const cleanPhone = (req.body.phone || '').replace(/[^0-9]/g, '');
  if (!cleanPhone) return res.status(400).json({ error: 'INVALID_PHONE', message: '휴대폰 번호를 입력해주세요.' });

  const { rows } = await db.query('SELECT id, email FROM users WHERE phone = $1', [cleanPhone]);
  const user = rows[0];

  if (!user || !user.email) {
    return res.json({ message: '등록된 이메일로 재설정 링크를 보냈습니다. (계정이 있는 경우)' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  await db.query('INSERT INTO password_resets (token, user_id, expires_at) VALUES ($1,$2,$3)', [token, user.id, expiresAt]);

  const resetUrl = `https://premium-k-backend.vercel.app/reset.html?token=${token}`;
  await sendEmail({
    toEmail: user.email,
    label: `[비밀번호 재설정 요청] ${cleanPhone}`,
    message:
      `비밀번호 재설정 요청이 있었습니다.\n\n휴대폰번호 : ${cleanPhone}\n\n` +
      `아래 링크에서 새 비밀번호를 설정해주세요 (30분간 유효):\n${resetUrl}\n\n` +
      `본인이 요청하지 않았다면 이 메일은 무시하셔도 됩니다.`,
  });

  return res.json({ message: '등록된 이메일로 재설정 링크를 보냈습니다.' });
}

async function handleConfirm(req, res) {
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
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (req.body.action === 'confirm') return await handleConfirm(req, res);
    return await handleRequest(req, res);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: '처리 중 오류가 발생했습니다.' });
  }
};
