-- migrations/010_order_cancel.sql
-- v8.10 주문 취소 (ERP 신규주문알림의 "주문 취소"가 여기 표시를 남긴다).
-- 구조(빈 칸 6개)만 추가합니다. 기존 데이터는 바꾸지 않습니다 (DELETE/UPDATE/TRUNCATE 없음).
--  · 모두 비어 있어도 되는 칸(NULL 허용, 기본값 없음) → 표를 다시 쓰지 않고 바로 끝납니다.
--  · 다른 작업이 orders 표를 잡고 있으면 3초만 기다리고 포기합니다(주문 화면이 멈추지 않게). 그때는 잠시 후 다시 실행.
-- 여러 번 실행해도 안전합니다 (IF NOT EXISTS).
-- 실행 위치: Site Order DB (premium-k-backend가 쓰는 Neon DB). 이 배포 "전에" 실행.

BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE orders ADD COLUMN IF NOT EXISTS status           VARCHAR(20);   -- NULL = 정상, 'cancelled' = 취소
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at     TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason    VARCHAR(40);   -- customer_request · out_of_stock · duplicate · other
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_note      TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_by     VARCHAR(120);  -- 'ERP:<사용자번호> <이름>' 또는 'site:<관리자>'
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_credit NUMERIC(10,2);  -- 취소 때 돌려준 직원 크레딧

COMMIT;

-- 확인 (결과가 6줄이면 정상)
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema = current_schema() AND table_name = 'orders'
   AND column_name IN ('status','cancelled_at','cancel_reason','cancel_note','cancelled_by','cancelled_credit')
 ORDER BY 1;
