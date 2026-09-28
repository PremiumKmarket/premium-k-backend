// lib/erpCatalogPhase1.js  v1.3 — ERP → Site Order 1차 동기화 (박스가·입수 전용)
// v1.3: 공통 안전 검사(lib/erpCatalogGuards.js) 적용 — 바뀌는 값이 있는 상품마다 아래 순서로 검사,
//   걸리면 자동 반영하지 않는다.
//   1) REVIEW_QTY_TO_ONE   사이트 입수 > 1 인데 ERP 입수 = 1 (1→1 은 정상)
//   2) REVIEW_DATA_MISSING ERP 박스가·ERP 입수·ERP 낱개가(piecePrice) 중 하나라도 없음
//   3) REVIEW_RATIO        ERP 박스가 ÷ (ERP 입수 × ERP 낱개가) 가 0.65~1.35 밖
//   비율은 ERP 값 세 개로만 계산한다. 사이트의 기존 값(낱개가·박스가·입수)으로 대신하지 않는다
//   — 사이트 값은 오래됐거나 수동 입력일 수 있어, ERP 값을 검증하는 데 쓰면 교차 검증 의미가 없다.
//   ERP 구버전(piecePrice 없음)이면 값이 바뀌는 상품은 모두 REVIEW_DATA_MISSING 이 된다(정상).
//
// 확정 정책 (2026-09-25)
//  · 갱신 허용 필드는 딱 2개: ctn_price(박스가), ctn_qty(박스입수)
//  · ERP 값이 없거나(null/blank) 유효하지 않으면 기존 Site Order 값을 그대로 둔다
//      - 박스가: 0보다 큰 숫자만 유효
//      - 입수: 1 이상의 정수만 유효
//  · 낱개가(price)는 1차에서 갱신하지 않는다. ERP의 price 칸은 낱개가가 없으면 단가로 대신 채우는데,
//    단가가 박스 가격인 상품이 있다(예: 24p CTN 상품 단가 $256.80). ERP가 진짜 낱개가를 별도 칸으로
//    공급하고 그 결과를 따로 검증·승인한 뒤에 다음 단계에서 추가한다.
//  · 변경 금지: 이름(영/한), 분류, 규격, 사진, 상세주소, TOGO 옵션 — 이 파일은 그 칸을 아예 다루지 않는다
//  · TOGO SOLUTION 상품은 건드리지 않는다
//  · 사이트에 없는 SKU는 추가하지 않고, 사이트 상품을 숨기거나 지우지도 않는다
//
// planPhase1 은 계산만 한다(읽기 전용). DRY RUN과 실제 실행이 같은 함수를 써서 결과가 어긋나지 않게 한다.
// applyPhase1 만 DB에 쓴다.

const { ratioCheck, qtyToOne } = require('./erpCatalogGuards');
const TOGO_CAT = 'TOGO SOLUTION';
const isTogo = (row) => String(row?.cat || '').trim().toUpperCase() === TOGO_CAT;
const cents = (v) => Math.round(Number(v) * 100) / 100;
const validMoney = (v) => v != null && String(v).trim() !== '' && Number.isFinite(Number(v)) && Number(v) > 0;
const validQty = (v) => v != null && String(v).trim() !== '' && Number.isInteger(Number(v)) && Number(v) >= 1;

const FIELDS = [
  // [사이트 칸, ERP 값 꺼내기, 유효성 검사, 비교용 정규화, 표시 이름]
  ['ctn_price', (e) => e.ctnPrice, validMoney, cents, '박스가'],
  ['ctn_qty', (e) => e.ctnQty, validQty, (v) => Number(v), '박스입수'],
];

/**
 * 1차 동기화 계획 (DB를 바꾸지 않는다)
 * @param {Array} erpItems  ERP /api/site-orders/catalog 의 items
 * @param {Array} siteRows  Site Order products 행 (sku, cat, name_ko, name_en, price, ctn_price, ctn_qty, tbd)
 */
function planPhase1(erpItems, siteRows, opts = {}) {
  const guards = opts.guards !== false;
  const erp = new Map((erpItems || []).filter((i) => !i.removed).map((i) => [String(i.sku), i]));
  const rows = [];
  const updates = [];   // { sku, set: {칸: 새 값}, before: {칸: 옛 값} }
  const counts = { target: 0, willChange: 0, noChange: 0, togoSkipped: 0, siteOnlySkipped: 0,
    field: { ctn_price: 0, ctn_qty: 0 }, keptBecauseErpInvalid: { ctn_price: 0, ctn_qty: 0 }, tbdGetsPrice: 0,
    review: { REVIEW_QTY_TO_ONE: 0, REVIEW_DATA_MISSING: 0, REVIEW_RATIO: 0 } };
  const reviews = [];

  for (const s of siteRows) {
    const sku = String(s.sku);
    if (isTogo(s)) { counts.togoSkipped++; continue; }
    const e = erp.get(sku);
    if (!e) { counts.siteOnlySkipped++; continue; }
    counts.target++;
    const set = {}; const before = {}; const detail = {};
    for (const [siteCol, pick, valid, normalize, label] of FIELDS) {
      const cur = s[siteCol];
      const incoming = pick(e);
      if (!valid(incoming)) {
        counts.keptBecauseErpInvalid[siteCol]++;
        detail[siteCol] = { cur, erp: incoming, final: cur, note: 'ERP 값 없음/무효 → 기존 유지' };
        continue;
      }
      const same = cur != null && String(cur).trim() !== '' && normalize(cur) === normalize(incoming);
      if (same) { detail[siteCol] = { cur, erp: incoming, final: cur, note: '같음' }; continue; }
      set[siteCol] = normalize(incoming);
      before[siteCol] = cur ?? null;
      counts.field[siteCol]++;
      detail[siteCol] = { cur, erp: incoming, final: normalize(incoming), note: `${label} 변경` };
    }
    // 공통 안전 검사 — 바뀌는 값이 있을 때만
    if (guards && Object.keys(set).length) {
      let rv = null;
      if (set.ctn_qty !== undefined && qtyToOne(s.ctn_qty, set.ctn_qty)) {
        rv = { code: 'REVIEW_QTY_TO_ONE', ratio: null, reason: `사이트 입수 ${s.ctn_qty} → ERP 1 (입력 누락 의심)` };
      } else {
        const k = ratioCheck(e.ctnPrice, e.ctnQty, e.piecePrice);   // ERP 값만 — 사이트 값으로 대신하지 않는다
        if (k.code) rv = k;
      }
      if (rv) {
        counts.review[rv.code]++;
        for (const k of Object.keys(set)) counts.field[k]--;
        reviews.push({ sku, name: s.name_ko || s.name_en || '', code: rv.code, ratio: rv.ratio, reason: rv.reason,
          wanted: set, current: { ctn_price: s.ctn_price, ctn_qty: s.ctn_qty, price: s.price } });
        rows.push({ sku, name: s.name_ko || s.name_en || '', tbd: !!s.tbd, detail, action: rv.code, review: rv });
        continue;
      }
    }
    const changed = Object.keys(set).length > 0;
    if (changed) {
      counts.willChange++;
      updates.push({ sku, set, before });
      if (s.tbd && set.ctn_price != null) counts.tbdGetsPrice++;
    } else counts.noChange++;
    rows.push({ sku, name: s.name_ko || s.name_en || '', tbd: !!s.tbd, detail, action: changed ? 'UPDATE_PRICE_QTY' : 'NO_CHANGE' });
  }
  return { rows, updates, counts, reviews };
}

/**
 * 계획대로 DB에 쓴다 (실제 실행 때만 호출). 허용된 2개 칸 외에는 절대 건드리지 않는다.
 * TOGO 상품은 SQL 조건으로 한 번 더 막는다.
 */
async function applyPhase1(client, plan) {
  let applied = 0;
  for (const u of plan.updates) {
    const cols = Object.keys(u.set).filter((c) => ['ctn_price', 'ctn_qty'].includes(c));   // 허용 칸 2개 외에는 절대 쓰지 않는다
    if (!cols.length) continue;
    const vals = cols.map((c) => u.set[c]);
    const setSql = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const r = await client.query(
      `UPDATE products SET ${setSql}, erp_synced_at = now()
        WHERE sku = $${cols.length + 1} AND UPPER(TRIM(COALESCE(cat, ''))) <> 'TOGO SOLUTION'`,
      [...vals, u.sku]);
    applied += r.rowCount;
  }
  return applied;
}

module.exports = { planPhase1, applyPhase1, isTogo, validMoney, validQty };
