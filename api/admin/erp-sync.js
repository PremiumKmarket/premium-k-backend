// api/admin/erp-sync.js
//
// 관리자가 Premium K 주문의 ERP 전달 상태를 조회하는 화면용 API. ERP 전달 실패가
// 아무도 모르게 조용히 묻히지 않도록(요청받아 추가) FAILED/PENDING 건을 목록으로
// 보여줍니다. 이 API는 조회만 합니다 — 재시도는 기존 POST /api/orders?action=retry-erp
// 를 관리자가 그대로 호출하면 됩니다(admin은 소유자 확인 없이 통과하도록 이미 되어있음).
//
// GET /api/admin/erp-sync?status=FAILED  (status 생략시 FAILED+PENDING 전체)
const db = require('../../lib/db');
const { getUserFromToken, getBearerToken } = require('../../lib/auth');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function requireAdmin(req) {
  const token = getBearerToken(req);
  if (!token) return { error: 401, message: '로그인이 필요합니다.' };
  const user = await getUserFromToken(token);
  if (!user) return { error: 401, message: '로그인이 필요합니다.' };
  if (!user.is_admin) return { error: 403, message: '관리자만 접근할 수 있습니다.' };
  return { user };
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const authResult = await requireAdmin(req);
  if (authResult.error) return res.status(authResult.error).json({ error: authResult.error === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', message: authResult.message });
  const admin = authResult.user;

  const status = req.query.status;
  // PREMIUM_K_ERP_SYNC_STALE: 시도는 했으나(erp_sync_status가 있음) 24시간 넘게 SYNCED가 안 된 건도 함께 표시
  const params = [];
  let where = `erp_sync_status IS NOT NULL AND erp_sync_status <> 'SYNCED'`;
  if (status === 'FAILED' || status === 'PENDING') { where += ` AND erp_sync_status = $1`; params.push(status); }

  const { rows } = await db.query(
    `SELECT id AS order_id, user_id, invoice_number, erp_sync_status, erp_site_order_id,
            erp_retry_count, erp_last_attempt_at, erp_last_error, created_at,
            (erp_last_attempt_at < now() - interval '24 hours') AS is_stale
     FROM orders
     WHERE ${where}
     ORDER BY erp_last_attempt_at DESC NULLS LAST
     LIMIT 200`,
    params
  );

  res.json({
    checks: {
      PREMIUM_K_ERP_SYNC_FAILED: rows.filter((r) => r.erp_sync_status === 'FAILED').length,
      PREMIUM_K_ERP_SYNC_STALE: rows.filter((r) => r.is_stale).length,
    },
    orders: rows,
    retryInstructions: 'POST /api/orders?action=retry-erp  body: { "orderId": <order_id> }  (관리자 토큰으로 호출)',
  });
};
