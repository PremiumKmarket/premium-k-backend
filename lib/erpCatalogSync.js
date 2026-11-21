// lib/erpCatalogSync.js  v1.1 (Site Order v8.13) — ERP 가격 변경을 주문 사이트에 반영 (이미 사이트에 있는 상품)
//
// 정책 (2026-11-20 대표님: "자동 연동이 되도록 해 주세요" — ERP가 기준)
//  · 대상: 사이트와 ERP에 같은 SKU로 있는 상품. TOGO SOLUTION 분류는 손대지 않는다(뚜껑·색상 옵션 등 사이트 전용 구성).
//  · 바꾸는 칸: 박스가(ctn_price)·박스입수(ctn_qty)·낱개가(price)·가격문의(tbd)만.
//    이름·분류·그림·규격·링크·순서는 사이트 관리자가 다듬은 것일 수 있어 그대로 둔다.
//  · ERP에 박스가가 없으면(0·빈칸) 사이트 가격을 그대로 둔다 — ERP에 값이 생기면 그때 따라간다.
//    ERP에 낱개가가 없으면 사이트 낱개가는 그대로, 입수가 없으면 사이트 입수는 그대로.
//  · 자동으로 바꾸지 않고 '확인 필요'로 남기는 경우: (v1.1) ERP 박스가가 낱개가×입수와 1% 넘게 다름, 박스가가 3배 넘게 오르거나 1/3 밑으로 내리는 변화(입력 실수 방지),
//    사이트 입수가 2 이상인데 ERP 입수가 1인 경우(ERP 기본값 1이 그대로인 상품이 많음).
//  · ERP에서 노출을 끄거나 판매중지해도 사이트에서 내리지 않는다(11/07 결정 그대로).
//  · 바꾼 값은 erp_catalog_price_log 에 전·후를 남긴다(되돌리기용). 되돌리기는 그 뒤로 손대지 않은 상품만 되돌린다.

const TOGO_CAT = 'TOGO SOLUTION';
const BIG_RATIO = 3;

const posNum = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };
const posInt = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 && Math.abs(n - Math.round(n)) < 1e-9 ? Math.round(n) : null; };
const money = (v) => (v == null || v === '' ? null : Math.round(Number(v) * 100) / 100);
const int = (v) => (v == null || v === '' ? null : Number(v));

// ERP 시각 문자열("2026-11-20 23:55:35.526123+00", "2026-11-20T23:55:35Z")을 비교 가능한 글자로 — 마이크로초까지
function tsKey(v) {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/);
  if (!m) return null;
  const off = m[4] || 'Z';
  if (off === 'Z' || /^\+00(:?00)?$/.test(off)) return `${m[1]}T${m[2]}.${(m[3] || '').padEnd(6, '0').slice(0, 6)}`;
  const frac = (m[3] || '').padEnd(6, '0').slice(0, 6);
  const offIso = /^[+-]\d{2}$/.test(off) ? `${off}:00` : (/^[+-]\d{4}$/.test(off) ? `${off.slice(0, 3)}:${off.slice(3)}` : off);
  const d = new Date(`${m[1]}T${m[2]}.${frac.slice(0, 3)}${offIso}`);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(0, 23)}${frac.slice(3, 6)}`;
}

/**
 * @param erpItems  ERP /catalog items
 * @param siteRows  사이트 products 행 {id, sku, cat, ctn_price, ctn_qty, price, tbd}
 * @param opts.since  이 시각 뒤에 ERP에서 바뀐 상품만 본다(자동 실행). 없으면 전부(일괄 맞추기).
 * @returns {{ update: Array<{id, sku, before, after, changes}>, review: Array, counts }}
 */
function planUpdate(erpItems, siteRows, opts = {}) {
  const sinceKey = opts.since ? tsKey(opts.since) : null;
  const bySku = new Map();
  for (const r of siteRows) { const k = String(r.sku || '').trim(); if (k && !bySku.has(k)) bySku.set(k, r); }
  const seen = new Map();
  for (const i of erpItems) { const k = String(i.sku || '').trim(); seen.set(k, (seen.get(k) || 0) + 1); }

  const update = [], review = [];
  const counts = { checked: 0, same: 0, noErpPrice: 0, togo: 0, notOnSite: 0, removed: 0, notChanged: 0 };
  for (const i of erpItems) {
    const sku = String(i.sku || '').trim();
    if (i.removed) { counts.removed += 1; continue; }
    const s = bySku.get(sku);
    if (!s) { counts.notOnSite += 1; continue; }
    if (sinceKey) { const k = tsKey(i.updatedAt); if (!k || k <= sinceKey) { counts.notChanged += 1; continue; } }
    counts.checked += 1;
    if (String(s.cat || '').trim().toUpperCase() === TOGO_CAT) { counts.togo += 1; continue; }
    if (seen.get(sku) > 1) { review.push({ sku, id: String(s.id), why: 'ERP 목록에 같은 SKU가 두 번 이상', item: i, site: s }); continue; }
    const ctn = posNum(i.ctnPrice);
    if (ctn === null) { counts.noErpPrice += 1; continue; }
    const qty = posInt(i.ctnQty);
    const piece = posNum(i.piecePrice);
    if (qty !== null && piece !== null && Math.abs(ctn - Math.round(piece * qty * 100) / 100) > Math.max(0.02, ctn * 0.01)) {
      review.push({ sku, id: String(s.id), why: `ERP 박스가 $${ctn} ≠ 낱개가 $${piece} × 입수 ${qty} — ERP 가격·입수 확인 필요`, item: i, site: s });
      continue;
    }
    const before = { ctn_price: money(s.ctn_price), ctn_qty: int(s.ctn_qty), price: money(s.price), tbd: !!s.tbd };
    const after = { ctn_price: ctn, ctn_qty: qty ?? before.ctn_qty, price: piece ?? before.price, tbd: false };
    const changes = Object.keys(after).filter((k) => after[k] !== before[k]);
    if (!changes.length) { counts.same += 1; continue; }
    if (before.ctn_qty != null && before.ctn_qty >= 2 && qty === 1) {
      review.push({ sku, id: String(s.id), why: `ERP 박스 입수가 1 (사이트 ${before.ctn_qty}) — ERP 입수 확인 필요`, item: i, site: s, before, after });
      continue;
    }
    if (before.ctn_price && (ctn / before.ctn_price > BIG_RATIO || ctn / before.ctn_price < 1 / BIG_RATIO)) {
      review.push({ sku, id: String(s.id), why: `박스가가 크게 바뀜 $${before.ctn_price} → $${ctn} — 입력 실수인지 확인 필요`, item: i, site: s, before, after });
      continue;
    }
    update.push({ id: String(s.id), sku, before, after, changes });
  }
  counts.update = update.length;
  counts.review = review.length;
  return { update, review, counts };
}

function updateDigestLines(update) {
  return update.map((u) => [u.id, u.sku, u.after.ctn_price, u.after.ctn_qty, u.after.price, u.after.tbd].join('|'));
}

/**
 * 한 트랜잭션 안에서 바꾼다(부르는 쪽이 BEGIN/COMMIT). 계획을 세운 뒤 누가 그 상품을 고쳤으면(전 값이 다르면) 건너뛴다.
 * @returns 바뀐 행 [{id, sku}]
 */
async function applyUpdate(client, update, batch, schema = { hasUpdatedAt: true }) {
  if (!update.length) return [];
  const rows = update.map((u) => ({ id: u.id, sku: u.sku,
    b_ctn_price: u.before.ctn_price, b_ctn_qty: u.before.ctn_qty, b_price: u.before.price, b_tbd: u.before.tbd,
    ctn_price: u.after.ctn_price, ctn_qty: u.after.ctn_qty, price: u.after.price, tbd: u.after.tbd }));
  const changed = (await client.query(
    `WITH x AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(id text, sku text, b_ctn_price numeric, b_ctn_qty int, b_price numeric, b_tbd boolean,
                                                             ctn_price numeric, ctn_qty int, price numeric, tbd boolean))
     UPDATE products p SET ctn_price = x.ctn_price, ctn_qty = x.ctn_qty, price = x.price, tbd = x.tbd${schema.hasUpdatedAt ? ', updated_at = now()' : ''}
       FROM x
      WHERE p.id::text = x.id AND p.sku = x.sku
        AND p.ctn_price IS NOT DISTINCT FROM x.b_ctn_price AND p.ctn_qty IS NOT DISTINCT FROM x.b_ctn_qty
        AND p.price IS NOT DISTINCT FROM x.b_price AND COALESCE(p.tbd, false) = x.b_tbd
     RETURNING p.id::text AS id, p.sku`, [JSON.stringify(rows)])).rows;
  if (changed.length) {
    const ids = new Set(changed.map((r) => r.id));
    const logRows = update.filter((u) => ids.has(u.id)).map((u) => ({ product_id: u.id, sku: u.sku, before: u.before, after: u.after }));
    await client.query(
      `INSERT INTO erp_catalog_price_log (batch, product_id, sku, before, after)
       SELECT $2, x.product_id, x.sku, x.before, x.after FROM jsonb_to_recordset($1::jsonb) AS x(product_id text, sku text, before jsonb, after jsonb)`,
      [JSON.stringify(logRows), batch]);
  }
  return changed;
}

module.exports = { planUpdate, applyUpdate, updateDigestLines, tsKey, BIG_RATIO };
