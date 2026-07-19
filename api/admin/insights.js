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

  // 인기 상품별로 실제 조회/장바구니에 담은 고객 목록 (관리자 화면에서 "전체보기"용)
  const { rows: topSkuViewersRaw } = await db.query(`
    SELECT sku, event_type, phone, max(created_at) AS last_interacted
    FROM behavior_events
    WHERE sku IS NOT NULL AND phone IS NOT NULL AND created_at > now() - interval '30 days'
    GROUP BY sku, event_type, phone
    ORDER BY sku, event_type, last_interacted DESC
  `);
  const topSkuViewers = topSkuViewersRaw.map(r => ({
    sku: r.sku,
    eventType: r.event_type,
    phone: r.phone,
    lastInteracted: r.last_interacted,
  }));

  // 휴면 고객: 승인된 고객인데 behavior_events 기록이 30일 넘게 없는 경우
  // (한 번도 활동 기록이 없는 경우도 포함 — last_seen이 null)
  const { rows: dormantCustomers } = await db.query(`
    WITH last_activity AS (
      SELECT phone, max(created_at) AS last_seen
      FROM behavior_events
      GROUP BY phone
    )
    SELECT u.phone, u.company_name, u.created_at AS joined_at, la.last_seen
    FROM users u
    LEFT JOIN last_activity la ON la.phone = u.phone
    WHERE u.approved = true
      AND (la.last_seen IS NULL OR la.last_seen < now() - interval '30 days')
    ORDER BY la.last_seen ASC NULLS FIRST
    LIMIT 100
  `);

  // 고객별 총 구매액 랭킹 (전체 기간 누적)
  const { rows: customerRanking } = await db.query(`
    SELECT phone, max(customer_name) AS customer_name,
           count(*) AS order_count, COALESCE(sum(total), 0) AS total_spent
    FROM orders
    WHERE phone IS NOT NULL
    GROUP BY phone
    ORDER BY total_spent DESC
    LIMIT 100
  `);

  // 월별 매출 추이 (최근 12개월)
  const { rows: monthlyRevenueRaw } = await db.query(`
    SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
           count(*) AS order_count,
           COALESCE(sum(total), 0) AS total_sales
    FROM orders
    WHERE created_at > now() - interval '12 months'
    GROUP BY month
    ORDER BY month ASC
  `);
  const monthlyRevenue = monthlyRevenueRaw.map(r => ({
    month: r.month,
    orderCount: Number(r.order_count),
    totalSales: Number(r.total_sales),
  }));

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

  return res.json({ topSkus: rows, topSkuViewers, activeUsers, salesByRepMonth, dormantCustomers, customerRanking, monthlyRevenue });
};
