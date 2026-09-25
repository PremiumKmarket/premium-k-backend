// api/cron/erp-catalog.js
// v1.0 — ERP 상품·가격을 주기적으로 받아온다 (Vercel Cron이 호출).
//  · 인증: Vercel Cron이 보내는 Authorization: Bearer <CRON_SECRET> 헤더.
//    설정이 없으면 아무나 호출할 수 있으므로, CRON_SECRET이 없으면 실행하지 않는다.
//  · 관리자 수동 실행은 POST /api/admin/erp-catalog-sync 를 쓴다.
const { syncCatalogFromErp } = require('../../lib/erpCatalog');

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  try {
    const result = await syncCatalogFromErp({ full: req.query.full === '1' });
    console.log('[erp-catalog] 동기화 결과', result);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[erp-catalog] 실패:', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
};
