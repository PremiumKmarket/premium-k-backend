// api/admin/users.js
const bcrypt = require('bcryptjs');
const db = require('../../lib/db');
const { getUserFromToken, getBearerToken } = require('../../lib/auth');
const { sendSms, toE164US } = require('../../lib/sms');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function requireAdmin(req) {
  const token = getBearerToken(req);
  const user = await getUserFromToken(token);
  if (!user || !user.is_admin) return null;
  return user;
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const admin = await requireAdmin(req);
  if (!admin) return res.status(403).json({ error: 'FORBIDDEN', message: '관리자만 접근할 수 있습니다.' });

  if (req.method === 'GET') {
    const { rows } = await db.query(
      `SELECT id, phone, email, company_name, address, rep_name, approved, is_admin, created_at, approved_at
       FROM users ORDER BY approved ASC, created_at DESC`
    );
    return res.json({ users: rows });
  }

  if (req.method === 'POST') {
    const { userId, approved, newPassword } = req.body;

    if (newPassword !== undefined) {
      if (!/^[0-9]{6}$/.test(newPassword)) {
        return res.status(400).json({ error: 'INVALID_PASSWORD', message: '비밀번호는 숫자 6자리여야 합니다.' });
      }
      const passwordHash = await bcrypt.hash(newPassword, 10);
      const { rows } = await db.query(
        'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id, phone',
        [passwordHash, userId]
      );
      if (!rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });
      await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
      return res.json({ user: rows[0], message: '비밀번호가 재설정되었습니다.' });
    }

    const { rows } = await db.query(
      `UPDATE users SET approved = $1, approved_at = CASE WHEN $1 THEN now() ELSE NULL END
       WHERE id = $2 RETURNING id, phone, approved`,
      [!!approved, userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });

    if (approved) {
      const customerPhone = toE164US(rows[0].phone);
      const body =
        `[Premium K] Your account has been approved! You can now log in and see wholesale prices.\n` +
        `계정이 승인되었습니다! 이제 로그인하시면 도매가를 확인하실 수 있습니다.`;
      sendSms({ to: customerPhone, body }).catch((e) => console.error('[approve] SMS failed:', e.message));
    }

    return res.json({ user: rows[0] });
  }

  if (req.method === 'DELETE') {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'MISSING_ID' });
    if (userId === admin.id) {
      return res.status(400).json({ error: 'CANNOT_DELETE_SELF', message: '본인 계정은 삭제할 수 없습니다.' });
    }
    const { rows } = await db.query('DELETE FROM users WHERE id = $1 RETURNING id', [userId]);
    if (!rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });
    return res.status(204).end();
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
