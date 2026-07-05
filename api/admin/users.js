// api/admin/users.js
const db = require('../../lib/db');
const { getUserFromToken, getBearerToken } = require('../../lib/auth');

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
      `SELECT id, phone, email, company_name, address, approved, is_admin, created_at, approved_at
       FROM users ORDER BY approved ASC, created_at DESC`
    );
    return res.json({ users: rows });
  }

  if (req.method === 'POST') {
    const { userId, approved } = req.body;
    const { rows } = await db.query(
      `UPDATE users SET approved = $1, approved_at = CASE WHEN $1 THEN now() ELSE NULL END
       WHERE id = $2 RETURNING id, phone, approved`,
      [!!approved, userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });
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
