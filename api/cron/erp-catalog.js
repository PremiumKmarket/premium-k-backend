// api/cron/erp-catalog.js  v1.1 — ERP 상품 동기화 (예약 실행용)
//  · 이중 잠금: ① CRON_SECRET 인증 ② ERP_CATALOG_SYNC_MODE=phase1 설정이 있어야만 실행
//    설정이 없으면 아무것도 하지 않는다(1차 정책이 운영에서 검증될 때까지 자동 실행을 막는다).
//  · 1차 정책: 기존 SKU의 박스가·입수만 갱신. 낱개가·이름·분류·규격·사진·주소·옵션 변경 없음, 신규 추가·숨김 없음, TOGO 수정 없음.
//  · vercel.json 에서 예약 실행(crons) 자체를 빼 두었다. 이 파일은 켤 때를 대비한 것이다.
const { syncCatalogFromErp } = require('../../lib/erpCatalog');

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  if (process.env.ERP_CATALOG_SYNC_MODE !== 'phase1') {
    return res.json({ ok: true, skipped: true, reason: 'ERP_CATALOG_SYNC_MODE 가 phase1 이 아니라 실행하지 않음' });
  }
  try {
    const result = await syncCatalogFromErp({ force: req.query.force === '1' });
    console.log('[erp-catalog] 1차 동기화 결과', result);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[erp-catalog] 실패:', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
};
