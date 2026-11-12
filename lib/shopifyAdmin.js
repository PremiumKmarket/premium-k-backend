// lib/shopifyAdmin.js — 샵(Shopify) 관리 API 공통 (v8.10)
//  · 카드 결제 링크 = 샵 Draft Order. api/create-checkout.js 가 이 주문만의 표시(태그 so-<주문 번호>)를 붙여 만든다.
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

// 결제 링크에 붙이는 이 주문만의 표시 — 주문 사이트 주문 번호(UUID). 고객이 정할 수 있는 인보이스 번호는 쓰지 않는다.
// (샵 태그는 40자까지: 'so-' + 36자 = 39자)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function orderTag(orderId) {
  const id = String(orderId || '').toLowerCase();
  if (!UUID_RE.test(id)) throw new Error('invalid order id for tag');
  return 'so-' + id;
}

// 이 주문으로 만든 결제 링크(Draft Order)들 — 이 주문의 표시(태그)가 붙은 것만. 표시 없는 예전 링크는 찾지 않는다(남의 링크를 건드리지 않게).
async function findOrderDrafts(accessToken, orderId) {
  const tag = orderTag(orderId);
  const d = await shopGraphql(accessToken,
    `query($q: String!) { draftOrders(first: 50, query: $q) { nodes { id name status tags } } }`,
    { q: `tag:'${tag}'` });
  const nodes = (d && d.draftOrders && d.draftOrders.nodes) || [];
  return nodes.filter((n) => (n.tags || []).some((t) => String(t).toLowerCase() === tag));   // 샵 검색 결과를 한 번 더 정확히 거른다
}

// 결제된(주문으로 바뀐) 링크의 샵 주문 번호 — 권한·오류로 못 읽어도 괜찮다(없으면 임시 주문 번호만 알림)
async function paidOrderName(accessToken, draftId) {
  try {
    const d = await shopGraphql(accessToken, `query($id: ID!) { draftOrder(id: $id) { order { name } } }`, { id: draftId });
    return (d && d.draftOrder && d.draftOrder.order && d.draftOrder.order.name) || null;
  } catch { return null; }
}

/**
 * 취소된 주문의 결제 링크 정리. 실패해도 throw 하지 않는다(취소 자체는 이미 끝났으므로).
 * check: 샵에서 찾아볼지(카드 주문이거나 결제 링크를 만든 기록이 있을 때)
 * @returns {{checked:boolean, paid:{draft:string, order:string|null}[], closed:string[], unmatched:boolean, error?:string}}
 *   unmatched: 찾아봤지만 이 주문 표시가 붙은 링크가 없음 — 이번 업데이트 전에 만든 링크일 수 있어 "샵에서 확인"으로 알린다
 */
async function closeOrderPaymentLinks({ orderId, check }) {
  const out = { checked: false, paid: [], closed: [], unmatched: false };
  if (!check) return out;                       // 카드 결제가 아니고 결제 링크 기록도 없는 주문(Zelle·직원 크레딧·현장 결제 등)
  if (!process.env.SHOPIFY_STORE_DOMAIN) { out.error = '샵 연결 설정 없음'; return out; }
  try {
    const token = await getShopifyAccessToken();
    const drafts = await findOrderDrafts(token, orderId);
    out.checked = true;
    if (!drafts.length) { out.unmatched = true; return out; }
    for (const d of drafts) {
      if (d.status === 'COMPLETED') {
        out.paid.push({ draft: d.name, order: await paidOrderName(token, d.id) });
      } else {
        try { await deleteDraftOrder(token, d.id); out.closed.push(d.name); }
        catch (e) { out.error = String(e.message || e).slice(0, 200); }   // 지우는 사이 결제됐을 수도 — "다시 반영"으로 다시 확인
      }
    }
  } catch (e) {
    out.error = String(e.message || e).slice(0, 200);
  }
  return out;
}

module.exports = { API_VERSION, getShopifyAccessToken, shopGraphql, deleteDraftOrder, findOrderDrafts, closeOrderPaymentLinks, orderTag };
