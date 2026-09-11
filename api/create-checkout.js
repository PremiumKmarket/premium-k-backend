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

async function createDraftOrder({ accessToken, amount, orderNumber, customerName, customerEmail }) {
  const { SHOPIFY_STORE_DOMAIN } = process.env;

  const mutation = `
    mutation draftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder { id invoiceUrl }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    input: {
      lineItems: [
        {
          title: `Premium K Order${orderNumber ? ' #' + orderNumber : ''}`,
          originalUnitPrice: amount.toFixed(2),
          quantity: 1,
          taxable: false,
        },
      ],
      taxExempt: true, // 도매 거래 — Sales Tax 부과하지 않음
      email: customerEmail || undefined,
      note: customerName ? `Customer: ${customerName}` : undefined,
    },
  };

  const res = await fetchFn(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query: mutation, variables }),
  });

  const data = await res.json();
  const errors = data?.data?.draftOrderCreate?.userErrors;
  if (errors && errors.length) {
    throw new Error('Shopify draft order error: ' + JSON.stringify(errors));
  }
  const invoiceUrl = data?.data?.draftOrderCreate?.draftOrder?.invoiceUrl;
  if (!invoiceUrl) {
    throw new Error('No invoice URL returned: ' + JSON.stringify(data));
  }
  return invoiceUrl;
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
      `SELECT id, invoice_number, total, customer_name FROM orders WHERE id = $1 AND user_id = $2`,
      [orderId, user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'ORDER_NOT_FOUND', message: 'Order not found. 주문을 찾을 수 없습니다.' });

    const numericAmount = Number(order.total);
    if (!numericAmount || numericAmount <= 0) {
      return res.status(400).json({ error: 'INVALID_AMOUNT', message: 'This order has no payable total (all items may be price-inquiry). 이 주문은 결제할 금액이 없습니다 (전부 가격문의 상품일 수 있음).' });
    }
    if (numericAmount > 20000) {
      return res.status(400).json({ error: 'Amount exceeds safety limit ($20,000). Contact admin.' });
    }

    const accessToken = await getShopifyAccessToken();
    const invoiceUrl = await createDraftOrder({
      accessToken,
      amount: numericAmount,
      orderNumber: order.invoice_number,
      customerName: order.customer_name,
      customerEmail: user.email,
    });

    // 나중에 대조할 수 있도록, 이 주문에 결제 페이지가 만들어졌다는 기록을 남깁니다.
    await db.query(
      `UPDATE orders SET checkout_url = $1, checkout_requested_at = now() WHERE id = $2`,
      [invoiceUrl, order.id]
    ).catch((e) => console.error('[create-checkout] failed to record checkout_url:', e.message));

    return res.status(200).json({ url: invoiceUrl, amount: numericAmount, orderNumber: order.invoice_number });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create checkout session', detail: err.message });
  }
};
