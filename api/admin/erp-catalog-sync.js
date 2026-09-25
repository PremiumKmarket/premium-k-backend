// api/admin/erp-catalog-sync.js
// v1.0 — 관리자가 ERP 상품·가격을 지금 바로 받아오거나, 마지막 연동 상태를 확인한다.
//   GET  : 마지막 연동 시각·결과 조회
//   POST : 지금 받아오기 ( body { full: true } 면 전체 다시 받기 )
const db = require('../../lib/db');
const { getUserFromToken, getBearerToken } = require('../../lib/auth');
const { syncCatalogFromErp, readState } = require('../../lib/erpCatalog');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = getBearerToken(req);
  const user = token ? await getUserFromToken(token) : null;
  if (!user) return res.status(401).json({ error: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
  if (!user.is_admin) return res.status(403).json({ error: 'FORBIDDEN', message: '관리자만 사용할 수 있습니다.' });

  try {
    if (req.method === 'GET') {
      const state = await readState();
      const { rows } = await db.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE hidden)::int AS hidden,
                max(erp_synced_at) AS last_product_sync
           FROM products`);
      return res.json({ state, products: rows[0] });
    }
    if (req.method === 'POST') {
      const result = await syncCatalogFromErp({ full: req.body?.full === true });
      return res.json({ ok: true, ...result });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[erp-catalog-sync] 실패:', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
};
