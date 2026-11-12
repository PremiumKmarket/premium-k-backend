// lib/shopifyAdmin.js — 샵(Shopify) 관리 API 공통 (v8.10)
//  · 카드 결제 링크 = 샵 Draft Order (api/create-checkout.js 가 tag 'site-order', poNumber = 주문 인보이스 번호로 만든다)
//  · 주문을 취소하면 아직 결제 안 된 결제 링크는 지우고(고객이 더 이상 결제하지 못하게), 이미 결제됐으면 알려 준다.
// 로그·오류에는 샵 오류 문구와 코드만 남긴다 (고객 정보는 남기지 않음).

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

async function shopGraphql(accessToken, query, variables) {
  const { SHOPIFY_STORE_DOMAIN } = process.env;
  const res = await fetchFn(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || !data) throw new Error(`Shopify HTTP ${res.status}`);
  if (Array.isArray(data.errors) && data.errors.length) {
    throw new Error('Shopify GraphQL error: ' + data.errors.map((x) => `${(x && x.extensions && x.extensions.code) || 'ERROR'}: ${String((x && x.message) || '').slice(0, 160)}`).join(' | '));
  }
  return data.data;
}

async function deleteDraftOrder(accessToken, id) {
  const d = await shopGraphql(accessToken,
    `mutation draftOrderDelete($input: DraftOrderDeleteInput!) { draftOrderDelete(input: $input) { deletedId userErrors { message } } }`,
    { input: { id } });
  const errs = d && d.draftOrderDelete && d.draftOrderDelete.userErrors;
  if (errs && errs.length) throw new Error('Shopify draft delete error: ' + errs.map((x) => String(x.message || '').slice(0, 160)).join(' | '));
  return true;
}

// 이 주문으로 만든 결제 링크(Draft Order)들 — 주문 시각 이후 만들어진 'site-order' 결제 링크 중 poNumber 가 같은 것
async function findOrderDrafts(accessToken, { invoiceNumber, createdAt }) {
  if (!invoiceNumber) return [];
  const since = new Date(new Date(createdAt || Date.now()).getTime() - 10 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const found = [];
  let after = null;
  for (let page = 0; page < 5; page++) {
    const d = await shopGraphql(accessToken,
      `query($q: String!, $after: String) { draftOrders(first: 100, after: $after, query: $q) {
         nodes { id name status poNumber order { name displayFinancialStatus } }
         pageInfo { hasNextPage endCursor } } }`,
      { q: `tag:site-order created_at:>='${since}'`, after });
    const conn = d && d.draftOrders;
    if (!conn) break;
    for (const n of conn.nodes || []) if (String(n.poNumber || '') === String(invoiceNumber)) found.push(n);
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return found;
}

/**
 * 취소된 주문의 결제 링크 정리. 실패해도 throw 하지 않는다(취소 자체는 이미 끝났으므로).
 * check: 샵에서 찾아볼지 / expectLink: 링크가 있어야 하는 주문인지(못 찾으면 unmatched → "확인 필요")
 * @returns {{checked:boolean, paid:{draft:string, order:string|null, financial:string|null}[], closed:string[], unmatched:boolean, error?:string}}
 */
async function closeOrderPaymentLinks({ invoiceNumber, createdAt, check, expectLink }) {
  const out = { checked: false, paid: [], closed: [], unmatched: false };
  if (!check) return out;                       // 카드 결제가 아니고 결제 링크 기록도 없는 주문(Zelle·직원 크레딧·현장 결제 등)
  if (!process.env.SHOPIFY_STORE_DOMAIN) { out.error = '샵 연결 설정 없음'; return out; }
  try {
    const token = await getShopifyAccessToken();
    const drafts = await findOrderDrafts(token, { invoiceNumber, createdAt });
    out.checked = true;
    if (!drafts.length) { out.unmatched = !!expectLink; return out; }   // 링크를 만들기 전에 그만둔 주문이면 할 일 없음
    for (const d of drafts) {
      if (d.status === 'COMPLETED') {
        out.paid.push({ draft: d.name, order: d.order ? d.order.name : null, financial: d.order ? d.order.displayFinancialStatus : null });
      } else {
        try { await deleteDraftOrder(token, d.id); out.closed.push(d.name); }
        catch (e) { out.error = String(e.message || e).slice(0, 200); }
      }
    }
  } catch (e) {
    out.error = String(e.message || e).slice(0, 200);
  }
  return out;
}

module.exports = { API_VERSION, getShopifyAccessToken, shopGraphql, deleteDraftOrder, findOrderDrafts, closeOrderPaymentLinks };
