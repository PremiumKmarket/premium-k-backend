// scripts/migrate-erp-sync-status.js
//
// orders 테이블에 ERP Server-to-Server 동기화 상태 추적 컬럼을 추가합니다.
// 고객 주문 자체(orders row)와 ERP 전달은 분리된 작업입니다 — ERP가 잠시 응답하지
// 않아도 고객 주문은 그대로 보존되고, 아래 상태로 재시도 여부를 서버가 추적합니다.
//   erp_sync_status: PENDING | SYNCED | FAILED
//   erp_site_order_id: 성공 시 ERP가 돌려준 site_orders.id
//   erp_last_attempt_at / erp_retry_count / erp_last_error: 재시도 판단·문제 추적용
// 브라우저 localStorage는 Retry의 Source of Truth가 아닙니다 — 서버 DB만 기준입니다.
// 여러 번 실행해도 안전합니다.
//
// 실행: POSTGRES_URL="<Vercel 실제 접속 문자열>" node scripts/migrate-erp-sync-status.js

const { Pool } = require('pg');

async function run() {
  if (!process.env.POSTGRES_URL) {
    console.error('❌ POSTGRES_URL 환경변수가 없습니다.');
    process.exit(1);
  }
  const url = process.env.POSTGRES_URL;
  const pool = new Pool({ connectionString: url, ssl: url.includes('sslmode=disable') ? false : { rejectUnauthorized: false } });
  try {
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS erp_sync_status VARCHAR(20)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS erp_site_order_id INTEGER`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS erp_last_attempt_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS erp_retry_count INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS erp_last_error TEXT`);
    console.log('✅ orders ERP 동기화 상태 컬럼 추가 완료');
  } catch (err) {
    console.error('❌ 오류:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
