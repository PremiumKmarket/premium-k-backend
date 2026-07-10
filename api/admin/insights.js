// api/admin/insights.js
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

  const token = getBearerToken(req);
  const admin = await getUserFromToken(token);
  if (!admin || !admin.is_admin) return res.status(403).json({ error: 'FORBIDDEN' });

  const { phone } = req.query;

  if (phone) {
    const { rows } = await db.query(
      `SELECT event_type, sku, detail, created_at FROM behavior_events
       WHERE phone = $1 ORDER BY created_at DESC LIMIT 200`,
      [phone.replace(/[^0-9]/g, '')]
    );
    return res.json({ phone, events: rows });
  }

  const { rows } = await db.query(`
    SELECT sku, event_type, count(*) AS n
    FROM behavior_events
    WHERE sku IS NOT NULL AND created_at > now() - interval '30 days'
    GROUP BY sku, event_type
    ORDER BY n DESC
    LIMIT 50
  `);
  const { rows: activeUsers } = await db.query(`
    SELECT phone, count(*) AS events, max(created_at) AS last_seen
    FROM behavior_events
    WHERE phone IS NOT NULL AND created_at > now() - interval '30 days'
    GROUP BY phone ORDER BY events DESC LIMIT 50
  `);

  const { rows: byRep } = await db.query(`
    SELECT rep_name, count(*) AS order_count, COALESCE(sum(total), 0) AS total_sales
    FROM orders
    WHERE rep_name IS NOT NULL AND rep_name <> ''
    GROUP BY rep_name
    ORDER BY total_sales DESC
  `);
  const salesByRep = byRep.map(r => ({
    repName: r.rep_name,
    orderCount: Number(r.order_count),
    totalSales: Number(r.total_sales),
    incentive: Math.round(Number(r.total_sales) * 0.05 * 100) / 100, // 5% 인센티브
  }));

  return res.json({ topSkus: rows, activeUsers, salesByRep });
};
