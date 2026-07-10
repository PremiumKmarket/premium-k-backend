/**
 * api/create-checkout.js
 * Vercel Serverless Function.
 *
 * Receives the exact order total from the field-order app and creates a
 * SHOPIFY DRAFT ORDER for that amount, returning its hosted invoice/checkout
 * URL. The browser redirects there, and the customer pays through
 * Premium K's own Shopify store (www.premium-k.com) — same payment methods
 * already configured there.
 *
 * Required environment variables (set in Vercel dashboard, NOT in code):
 *   SHOPIFY_STORE_DOMAIN   = premiumkfood.myshopify.com
 *   SHOPIFY_CLIENT_ID      = (from Dev Dashboard → app → Settings)
 *   SHOPIFY_CLIENT_SECRET  = (from Dev Dashboard → app → Settings)
 *
 * Optional:
 *   ALLOWED_ORIGIN = https://tronicholdings.com
 */

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { amount, orderNumber, customerName, customerEmail } = req.body;

    const numericAmount = Number(amount);
    if (!numericAmount || numericAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    if (numericAmount > 20000) {
      return res.status(400).json({ error: 'Amount exceeds safety limit ($20,000). Contact admin.' });
    }

    const accessToken = await getShopifyAccessToken();
    const invoiceUrl = await createDraftOrder({
      accessToken, amount: numericAmount, orderNumber, customerName, customerEmail,
    });

    return res.status(200).json({ url: invoiceUrl });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create checkout session', detail: err.message });
  }
};
