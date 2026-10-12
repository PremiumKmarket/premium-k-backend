// lib/erpOrders.js
//
// Site Order 주문 → Tronic ERP "신규주문알림(Site Order)" 전달 (서버 간 비밀키).
//  · 새 주문: 주문 저장 직후 바로 보냄 (api/orders.js). 실패해도 고객 주문은 그대로 성공 — 나중에 "점검·재전송"으로 다시 보냄.
//  · 점검·재전송: ERP에 아직 없는 주문을 찾아 보냄 (과거 주문 소급 포함). ERP가 같은 주문을 두 번 저장하지 않는다
//    (주문 번호 + 내용 지문). 예전 브라우저 경로로 이미 들어간 주문은 인보이스 번호로 확인해서 건너뛴다.
//  · Site Order DB 구조 변경 없음 — "보냈는지"는 ERP에 물어봐서 판단한다.
//  · 가격·합계는 이 서버가 다시 계산해 저장한 주문 값만 보낸다. 비밀키는 로그·응답에 절대 남기지 않는다.
const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

const ERP_BASE = () => (process.env.TRONIC_ERP_BASE_URL || '').replace(/\/+$/, '');
const SECRET = () => process.env.PREMIUM_K_SERVER_SECRET;

// 이 시각(이 기능 운영 배포 시각) 전에 들어온 주문은 "과거 주문(소급)" — ERP에서 'backfill'로 따로 보이고 신규 알림 숫자에
// 안 잡힌다 (주문 이메일을 보고 이미 인보이스를 만들었을 수 있으므로 확인 후 처리). 점검·재전송에서만 쓰는 기준이며,
// 배포 후 새로 들어온 주문은 저장 즉시 'new'로 보낸다. 환경변수로 바꿀 수 있지만 형식이 틀리거나 미래 시각이면 무시한다.
const DEFAULT_LIVE_FROM = '2026-10-13T00:01:40Z';   // 운영 배포 시각 (2026-10-13)
function liveFrom() {
  const v = process.env.ERP_ORDER_SYNC_LIVE_FROM;
  const t = v ? Date.parse(v) : NaN;
  if (!Number.isNaN(t) && t <= Date.now()) return new Date(t).toISOString();
  return DEFAULT_LIVE_FROM;
}
const isPastOrder = (order) => new Date(order.created_at).getTime() < Date.parse(liveFrom());
// ERP 칸 길이에 맞춤 (site_orders: 주소 500, 이름·영업사원 255, 전화·수령·결제 50, 인보이스 번호 50)
const cut = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));

function sanitize(msg) {
  let s = String(msg || '');
  const sec = SECRET();
  if (sec) s = s.split(sec).join('[REDACTED]');
  return s.slice(0, 200);
}

function parseItems(items) {
  if (Array.isArray(items)) return items;
  try { const v = JSON.parse(items || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

function buildPayload(order, backfill) {
  return {
    sourceOrderId: String(order.id),
    externalUserId: order.user_id ? String(order.user_id) : 'unknown',
    invoiceNumber: cut(order.invoice_number || null, 50),
    phone: cut(order.phone || null, 50),
    customerName: cut(String(order.customer_name || '').trim() || order.phone || 'Site Order customer', 255),
    address: cut(order.address || null, 500),
    repName: cut(order.rep_name || null, 255),
    deliveryMethod: cut(order.delivery_method || null, 50),
    paymentMethod: cut(order.payment_method || null, 50),
    items: parseItems(order.items),
    total: Number(order.total || 0),
    orderText: order.order_text || null,
    staffCreditApplied: Number(order.staff_credit_applied || 0),
    amountDue: order.amount_due !== null && order.amount_due !== undefined ? Number(order.amount_due) : Number(order.total || 0),
    orderedAt: order.created_at ? new Date(order.created_at).toISOString() : null,
    backfill: !!backfill,
  };
}

async function erpPost(path, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchFn(`${ERP_BASE()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-premium-k-server-secret': SECRET() },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: resp.status, json };
  } finally { clearTimeout(timer); }
}

// 주문 1건 보내기. 절대 throw하지 않는다. 반환: { ok, siteOrderId?, deduplicated?, reason? }
async function pushOrder(order, { backfill = false, timeoutMs = 8000 } = {}) {
  if (!ERP_BASE() || !SECRET()) return { ok: false, reason: 'ERP 연결 설정 없음' };
  try {
    const r = await erpPost('/api/site-orders/incoming-verified', buildPayload(order, backfill), timeoutMs);
    if (r.status >= 200 && r.status < 300 && r.json && r.json.ok) return { ok: true, siteOrderId: r.json.id, deduplicated: !!r.json.deduplicated };
    if (r.status === 409) return { ok: false, reason: 'ERP에 같은 주문 번호가 다른 내용으로 있음' };
    if (r.status === 401) return { ok: false, reason: 'ERP가 연결 비밀키를 거절함' };
    return { ok: false, reason: sanitize(`ERP 응답 ${r.status}${r.json && r.json.error ? ': ' + r.json.error : ''}`) };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'ERP 응답 시간 초과' : 'ERP 연결 실패' };
  }
}

// 새 주문 저장 직후 호출 (api/orders.js). 실패는 로그만 — 점검·재전송으로 다시 보낼 수 있다.
async function pushNewOrder(q, orderId) {
  try {
    const { rows } = await q('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (!rows[0]) return { ok: false, reason: 'order not found' };
    // 배포 후 새로 저장된 주문 → 항상 신규. 고객 화면이 오래 기다리지 않도록 3초까지만 기다린다 (실패하면 점검·재전송으로).
    const r = await pushOrder(rows[0], { backfill: false, timeoutMs: 3000 });
    if (!r.ok) console.error('[erpOrders] new order not sent to ERP:', rows[0].invoice_number || orderId, r.reason);
    return r;
  } catch (e) {
    console.error('[erpOrders] new order push error:', sanitize(e.message));
    return { ok: false, reason: 'error' };
  }
}

async function fetchKnown(orders) {
  if (!ERP_BASE() || !SECRET()) {
    const e = new Error('ERP 연결 설정이 없습니다 (TRONIC_ERP_BASE_URL / PREMIUM_K_SERVER_SECRET).'); e.code = 'ERP_NOT_CONFIGURED'; throw e;
  }
  const ids = new Set(), invoices = new Set();
  let ready = null;
  // ERP가 한 번에 받는 개수 제한(5000)보다 작게 나눠서 묻는다
  for (let i = 0; i < Math.max(orders.length, 1); i += 2000) {
    const part = orders.slice(i, i + 2000);
    let r;
    try {
      r = await erpPost('/api/site-orders/known-sources', {
        sourceOrderIds: part.map((o) => String(o.id)),
        invoiceNumbers: part.map((o) => o.invoice_number).filter(Boolean),
      }, 8000);
    } catch (e) {
      const t = new Error(e.name === 'AbortError' ? 'ERP 응답이 없습니다 (시간 초과).' : 'ERP에 연결하지 못했습니다.'); t.code = 'ERP_UNREACHABLE'; throw t;
    }
    if (r.status === 401) { const e = new Error('ERP가 연결 비밀키를 거절했습니다.'); e.code = 'ERP_AUTH'; throw e; }
    if (r.status === 404) { const e = new Error('ERP가 아직 이 기능이 없는 버전입니다 (ERP 배포 필요).'); e.code = 'ERP_OLD'; throw e; }
    if (r.status >= 300 || !r.json || !Array.isArray(r.json.knownSourceIds)) {
      const e = new Error(`ERP 응답 오류 (${r.status}). ERP DB 준비 상태를 확인해주세요.`); e.code = 'ERP_HTTP'; throw e;
    }
    r.json.knownSourceIds.forEach((x) => ids.add(String(x)));
    (r.json.knownInvoiceNumbers || []).forEach((x) => invoices.add(String(x)));
    if (r.json.ready) ready = r.json.ready;
  }
  return { ids, invoices, ready };
}

const ORDER_COLS = `id, user_id, invoice_number, phone, customer_name, address, rep_name, delivery_method, payment_method,
  items, total, order_text, created_at, staff_credit_applied, amount_due`;

// ERP에 없는 주문 목록 (오래된 것부터). 아무것도 바꾸지 않는다.
async function computeSyncPlan(q) {
  const { rows: orders } = await q(`SELECT ${ORDER_COLS} FROM orders ORDER BY created_at ASC`);
  const known = await fetchKnown(orders);
  const notInErp = orders.filter((o) => !known.ids.has(String(o.id)) && !(o.invoice_number && known.invoices.has(String(o.invoice_number))));
  // 품목이 없는 주문(예전 시험 주문 등)은 ERP가 받지 않으므로 따로 센다
  const missing = notInErp.filter((o) => parseItems(o.items).length > 0);
  const unsendable = notInErp.length - missing.length;
  const viaInvoiceOnly = orders.filter((o) => !known.ids.has(String(o.id)) && o.invoice_number && known.invoices.has(String(o.invoice_number))).length;
  const past = missing.filter(isPastOrder);
  return {
    liveFrom: liveFrom(),
    // ERP가 같은 주문을 두 번 저장하지 않게 막는 장치(주문 번호 칸 + 중복 방지 색인)가 준비됐는지
    erpReady: !!(known.ready && known.ready.sourceOrderId && known.ready.uniqueIndex),
    counts: {
      total: orders.length,
      inErp: orders.length - notInErp.length,
      inErpOldPath: viaInvoiceOnly,
      missing: missing.length,
      missingPast: past.length,
      missingNew: missing.length - past.length,
      unsendable,
    },
    missing,
  };
}

function brief(o) {
  return {
    invoiceNumber: o.invoice_number || null,
    customerName: o.customer_name || '',
    total: Number(o.total || 0),
    createdAt: o.created_at,
    deliveryMethod: o.delivery_method || null,
    past: isPastOrder(o),
  };
}

// 한 번에 최대 limit건 보내기 (오래된 것부터, 동시에 5건씩). 같은 주문은 ERP가 중복 저장하지 않으므로 몇 번 눌러도 안전.
// skip: 이번 점검에서 이미 실패한 주문 번호들 (화면이 넘겨줌) — 같은 실패 주문이 앞을 막아 나머지가 못 가는 일 방지.
async function syncBatch(q, limit = 10, skip = []) {
  const started = Date.now();
  const plan = await computeSyncPlan(q);
  if (!plan.erpReady) {
    const e = new Error('ERP DB에 중복 방지 장치(주문 번호 색인)가 없어 보내지 않았습니다. ERP DB 준비가 먼저 필요합니다.'); e.code = 'ERP_NOT_READY'; throw e;
  }
  const skipSet = new Set((Array.isArray(skip) ? skip : []).slice(0, 2000).map(String));
  const candidates = plan.missing.filter((o) => !skipSet.has(String(o.id)));
  const batch = candidates.slice(0, limit);
  const results = [];
  let tried = 0;
  for (let i = 0; i < batch.length; i += 5) {
    if (i > 0 && Date.now() - started > 6000) break;   // 서버 실행 시간 제한 안에서 끝내기 — 남은 것은 다음 호출에서
    const chunk = batch.slice(i, i + 5);
    const rs = await Promise.all(chunk.map((o) => pushOrder(o, { backfill: isPastOrder(o), timeoutMs: 5000 })));
    rs.forEach((r, j) => results.push({ order: chunk[j], r }));
    tried += chunk.length;
  }
  const failed = results.filter((x) => !x.r.ok).map((x) => ({ sourceOrderId: String(x.order.id), invoiceNumber: x.order.invoice_number || null, customerName: x.order.customer_name || '', reason: x.r.reason }));
  const sent = results.filter((x) => x.r.ok && !x.r.deduplicated).length;
  const deduplicated = results.filter((x) => x.r.ok && x.r.deduplicated).length;
  return { sent, deduplicated, failed, remaining: Math.max(0, candidates.length - tried) };
}

module.exports = { pushOrder, pushNewOrder, computeSyncPlan, syncBatch, brief, buildPayload, isPastOrder, liveFrom };
