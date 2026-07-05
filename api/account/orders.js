// api/account/orders.js
const db = require('../../lib/db');
const { getUserFromToken, getBearerToken } = require('../../lib/auth');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await getUserFromToken(getBearerToken(req));
  if (!user) return res.status(401).json({ error: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });

  const { rows } = await db.query(
    `SELECT id, customer_name, address, rep_name, delivery_method, payment_method, items, total, order_text, created_at
     FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [user.id]
  );

  return res.json({ orders: rows });
};
