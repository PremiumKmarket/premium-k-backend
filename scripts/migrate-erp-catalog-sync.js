// scripts/migrate-erp-catalog-sync.js
// v1.0 — ERP 상품 연동 준비 (Tronic ERP를 상품·가격의 단일 기준으로 삼기 위한 준비)
//  · products.hidden       : ERP에서 노출 해제·판매중지된 상품을 "숨김" 처리한다.
//                            지우지 않는 이유 — 사진·상세페이지 주소·옵션 등 Site Order에서만 관리하는 값이 사라지면
//                            나중에 다시 노출할 때 복구할 수 없다.
//  · products.erp_synced_at: ERP에서 마지막으로 받아온 시각(관리자 화면에서 확인용)
//  · erp_catalog_sync      : 어디까지 받아왔는지 기억하는 표(다음에는 그 이후 바뀐 것만 받는다)
//  실행:  POSTGRES_URL=... node scripts/migrate-erp-catalog-sync.js
//  여러 번 실행해도 안전하다.
const db = require('../lib/db');

(async () => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS erp_synced_at TIMESTAMPTZ`);
    await client.query(`CREATE INDEX IF NOT EXISTS products_hidden_idx ON products (hidden) WHERE hidden = FALSE`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS erp_catalog_sync (
        id              INTEGER PRIMARY KEY DEFAULT 1,
        last_change_at  TEXT,          -- ERP가 알려준 "마지막 변경 시각" (다음 요청에 그대로 되돌려준다)
        last_fingerprint TEXT,         -- 상품 목록 지문 — 같으면 바뀐 것이 없다는 뜻
        last_run_at     TIMESTAMPTZ,
        last_result     TEXT,
        CONSTRAINT erp_catalog_sync_single_row CHECK (id = 1)
      )`);
    await client.query(`INSERT INTO erp_catalog_sync (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    await client.query('COMMIT');
    const c = await db.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE hidden)::int AS hidden FROM products`);
    console.log('✅ ERP 상품 연동 준비 완료');
    console.log(`   현재 상품 ${c.rows[0].n}개 (숨김 ${c.rows[0].hidden}개)`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('⛔ 중단 — 아무것도 바뀌지 않았습니다:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.pool.end();
  }
})();
