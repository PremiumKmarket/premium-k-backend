// api/orders.js
const db = require('../lib/db');
const { getUserFromToken, getBearerToken } = require('../lib/auth');

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
    const user = await getUserFromToken(getBearerToken(req));
    const {
      phone, customerName, address, repName,
      deliveryMethod, paymentMethod, items, total, orderText,
    } = req.body;

    const { rows } = await db.query(
      `INSERT INTO orders (user_id, phone, customer_name, address, rep_name, delivery_method, payment_method, items, total, order_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, created_at`,
      [
        user ? user.id : null,
        (phone || '').replace(/[^0-9]/g, '') || null,
        customerName || null,
        address || null,
        repName || null,
        deliveryMethod || null,
        paymentMethod || null,
        JSON.stringify(items || []),
        total || 0,
        orderText || null,
      ]
    );

    return res.status(201).json({ order: rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
};
