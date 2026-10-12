// lib/staffCredit.js
// 직원 월 크레딧 — 매달 1일(LA 시간)에 STAFF_MONTHLY_CREDIT(기본 $100)으로 새로 시작.
// 남은 금액은 이월하지 않음. 별도 적립 작업(크론) 없이, "이번 달 주문들에 쓴 크레딧 합계"로
// 남은 금액을 계산하므로 1일이 되면 자동으로 다시 $100이 됩니다.
// 주문이 삭제되면 그 주문에 쓴 크레딧도 자동으로 돌아옵니다.

const TZ = 'America/Los_Angeles';

function monthlyAmount() {
  const v = Number(process.env.STAFF_MONTHLY_CREDIT);
  return Number.isFinite(v) && v >= 0 ? v : 100;
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }

// q: db 또는 트랜잭션 client (둘 다 .query 제공)
async function creditStatus(q, userId) {
  const { rows } = await q.query(
    `SELECT COALESCE(SUM(staff_credit_applied), 0)::numeric AS used,
            to_char(date_trunc('month', now() AT TIME ZONE '${TZ}'), 'YYYY-MM') AS month
       FROM orders
      WHERE user_id = $1
        AND created_at >= (date_trunc('month', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}')`,
    [userId]
  );
  const monthly = monthlyAmount();
  const used = round2(rows[0].used);
  return { month: rows[0].month, monthly, used, remaining: Math.max(0, round2(monthly - used)) };
}

module.exports = { creditStatus, monthlyAmount, round2, TZ };
