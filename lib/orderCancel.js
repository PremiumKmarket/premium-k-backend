// lib/orderCancel.js — v8.10 (2026-11) 주문 취소
//
// ERP "신규주문알림"에서 주문을 취소하면 ERP 서버가 서버 간 비밀키로 여기를 부른다(api/orders.js ?action=cancel).
//  · 주문 행은 지우지 않고 status='cancelled' 로 표시한다(취소 시각·사유·누가 취소했는지 남김).
//  · 직원 크레딧: 이 주문에 쓴 크레딧을 cancelled_credit 에 옮겨 적고 staff_credit_applied 는 0 으로 —
//    이번 달 남은 크레딧은 "이번 달 주문들에 쓴 크레딧 합계"로 계산하므로(lib/staffCredit.js) 자동으로 돌아온다.
//  · 결제할 금액(amount_due)은 0 — 취소된 주문으로는 카드 결제 페이지를 만들지 않는다(api/create-checkout.js).
//  · 칸이 아직 없으면(첫 취소) 그 자리에서 더한다 — 없는 칸만, 기존 주문은 status 'active' 로 채워진다.
//  · 다른 코드는 status 칸이 없어도 동작하도록 to_jsonb(orders.*) ->> 'status' 로 읽는다.
const COLS = [
  ['status', "VARCHAR(20) NOT NULL DEFAULT 'active'"],
  ['cancelled_at', 'TIMESTAMPTZ'],
  ['cancel_reason', 'VARCHAR(40)'],
  ['cancel_note', 'TEXT'],
  ['cancelled_by', 'VARCHAR(120)'],
  ['cancelled_credit', 'NUMERIC(10,2)'],
];
const REASONS = ['customer_request', 'out_of_stock', 'duplicate', 'other'];
const ID_RE = /^([0-9]{1,18}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

// SQL 안에서 "취소되지 않은 주문" — status 칸이 없어도(아직 취소가 한 번도 없었을 때) 동작
const NOT_CANCELLED = (alias = 'orders') => `COALESCE(to_jsonb(${alias}.*) ->> 'status', 'active') <> 'cancelled'`;

async function ensureCancelColumns(q) {
  const { rows } = await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'orders'`);
  const have = new Set(rows.map((r) => r.column_name));
  const missing = COLS.filter(([c]) => !have.has(c));
  for (const [c, type] of missing) await q(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ${c} ${type}`);
  return missing.map(([c]) => c);
}

/**
 * @returns {Promise<{ok:true, alreadyCancelled:boolean, creditReturned:number, invoiceNumber:string|null} | {error:string, status:number, message:string}>}
 */
async function cancelOrder(db, { orderId, reason, note, by }) {
  if (!ID_RE.test(String(orderId || ''))) return { status: 400, error: 'INVALID_ORDER_ID', message: '주문 번호가 올바르지 않습니다.' };
  if (!REASONS.includes(reason)) return { status: 400, error: 'INVALID_REASON', message: '취소 사유가 올바르지 않습니다.' };
  await ensureCancelColumns(db.query);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, invoice_number, status, staff_credit_applied, cancelled_credit FROM orders WHERE id = $1 FOR UPDATE', [String(orderId)]);
    if (!rows[0]) { await client.query('ROLLBACK'); return { status: 404, error: 'ORDER_NOT_FOUND', message: '주문 사이트에 이 주문이 없습니다.' }; }
    if (rows[0].status === 'cancelled') {
      await client.query('ROLLBACK');
      return { ok: true, alreadyCancelled: true, creditReturned: 0, invoiceNumber: rows[0].invoice_number || null };
    }
    const credit = Math.round((Number(rows[0].staff_credit_applied) || 0) * 100) / 100;
    await client.query(
      `UPDATE orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2, cancel_note = $3, cancelled_by = $4,
              cancelled_credit = $5, staff_credit_applied = 0, amount_due = 0
        WHERE id = $1`,
      [String(orderId), reason, note ? String(note).slice(0, 500) : null, String(by || '').slice(0, 120) || null, credit]
    );
    await client.query('COMMIT');
    return { ok: true, alreadyCancelled: false, creditReturned: credit, invoiceNumber: rows[0].invoice_number || null };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { cancelOrder, ensureCancelColumns, NOT_CANCELLED, REASONS };
