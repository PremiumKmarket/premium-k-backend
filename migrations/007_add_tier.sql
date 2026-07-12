-- migrations/007_add_tier.sql
-- 고객 등급(Tier) 시스템 추가.
-- Tier 1: 월매출 $20,000 이상 홀세일러 — 기존 가격 그대로
-- Tier 2: 식당/마켓 등 월매출 $2,000~$20,000 — 기존 가격 +10%
-- Tier 3: 소상공인/샵인샵 등 월매출 $2,000 이하 — 기존 가격 +15%
-- 신규 가입자는 승인 전까지는 의미 없지만, 기본값은 tier3로 시작하고
-- 관리자가 승인할 때 원하는 등급으로 바꿀 수 있습니다.
-- Run this once in Neon's Query tab.

ALTER TABLE users ADD COLUMN IF NOT EXISTS tier VARCHAR(10) NOT NULL DEFAULT 'tier3';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_tier_check;
ALTER TABLE users ADD CONSTRAINT users_tier_check CHECK (tier IN ('tier1', 'tier2', 'tier3'));

CREATE INDEX IF NOT EXISTS idx_users_tier ON users(tier);

-- 참고: 이 컬럼을 추가하면 기존 승인 고객들도 기본값인 tier3로 채워집니다.
-- James님 요청에 따라 자동 백필은 하지 않았습니다 — 기존 고객 수가 많지 않아
-- admin.html 회원목록에서 각자 등급 드롭다운으로 직접 Tier 1로 바꿔주시면 됩니다.
-- (원한다면 아래 문장 주석을 풀고 실행하면 승인된 고객 전체를 한 번에 Tier 1로
--  일괄 변경할 수도 있습니다)
-- UPDATE users SET tier = 'tier1' WHERE approved = true;
