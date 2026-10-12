-- migrations/009_staff_accounts_and_credit.sql
-- 직원 계정(휴대폰 번호 로그인, 첫 로그인 비밀번호 변경) + 직원 월 크레딧($100) 구조 추가.
-- 구조(컬럼·색인)만 추가합니다. 기존 데이터는 바꾸지 않습니다 (DELETE/UPDATE/TRUNCATE 없음).
-- 여러 번 실행해도 안전합니다 (IF NOT EXISTS).
-- 실행 위치: Site Order DB (premium-k-backend가 쓰는 Neon DB)의 SQL Editor.

BEGIN;

-- 직원 계정 표시 / 첫 로그인 비밀번호 변경 필요 여부 / ERP 직원 번호(중복 생성 방지용)
ALTER TABLE users  ADD COLUMN IF NOT EXISTS is_staff             BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users  ADD COLUMN IF NOT EXISTS erp_staff_id         TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_erp_staff_id ON users (erp_staff_id) WHERE erp_staff_id IS NOT NULL;

-- 주문별 직원 크레딧 사용액 / 실제 결제할 금액 (기존 주문은 NULL → total 그대로 사용)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS staff_credit_applied NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS amount_due           NUMERIC(10,2);
CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders (user_id, created_at);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_staff_credit_nonneg') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_staff_credit_nonneg CHECK (staff_credit_applied >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_amount_due_nonneg') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_amount_due_nonneg CHECK (amount_due IS NULL OR amount_due >= 0);
  END IF;
END $$;

COMMIT;

-- 확인 (결과가 7줄이면 정상)
SELECT table_name, column_name, data_type FROM information_schema.columns
 WHERE (table_name = 'users'  AND column_name IN ('is_staff','must_change_password','erp_staff_id'))
    OR (table_name = 'orders' AND column_name IN ('staff_credit_applied','amount_due'))
UNION ALL
SELECT 'index', indexname, '' FROM pg_indexes WHERE indexname IN ('uq_users_erp_staff_id','idx_orders_user_created')
ORDER BY 1, 2;
