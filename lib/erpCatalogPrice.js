// lib/erpCatalogPrice.js  v1.0 — ERP → Site Order 2차 동기화 (낱개가 전용)
//
// 바꾸는 칸: Site Order products.price 딱 하나. (erp_synced_at 도 건드리지 않는다)
// ERP 값: piecePrice 만 쓴다. unit_price, 옛 price 칸, 박스가로 계산한 값은 절대 쓰지 않는다.
// 대상: SKU 가 정확히 같고 TOGO 가 아닌 상품. 신규 추가·숨김·삭제 없음.
//
// 모든 대상 SKU 는 아래 8개 중 정확히 하나로 분류된다. 판정 우선순위(위에서부터 먼저 맞는 것):
//  1) REVIEW_QTY_TO_ONE    사이트 입수 > 1 인데 ERP 입수 = 1
//  2) SKIP_PRICE_INQUIRY   사이트의 명시적 "가격 문의" 표시(tbd=true)만 기준 — price=0 이라는 이유로 추정하지 않는다
//  3) SKIP_NO_PIECE_PRICE  ERP piecePrice 가 없음/0 (구버전 ERP 포함)
//  4) REVIEW_DATA_MISSING  piecePrice 는 있지만 검증에 필요한 ERP 박스가·ERP 입수, 또는 사이트 현재 낱개가가 없음/0
//  5) REVIEW_RATIO         ERP 박스가 ÷ (ERP 입수 × ERP 낱개가) 가 0.65~1.35 밖
//  6) REVIEW_PRICE_JUMP    사이트 현재 낱개가 대비 50% 초과 변동
//  7) UNCHANGED            사이트 낱개가 = ERP piecePrice
//  8) AUTO_UPDATE          나머지 → 자동 반영 후보
// 비율 검사는 ERP 값 세 개로만 계산한다(사이트 값으로 대신하지 않는다).
//
// planPrice 는 계산만 한다(읽기 전용) — DRY RUN 과 실제 실행이 같은 함수를 쓴다. applyPrice 만 DB 에 쓴다.
const { isTogo } = require('./erpCatalogPhase1');
const { pos, ratioCheck, qtyToOne, priceJump } = require('./erpCatalogGuards');

// 판정 우선순위 순서 (위 주석 1~8 과 같다)
const BUCKETS = ['REVIEW_QTY_TO_ONE', 'SKIP_PRICE_INQUIRY', 'SKIP_NO_PIECE_PRICE', 'REVIEW_DATA_MISSING',
  'REVIEW_RATIO', 'REVIEW_PRICE_JUMP', 'UNCHANGED', 'AUTO_UPDATE'];
const cents = (v) => Math.round(Number(v) * 100) / 100;

function planPrice(erpItems, siteRows) {
  const visible = (erpItems || []).filter((i) => !i.removed);
  const erp = new Map(visible.map((i) => [String(i.sku), i]));
  const erpSendsPiece = visible.some((i) => Object.prototype.hasOwnProperty.call(i, 'piecePrice'));
  const rows = []; const updates = [];
  const counts = { target: 0, togoSkipped: 0, siteOnlySkipped: 0, bucket: Object.fromEntries(BUCKETS.map((b) => [b, 0])) };

  for (const s of siteRows) {
    const sku = String(s.sku);
    if (isTogo(s)) { counts.togoSkipped++; continue; }
    const e = erp.get(sku);
    if (!e) { counts.siteOnlySkipped++; continue; }
    counts.target++;
    const piece = pos(e.piecePrice);
    const base = { sku, name: s.name_ko || s.name_en || '', cur: s.price ?? null, erp: piece, ctnPrice: e.ctnPrice ?? null, ctnQty: e.ctnQty ?? null, ratio: null };
    const put = (bucket, reason, extra = {}) => { counts.bucket[bucket]++; rows.push({ ...base, ...extra, bucket, reason }); };

    // 1) 입수 1로 떨어짐
    if (qtyToOne(s.ctn_qty, e.ctnQty)) { put('REVIEW_QTY_TO_ONE', `사이트 입수 ${s.ctn_qty} → ERP 1`); continue; }
    // 2) 가격 문의 (명시적 표시만)
    if (s.tbd === true) { put('SKIP_PRICE_INQUIRY', '사이트 "가격 문의" 상품 — 자동 동기화 제외'); continue; }
    // 3) ERP 낱개가 없음
    if (piece == null) { put('SKIP_NO_PIECE_PRICE', erpSendsPiece ? 'ERP 낱개가 없음 — 기존 값 유지' : 'ERP 구버전(piecePrice 없음) — 보류'); continue; }
    const newP = cents(piece);
    // 4) 검증에 필요한 다른 값이 없음
    const k = ratioCheck(e.ctnPrice, e.ctnQty, newP);   // ERP 값만
    if (k.code === 'REVIEW_DATA_MISSING') { put('REVIEW_DATA_MISSING', k.reason.replace('박스가', 'ERP 박스가').replace('입수', 'ERP 입수')); continue; }
    if (pos(s.price) == null) { put('REVIEW_DATA_MISSING', '사이트 현재 낱개가 없음/0 — 급변 비교 불가', { ratio: k.ratio }); continue; }
    // 5) 비율
    if (k.code === 'REVIEW_RATIO') { put('REVIEW_RATIO', k.reason, { ratio: k.ratio }); continue; }
    // 6) 급변
    const j = priceJump(s.price, newP);
    if (j && j.jump) { put('REVIEW_PRICE_JUMP', `낱개가 ${s.price} → ${newP} (${j.rate}% 변동, 기준 50%)`, { ratio: k.ratio }); continue; }
    // 7) 같음
    if (cents(s.price) === newP) { put('UNCHANGED', '같음', { ratio: k.ratio }); continue; }
    // 8) 자동 반영
    put('AUTO_UPDATE', `낱개가 ${s.price} → ${newP}${j ? ` (${j.rate}%)` : ''}`, { ratio: k.ratio });
    updates.push({ sku, set: { price: newP }, before: { price: s.price ?? null } });
  }
  const sum = Object.values(counts.bucket).reduce((a, b) => a + b, 0);
  counts.bucketSumOk = sum === counts.target;
  return { rows, updates, counts, erpSendsPiece, BUCKETS };
}

/** 계획대로 price 한 칸만 쓴다. TOGO 는 SQL 조건으로 한 번 더 막는다. */
async function applyPrice(client, plan) {
  let applied = 0;
  for (const u of plan.updates) {
    const r = await client.query(
      `UPDATE products SET price = $1 WHERE sku = $2 AND UPPER(TRIM(COALESCE(cat, ''))) <> 'TOGO SOLUTION'`,
      [u.set.price, u.sku]);
    applied += r.rowCount;
  }
  return applied;
}

module.exports = { planPrice, applyPrice, BUCKETS };
