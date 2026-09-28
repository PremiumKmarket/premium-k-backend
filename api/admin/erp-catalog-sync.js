// api/admin/erp-catalog-sync.js  v1.1
// 관리자가 마지막 연동 상태를 확인하거나, 1차 동기화(박스가·입수만)를 실행한다.
//   GET  : 마지막 연동 시각·결과 조회
//   POST : 1차 동기화 실행 — ERP_CATALOG_SYNC_MODE=phase1 설정이 있을 때만 (없으면 423)
//          body { force: true } 면 지문이 같아도 다시 계산
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
      // 이중 잠금 — 운영에서 1차 정책을 켜기 전에는 관리자 창구로도 실행되지 않는다
      if (process.env.ERP_CATALOG_SYNC_MODE !== 'phase1') {
        return res.status(423).json({ ok: false, error: '동기화가 잠겨 있습니다 (ERP_CATALOG_SYNC_MODE 미설정).' });
      }
      const result = await syncCatalogFromErp({ force: req.body?.force === true });
      return res.json({ ok: true, ...result });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[erp-catalog-sync] 실패:', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
};
