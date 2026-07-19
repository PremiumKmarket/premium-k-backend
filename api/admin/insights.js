// api/admin/insights.js
// GET /api/admin/insights?phone=... -> recent behavior events for one customer
// GET /api/admin/insights -> most-viewed / most-added products across everyone (last 30 days)

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
    SELECT COALESCE(p.name_ko, be.sku) AS product_name, be.sku, be.event_type, count(*) AS n
    FROM behavior_events be
    LEFT JOIN products p ON p.sku = be.sku
    WHERE be.sku IS NOT NULL AND be.created_at > now() - interval '30 days'
    GROUP BY p.name_ko, be.sku, be.event_type
    ORDER BY n DESC
    LIMIT 50
  `);
  const { rows: activeUsers } = await db.query(`
    SELECT phone, count(*) AS events, max(created_at) AS last_seen,
           RANK() OVER (ORDER BY count(*) DESC) AS activity_rank
    FROM behavior_events
    WHERE phone IS NOT NULL AND created_at > now() - interval '30 days'
    GROUP BY phone
    ORDER BY last_seen DESC
    LIMIT 50
  `);

  // 영업사원(rep_name)별 · 월별 매출 집계 + 5% 인센티브 계산
  const { rows: byRepMonth } = await db.query(`
    SELECT rep_name,
           to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
           count(*) AS order_count,
           COALESCE(sum(total), 0) AS total_sales
    FROM orders
    WHERE rep_name IS NOT NULL AND rep_name <> ''
    GROUP BY rep_name, month
    ORDER BY month DESC, total_sales DESC
  `);
  const salesByRepMonth = byRepMonth.map(r => ({
    repName: r.rep_name,
    month: r.month,
    orderCount: Number(r.order_count),
    totalSales: Number(r.total_sales),
    incentive: Math.round(Number(r.total_sales) * 0.05 * 100) / 100, // 주문 총액의 5% 인센티브
  }));

  return res.json({ topSkus: rows, activeUsers, salesByRepMonth });
};
