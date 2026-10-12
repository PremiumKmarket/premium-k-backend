/**
 * api/create-checkout.js
 * Vercel Serverless Function.
 *
 * SECURITY-CRITICAL FILE — see audit findings F01/F02 (2026-09-11).
 * Previously this endpoint trusted a client-supplied `amount` and an
 * unrelated `orderNumber` (Date.now()-derived), so a caller could pay
 * whatever they liked and the receipt number never matched the saved
 * order. It now requires a logged-in session and an `orderId` that
 * belongs to that session, and reads the amount + invoice number from
 * the already-saved, server-priced order row — never from the request.
 *
 * Required environment variables (set in Vercel dashboard, NOT in code):
 *   SHOPIFY_STORE_DOMAIN   = premiumkfood.myshopify.com
 *   SHOPIFY_CLIENT_ID      = (from Dev Dashboard → app → Settings)
 *   SHOPIFY_CLIENT_SECRET  = (from Dev Dashboard → app → Settings)
 *
 * Optional:
 *   ALLOWED_ORIGIN = https://tronicholdings.com
 */

const db = require('../lib/db');
const { getUserFromToken, getBearerToken } = require('../lib/auth');
const { fulfillmentInfo, PICKUP_NOTICE } = require('../lib/fulfillment');

const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

const API_VERSION = '2026-07';

async function getShopifyAccessToken() {
  const { SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET } = process.env;
  const res = await fetchFn(`https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error('Failed to get Shopify access token: ' + JSON.stringify(data));
  }
  return data.access_token;
}

// Shopify Draft Order 하나를 만들고 결제 링크(invoiceUrl)를 돌려준다. 실패하면 throw.
async function createDraftOrder(accessToken, input) {
  const { SHOPIFY_STORE_DOMAIN } = process.env;
  const mutation = `
    mutation draftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder { id invoiceUrl }
        userErrors { field message }
      }
    }
  `;
  const res = await fetchFn(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query: mutation, variables: { input } }),
  });

  // "Shopify가 확실히 거절했다(Draft가 만들어지지 않음)"일 때만 e.rejected=true → 다음 방식으로 다시 시도.
  // 네트워크 끊김·5xx·응답 해석 실패처럼 이미 만들어졌을 수도 있는 경우에는 다시 시도하지 않는다 (Draft 중복 방지).
  // 로그·오류에는 Shopify 오류 문구와 코드만 남긴다 (보낸 입력 = 고객 정보가 섞인 extensions.value 는 남기지 않음).
  const fail = (msg, rejected) => { const e = new Error(msg); e.rejected = rejected; return e; };
  if (res.status >= 500) throw fail(`Shopify HTTP ${res.status}`, false);
  let data;
  try { data = await res.json(); } catch { throw fail(`Shopify response not JSON (HTTP ${res.status})`, res.status >= 400 && res.status < 500); }
  if (data && Array.isArray(data.errors) && data.errors.length) {
    const brief = data.errors.map((x) => `${(x && x.extensions && x.extensions.code) || 'ERROR'}: ${String((x && x.message) || '').slice(0, 160)}`).join(' | ');
    throw fail('Shopify GraphQL error: ' + brief, true);
  }
  if (res.status >= 400) throw fail(`Shopify HTTP ${res.status}`, true);
  const errors = data?.data?.draftOrderCreate?.userErrors;
  if (errors && errors.length) {
    throw fail('Shopify draft order error: ' + errors.map((x) => String((x && x.message) || '').slice(0, 160)).join(' | '), true);
  }
  const invoiceUrl = data?.data?.draftOrderCreate?.draftOrder?.invoiceUrl;
  if (!invoiceUrl) throw fail('No invoice URL returned', false);
  return invoiceUrl;
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// v2 (2026-10-13) — Shopify 주문에 상품별 내역이 보이도록 줄마다 넣는다.
// 줄 합계가 서버에 저장된 주문 합계와 1센트라도 다르면 null을 돌려서 예전 방식(한 줄)으로 만든다.
function buildItemizedLines(order, requiresShipping) {
  let items = order.items;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
  if (!Array.isArray(items)) items = [];
  const lines = [];
  const tbd = [];
  let sum = 0;
  for (const it of items) {
    if (!it || it.tbd || it.lineTotal === null || it.lineTotal === undefined) { if (it) tbd.push(it); continue; }
    const qty = Number(it.qty);
    const lineTotal = round2(it.lineTotal);
    const unit = round2(it.unitPrice);
    if (!Number.isInteger(qty) || qty <= 0 || !(lineTotal >= 0)) return null;
    const name = [it.nameKo, it.nameEn].filter(Boolean).join(' / ') || it.sku || 'Item';
    const unitLabel = it.mode === 'carton' ? 'Box 박스' : 'Unit 개';
    // 단가 × 수량이 줄 합계와 정확히 같을 때만 수량을 그대로 쓰고, 아니면 줄 합계를 1개로 넣는다 (금액 오차 방지)
    const clean = Math.abs(round2(unit * qty) - lineTotal) < 0.005;
    lines.push({
      title: `${name} (${unitLabel})${clean ? '' : ` × ${qty}`}`.slice(0, 250),
      sku: it.sku ? String(it.sku).slice(0, 100) : undefined,
      originalUnitPrice: (clean ? unit : lineTotal).toFixed(2),
      quantity: clean ? qty : 1,
      taxable: false,
      requiresShipping,
    });
    sum = round2(sum + lineTotal);
  }
  if (!lines.length || Math.abs(sum - round2(order.total)) > 0.005) return null;
  return { lines, tbd };
}

function orderNote(order, info) {
  const parts = [];
  if (order.invoice_number) parts.push(`Invoice #${order.invoice_number}`);
  if (order.customer_name) parts.push(`Customer 고객: ${order.customer_name}`);
  if (order.phone) parts.push(`Phone 연락처: ${order.phone}`);
  if (info) parts.push(`Fulfillment 수령 방법: ${info.label}`);
  if (order.address && !(info && info.pickup)) parts.push(`Address 주소: ${order.address}`);
  if (info && info.pickup) {
    parts.push(`Pickup location 픽업 장소: ${info.address}`);
    parts.push(`Pickup hours 픽업 시간: ${info.hours}`);
    parts.push(`⚠️ ${PICKUP_NOTICE}`);
  }
  if (order.rep_name) parts.push(`Sales rep 영업사원: ${order.rep_name}`);
  return parts.join('\n');
}

module.exports = async (req, res) => {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const user = await getUserFromToken(getBearerToken(req));
    if (!user) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Login required. 로그인이 필요합니다.' });

    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'MISSING_ORDER_ID' });

    // 금액/주문번호는 요청에서 절대 받지 않고, 이미 서버가 가격을 매겨 저장해둔
    // 주문 레코드에서만 읽습니다. 본인 소유 주문인지도 확인합니다.
    const { rows } = await db.query(
      `SELECT id, invoice_number, total, amount_due, staff_credit_applied, customer_name, phone, address, rep_name, delivery_method, items FROM orders WHERE id = $1 AND user_id = $2`,
      [orderId, user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'ORDER_NOT_FOUND', message: 'Order not found. 주문을 찾을 수 없습니다.' });

    // 결제할 금액 = 합계 − 직원 크레딧 (예전 주문은 amount_due가 없으므로 합계 그대로)
    const numericAmount = Number(order.amount_due !== null && order.amount_due !== undefined ? order.amount_due : order.total);
    if (Number(order.staff_credit_applied) > 0 && numericAmount <= 0) {
      return res.status(400).json({ error: 'NO_PAYMENT_DUE', message: 'Fully covered by staff credit — nothing to pay. 직원 크레딧으로 전액 처리되어 결제할 금액이 없습니다.' });
    }
    if (!numericAmount || numericAmount <= 0) {
      return res.status(400).json({ error: 'INVALID_AMOUNT', message: 'This order has no payable total (all items may be price-inquiry). 이 주문은 결제할 금액이 없습니다 (전부 가격문의 상품일 수 있음).' });
    }
    if (numericAmount > 20000) {
      return res.status(400).json({ error: 'Amount exceeds safety limit ($20,000). Contact admin.' });
    }

    const accessToken = await getShopifyAccessToken();

    // v2 (2026-10-13) — 수령 방법은 우리 주문서에서 이미 정했으므로, 픽업·딜리버리 주문은 Shopify 결제 화면이
    // 배송/매장 픽업을 다시 묻지 않게 한다 (requiresShipping:false). 택배는 지금과 같게 둔다.
    const info = fulfillmentInfo(order.delivery_method);
    const paymentOnly = !!info && order.delivery_method !== 'shipping';
    const note = orderNote(order, info);
    const customAttributes = [
      order.invoice_number ? { key: 'Invoice', value: String(order.invoice_number) } : null,
      info ? { key: 'Fulfillment', value: info.label } : null,
      info && info.pickup ? { key: 'Pickup location', value: info.address } : null,
      info && info.pickup ? { key: 'Pickup hours', value: info.hours } : null,
      info && info.pickup ? { key: 'Pickup notice', value: PICKUP_NOTICE } : null,
      order.rep_name ? { key: 'Sales rep', value: String(order.rep_name) } : null,
    ].filter(Boolean);
    const tags = ['site-order'].concat(order.delivery_method ? [String(order.delivery_method).replace(/_/g, '-')] : []);
    const credit = round2(order.staff_credit_applied || 0);
    const base = {
      taxExempt: true, // 도매 거래 — Sales Tax 부과하지 않음
      email: user.email || undefined,
      note,
      customAttributes,
      tags,
      poNumber: order.invoice_number ? String(order.invoice_number) : undefined,
    };
    const lumpTitle = `Premium K Order${order.invoice_number ? ' #' + order.invoice_number : ''}`;
    const attempts = [];
    // 1) 상품별 내역 (합계 = 저장된 주문 합계, 직원 크레딧은 할인으로) — 금액이 1센트라도 안 맞으면 건너뜀
    const itemized = buildItemizedLines(order, !paymentOnly);
    if (itemized && round2(round2(order.total) - credit) === round2(numericAmount)) {
      const tbdNote = itemized.tbd.length
        ? '\nPrice-inquiry items (not charged) 가격문의 상품(결제 제외): ' + itemized.tbd.map((t) => `${t.nameKo || t.nameEn || t.sku} × ${t.qty}`).join(', ')
        : '';
      attempts.push({ mode: 'itemized', input: { ...base, note: note + tbdNote, lineItems: itemized.lines,
        appliedDiscount: credit > 0 ? { value: credit, valueType: 'FIXED_AMOUNT', title: 'Staff credit', description: '직원 크레딧' } : undefined } });
    }
    // 2) 한 줄 + 안내 (상품별 내역을 못 만들었거나 Shopify가 거절한 경우)
    attempts.push({ mode: 'lump', input: { ...base, lineItems: [{ title: lumpTitle, originalUnitPrice: numericAmount.toFixed(2), quantity: 1, taxable: false, requiresShipping: !paymentOnly }] } });
    // 3) 예전과 완전히 같은 방식 (최후 수단 — 결제는 반드시 되게)
    attempts.push({ mode: 'legacy', input: {
      lineItems: [{ title: lumpTitle, originalUnitPrice: numericAmount.toFixed(2), quantity: 1, taxable: false }],
      taxExempt: true, email: user.email || undefined, note: order.customer_name ? `Customer: ${order.customer_name}` : undefined,
    } });

    let invoiceUrl = null, mode = null, lastErr = null;
    for (const a of attempts) {
      try { invoiceUrl = await createDraftOrder(accessToken, a.input); mode = a.mode; break; }
      catch (e) {
        lastErr = e; console.error(`[create-checkout] ${a.mode} draft failed:`, e.message);
        if (!e.rejected) break;   // 결과가 불확실하면 더 만들지 않음
      }
    }
    if (!invoiceUrl) throw lastErr || new Error('Draft order failed');

    // 나중에 대조할 수 있도록, 이 주문에 결제 페이지가 만들어졌다는 기록을 남깁니다.
    await db.query(
      `UPDATE orders SET checkout_url = $1, checkout_requested_at = now() WHERE id = $2`,
      [invoiceUrl, order.id]
    ).catch((e) => console.error('[create-checkout] failed to record checkout_url:', e.message));

    return res.status(200).json({ url: invoiceUrl, amount: numericAmount, orderNumber: order.invoice_number, mode });
  } catch (err) {
    console.error('[create-checkout]', err.message);
    return res.status(500).json({ error: 'Failed to create checkout session', detail: 'Payment page could not be created. 결제 페이지를 만들지 못했습니다.' });
  }
};
