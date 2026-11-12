// lib/orderCancel.js — v8.10 (2026-11) 주문 취소
//
// ERP "신규주문알림"에서 주문을 취소하면 ERP 서버가 서버 간 비밀키로 여기를 부른다(api/orders.js ?action=cancel).
//  · 주문 행은 지우지 않고 status='cancelled' 로 표시한다(취소 시각·사유·누가 취소했는지 남김).
//  · 직원 크레딧: 이 주문에 쓴 크레딧을 cancelled_credit 에 옮겨 적고 staff_credit_applied 는 0 으로 —
//    이번 달 남은 크레딧은 "이번 달 주문들에 쓴 크레딧 합계"로 계산하므로(lib/staffCredit.js) 이번 달 주문이면 자동으로 돌아온다.
//    (지난달 주문이면 지난달 사용액만 줄고 이번 달 남은 크레딧은 그대로 — creditThisMonth 로 구분해 알려 준다)
//  · 결제할 금액(amount_due)은 0 — 취소된 주문으로는 결제 링크를 새로 만들지 않는다(api/create-checkout.js).
//  · 이미 만든 카드 결제 링크(샵 Draft Order, 이 주문 표시가 붙은 것만): 결제 전이면 지우고, 결제됐으면 알려 준다(lib/shopifyAdmin.js).
//  · 칸은 migrations/010_order_cancel.sql 로 배포 전에 만든다. 여기서는 표를 바꾸지 않고 칸이 있는지만 확인한다.
//  · 다른 코드는 status 칸이 없어도 동작하도록 to_jsonb(orders.*) ->> 'status' 로 읽는다.
const { TZ } = require('./staffCredit');
const { closeOrderPaymentLinks } = require('./shopifyAdmin');

const COLS = ['status', 'cancelled_at', 'cancel_reason', 'cancel_note', 'cancelled_by', 'cancelled_credit'];
const REASONS = ['customer_request', 'out_of_stock', 'duplicate', 'other'];
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// SQL 안에서 "취소되지 않은 주문" — status 칸이 없어도 동작
const NOT_CANCELLED = (alias = 'orders') => `COALESCE(to_jsonb(${alias}.*) ->> 'status', 'active') <> 'cancelled'`;

let columnsReady = false;
// 읽기만 한다. 칸이 없으면 SCHEMA_NOT_READY (010 마이그레이션을 아직 안 돌린 것).
async function cancelColumnsReady(q) {
  if (columnsReady) return true;
  const { rows } = await q(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'orders'`);
  const have = new Set(rows.map((r) => r.column_name));
  columnsReady = COLS.every((c) => have.has(c));
  return columnsReady;
}

/**
 * orderId(주문 사이트 주문 번호, UUID)로 찾아 취소한다.
 * @returns {Promise<{ok:true, alreadyCancelled:boolean, creditReturned:number, creditThisMonth:boolean, invoiceNumber:string|null, shop:object}
 *                  | {error:string, status:number, message:string}>}
 */
async function cancelOrder(db, { orderId, reason, note, by }) {
  // 주문 사이트 주문 번호(UUID)로만 찾는다 — 인보이스 번호는 고객 화면이 정해 보낼 수 있어 믿지 않는다
  const id = typeof orderId === 'string' && UUID_RE.test(orderId) ? orderId.toLowerCase() : null;
  if (!id) return { status: 400, error: 'INVALID_ORDER_ID', message: '주문 번호가 올바르지 않습니다.' };
  if (typeof reason !== 'string' || !REASONS.includes(reason)) return { status: 400, error: 'INVALID_REASON', message: '취소 사유가 올바르지 않습니다.' };
  if (!(await cancelColumnsReady(db.query))) {
    return { status: 503, error: 'SCHEMA_NOT_READY', message: '주문 사이트 DB에 취소 칸이 아직 없습니다(010 마이그레이션 필요).' };
  }
  const client = await db.pool.connect();
  let row;
  let result;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, invoice_number, status, staff_credit_applied, created_at, payment_method,
              to_jsonb(orders.*) ->> 'checkout_url' AS checkout_url,
              created_at >= (date_trunc('month', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}') AS this_month
         FROM orders WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows.length) { await client.query('ROLLBACK'); return { status: 404, error: 'ORDER_NOT_FOUND', message: '주문 사이트에 이 주문이 없습니다.' }; }
    row = rows[0];
    if (row.status === 'cancelled') {
      await client.query('ROLLBACK');
      result = { ok: true, alreadyCancelled: true, creditReturned: 0, creditThisMonth: false, invoiceNumber: row.invoice_number || null };
    } else {
      const credit = Math.round((Number(row.staff_credit_applied) || 0) * 100) / 100;
      await client.query(
        `UPDATE orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2, cancel_note = $3, cancelled_by = $4,
                cancelled_credit = $5, staff_credit_applied = 0, amount_due = 0
          WHERE id = $1`,
        [row.id, reason, note ? String(note).slice(0, 500) : null, String(by || '').slice(0, 120) || null, credit]
      );
      await client.query('COMMIT');
      result = { ok: true, alreadyCancelled: false, creditReturned: credit, creditThisMonth: !!row.this_month, invoiceNumber: row.invoice_number || null };
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  // 취소가 끝난 뒤(다시 반영 때도) 카드 결제 링크 정리 — 결제 전 링크는 지우고, 결제된 것은 알려 준다
  //  · 결제 링크는 이 주문 표시(태그)로만 찾는다. 카드 주문이거나 링크를 만든 기록이 있으면 찾아본다.
  result.shop = await closeOrderPaymentLinks({ orderId: row.id, check: !!row.checkout_url || row.payment_method === 'card' });
  return result;
}

module.exports = { cancelOrder, cancelColumnsReady, NOT_CANCELLED, REASONS };
