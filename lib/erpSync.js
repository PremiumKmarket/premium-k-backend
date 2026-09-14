// lib/erpSync.js
//
// Premium K Backend → Tronic ERP Server-to-Server 주문 전달.
//
// 이전 구조(폐기 대상): 브라우저(Site_Order.html)가 ERP를 직접 호출하면서
//   - ERP Sync Key가 정적 HTML에 그대로 노출되고
//   - 브라우저가 주장하는 premiumKUserId를 ERP가 그대로 신뢰했음
// 새 구조: 이 서버가 (1) 자기 세션에서 실제로 확인한 로그인 사용자 ID와
// (2) 서버에서 이미 재계산·저장한 canonical 주문(orders row)만을 근거로,
// 서버간 전용 secret으로 ERP에 전달합니다. 브라우저가 보낸 가격/총액/사용자ID는
// 이 경로에 전혀 들어가지 않습니다.
//
// Secret 취급: PREMIUM_K_SERVER_SECRET은 이 서버와 ERP 서버의 환경변수에만 존재.
// 이 파일은 그 값을 로그/응답/에러메시지에 절대 포함하지 않습니다.
//
// 고객 주문과 ERP 전달의 분리: 전달 실패는 고객 주문 실패가 아닙니다. 실패하면
// orders.erp_sync_status=FAILED로 기록만 하고, 같은 order.id로 안전하게 재시도
// 가능합니다(ERP 쪽이 (source_system, source_order_id) 멱등성을 보장하므로 중복
// 생성 없음).
const fetch = require('node-fetch');
const db = require('./db');

const ERP_BASE = process.env.TRONIC_ERP_BASE_URL; // 예: https://tronic-erp2-production.up.railway.app
const SECRET = process.env.PREMIUM_K_SERVER_SECRET;
const TIMEOUT_MS = 8000;

// ⚠️ 2026-09-12 (보안 검토 요청 반영) — erp_last_error는 관리자 화면(GET /api/admin/erp-sync)에
// 그대로 노출되는 값이라, 저장 전에 민감정보로 보일 수 있는 패턴을 전부 걷어냅니다:
// Authorization 헤더 값, 우리 secret 자체, DB 연결문자열(자격증명 포함 URL), 쿼리스트링의
// token/password/secret/key 파라미터. node-fetch의 네트워크 에러 메시지나 ERP 응답 바디에
// 이런 값이 실수로라도 섞여 들어오는 걸 막기 위한 방어적 조치입니다(정상 상황에서는 이 값들이
// 애초에 에러 메시지에 나타나지 않지만, 나중에 로직이 바뀌어도 안전하도록 저장 시점에 한 번 더 거릅니다).
function sanitizeErrorMessage(raw) {
  if (!raw) return raw;
  let s = String(raw);
  if (SECRET) s = s.split(SECRET).join('[REDACTED]');
  s = s.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
  s = s.replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, '$1[REDACTED]@');
  s = s.replace(/([?&](?:token|password|passwd|secret|key|api_key|apikey)=)[^&\s]+/gi, '$1[REDACTED]');
  s = s.replace(/x-premium-k-server-secret['":\s]*[A-Za-z0-9._-]+/gi, 'x-premium-k-server-secret: [REDACTED]');
  return s.slice(0, 500);
}

function buildPayload(order, user) {
  // orders.items는 repriceItems()가 서버에서 재계산해 저장한 canonical 데이터
  const items = Array.isArray(order.items) ? order.items : JSON.parse(order.items || '[]');
  return {
    sourceOrderId: String(order.id),          // Premium K의 실제 canonical order ID
    externalUserId: String(order.user_id),    // 세션에서 확인된 사용자 ID(주문 저장 시점의 user_id)
    invoiceNumber: order.invoice_number || null,
    phone: order.phone || null,
    customerName: order.customer_name || user?.company_name || '',
    address: order.address || null,
    repName: order.rep_name || null,
    deliveryMethod: order.delivery_method || null,
    paymentMethod: order.payment_method || null,
    items,
    total: order.total,
    orderText: order.order_text || null,
  };
}

async function markAttempt(orderId, status, siteOrderId, errorMsg) {
  await db.query(
    `UPDATE orders SET erp_sync_status = $1, erp_site_order_id = COALESCE($2, erp_site_order_id),
       erp_last_attempt_at = now(), erp_retry_count = COALESCE(erp_retry_count, 0) + 1, erp_last_error = $3
     WHERE id = $4`,
    [status, siteOrderId || null, sanitizeErrorMessage(errorMsg), orderId]
  );
}

/**
 * 주어진 order.id의 주문을 ERP로 전달합니다. 반환: { status, siteOrderId?, error? }
 * 이 함수는 절대 throw하지 않습니다 — 호출자(주문 생성)가 ERP 사정으로 실패하면 안 되므로.
 */
async function syncOrderToErp(orderId) {
  if (!ERP_BASE || !SECRET) {
    await markAttempt(orderId, 'FAILED', null, 'ERP sync not configured (TRONIC_ERP_BASE_URL / PREMIUM_K_SERVER_SECRET missing)');
    return { status: 'FAILED', error: 'not configured' };
  }
  let order, user;
  try {
    const { rows } = await db.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
    order = rows[0];
    if (!order) return { status: 'FAILED', error: 'order not found' };
    const u = await db.query(`SELECT id, company_name FROM users WHERE id = $1`, [order.user_id]);
    user = u.rows[0];
  } catch (e) {
    return { status: 'FAILED', error: 'db read failed' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${ERP_BASE}/api/site-orders/incoming-verified`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-premium-k-server-secret': SECRET },
      body: JSON.stringify(buildPayload(order, user)),
      signal: controller.signal,
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}

    if (resp.ok && json && json.ok) {
      await markAttempt(orderId, 'SYNCED', json.id, null);
      return { status: 'SYNCED', siteOrderId: json.id, deduplicated: !!json.deduplicated };
    }
    // 409(같은 order ID에 다른 내용)는 재시도해도 해결되지 않는 상태 — FAILED로 남기고 사람이 확인
    const msg = `ERP responded ${resp.status}: ${(json && json.error) || text.slice(0, 200)}`;
    await markAttempt(orderId, 'FAILED', null, msg);
    return { status: 'FAILED', error: msg, httpStatus: resp.status };
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'ERP timeout' : `ERP unreachable: ${e.message}`;
    await markAttempt(orderId, 'FAILED', null, msg);
    return { status: 'FAILED', error: msg };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { syncOrderToErp };
