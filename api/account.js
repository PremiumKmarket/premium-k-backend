// api/account.js
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const { getUserFromToken, getBearerToken } = require('../lib/auth');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function handlePassword(req, res, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { currentPassword, newPassword } = req.body;
  const ok = await bcrypt.compare(currentPassword || '', user.password_hash);
  if (!ok) return res.status(401).json({ error: 'WRONG_PASSWORD', message: '현재 비밀번호가 올바르지 않습니다.' });
  if (!newPassword || !/^[0-9]{6}$/.test(newPassword)) {
    return res.status(400).json({ error: 'INVALID_PASSWORD', message: '새 비밀번호는 숫자 6자리로 입력해주세요.' });
  }
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, user.id]);
  return res.json({ message: '비밀번호가 변경되었습니다.' });
}

async function handleAddresses(req, res, user) {
  if (req.method === 'GET') {
    const { rows } = await db.query(
      'SELECT * FROM user_addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC',
      [user.id]
    );
    return res.json({ addresses: rows });
  }

  if (req.method === 'POST') {
    const { label, address, isDefault } = req.body;
    if (!address || !address.trim()) {
      return res.status(400).json({ error: 'MISSING_ADDRESS', message: '주소를 입력해주세요.' });
    }
    if (isDefault) await db.query('UPDATE user_addresses SET is_default = false WHERE user_id = $1', [user.id]);
    const { rows } = await db.query(
      'INSERT INTO user_addresses (user_id, label, address, is_default) VALUES ($1,$2,$3,$4) RETURNING *',
      [user.id, label || null, address.trim(), !!isDefault]
    );
    return res.status(201).json({ address: rows[0] });
  }

  if (req.method === 'PATCH') {
    const { id, label, address, isDefault } = req.body;
    if (!id) return res.status(400).json({ error: 'MISSING_ID' });
    if (isDefault) await db.query('UPDATE user_addresses SET is_default = false WHERE user_id = $1', [user.id]);
    const { rows } = await db.query(
      `UPDATE user_addresses SET label = COALESCE($1, label), address = COALESCE($2, address), is_default = COALESCE($3, is_default)
       WHERE id = $4 AND user_id = $5 RETURNING *`,
      [label, address, isDefault, id, user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });
    return res.json({ address: rows[0] });
  }

  if (req.method === 'DELETE') {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'MISSING_ID' });
    await db.query('DELETE FROM user_addresses WHERE id = $1 AND user_id = $2', [id, user.id]);
    return res.status(204).end();
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await getUserFromToken(getBearerToken(req));
  if (!user) return res.status(401).json({ error: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });

  try {
    const resource = req.query.resource;
    if (resource === 'password') return await handlePassword(req, res, user);
    if (resource === 'addresses') return await handleAddresses(req, res, user);
    return res.status(400).json({ error: 'UNKNOWN_RESOURCE', message: '알 수 없는 요청입니다.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: '처리 중 오류가 발생했습니다.' });
  }
};
