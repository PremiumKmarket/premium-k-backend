// api/orders.js
const db = require('../lib/db');
const { getUserFromToken, getBearerToken } = require('../lib/auth');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function nextInvoiceNumber() {
  const now = new Date();
  const year = now.getFullYear();
  const yy = String(year).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');

  const { rows } = await db.query(
    `INSERT INTO invoice_counters (year, counter) VALUES ($1, 100)
     ON CONFLICT (year) DO UPDATE SET counter = invoice_counters.counter + 1
     RETURNING counter`,
    [year]
  );
  const seq = String(rows[0].counter).padStart(4, '0');
  return `${yy}-${mm}${dd}${seq}`;
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const user = await getUserFromToken(getBearerToken(req));
    if (!user) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Login required. 로그인이 필요합니다.' });
    const { rows } = await db.query(
      `SELECT id, invoice_number, customer_name, address, rep_name, delivery_method, payment_method, items, total, order_text, created_at
       FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [user.id]
    );
    return res.json({ orders: rows });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (req.query.action === 'reserve') {
      const invoiceNumber = await nextInvoiceNumber();
      return res.status(200).json({ invoiceNumber });
    }

    const user = await getUserFromToken(getBearerToken(req));
    const {
      phone, customerName, address, repName,
      deliveryMethod, paymentMethod, items, total, orderText, invoiceNumber,
    } = req.body;

    const finalInvoiceNumber = invoiceNumber || (await nextInvoiceNumber());

    const { rows } = await db.query(
      `INSERT INTO orders (user_id, phone, customer_name, address, rep_name, delivery_method, payment_method, items, total, order_text, invoice_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, invoice_number, created_at`,
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
        finalInvoiceNumber,
      ]
    );

    return res.status(201).json({ order: rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
};
