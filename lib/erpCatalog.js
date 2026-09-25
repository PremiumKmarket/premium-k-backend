// lib/erpCatalog.js
// v1.0 — Tronic ERP에서 상품·가격을 받아와 Site Order DB에 반영한다.
//  · ERP가 상품 정보의 단일 기준이다. 이름·분류·가격·규격·박스입수는 ERP 값으로 덮어쓴다.
//  · Site Order에서만 관리하는 값(사진 img/img_page, 상세페이지 url, 뚜껑·색상 옵션, 정렬 순서)은 건드리지 않는다.
//  · ERP에서 노출 해제·판매중지된 상품은 지우지 않고 hidden=true로 숨긴다(사진·옵션 보존).
//  · 처음에는 전체를, 그다음부터는 "지난번 이후 바뀐 것"만 받아온다(erp_catalog_sync에 기억).
//  · 인증: 주문 전달과 같은 서버 간 비밀키(PREMIUM_K_SERVER_SECRET). 브라우저에서는 호출할 수 없다.
const db = require('./db');

const ERP_BASE = process.env.TRONIC_ERP_BASE_URL;          // 예: https://tronic-erp2-production.up.railway.app
const SECRET = process.env.PREMIUM_K_SERVER_SECRET;

async function readState() {
  const { rows } = await db.query(`SELECT * FROM erp_catalog_sync WHERE id = 1`);
  return rows[0] || {};
}

async function writeState(patch, result) {
  await db.query(
    `UPDATE erp_catalog_sync
        SET last_change_at = COALESCE($1, last_change_at),
            last_fingerprint = COALESCE($2, last_fingerprint),
            last_run_at = now(), last_result = $3
      WHERE id = 1`,
    [patch.last_change_at || null, patch.last_fingerprint || null, result]
  );
}

/**
 * ERP에서 상품을 받아 반영한다.
 * @param {{full?: boolean}} opts full=true면 지난 기록을 무시하고 전체를 다시 받는다.
 * @returns {Promise<{updated:number, inserted:number, hidden:number, skipped:boolean, checkedAt:string}>}
 */
async function syncCatalogFromErp(opts = {}) {
  if (!ERP_BASE || !SECRET) {
    throw new Error('ERP 연동 설정이 없습니다 (TRONIC_ERP_BASE_URL / PREMIUM_K_SERVER_SECRET).');
  }
  const state = await readState();
  const since = opts.full ? null : state.last_change_at;
  const url = `${ERP_BASE}/api/site-orders/catalog${since ? `?since=${encodeURIComponent(since)}` : ''}`;

  const resp = await fetch(url, { headers: { 'x-premium-k-server-secret': SECRET } });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    await writeState({}, `FAILED ${resp.status}`);
    throw new Error(`ERP 상품 조회 실패 (${resp.status}) ${body.slice(0, 200)}`);
  }
  const data = await resp.json();

  // 지문이 그대로면 바뀐 것이 없다 — 전체 재동기화(full)일 때는 그래도 진행한다.
  if (!opts.full && state.last_fingerprint && data.fingerprint === state.last_fingerprint) {
    await writeState({ last_change_at: data.latest_change_at, last_fingerprint: data.fingerprint }, 'SKIPPED (변경 없음)');
    return { updated: 0, inserted: 0, hidden: 0, skipped: true, checkedAt: data.generated_at };
  }

  let updated = 0, inserted = 0, hiddenCount = 0;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const it of data.items || []) {
      if (!it.sku) continue;
      if (it.removed) {
        const r = await client.query(
          `UPDATE products SET hidden = TRUE, erp_synced_at = now() WHERE sku = $1 AND hidden = FALSE`, [it.sku]);
        hiddenCount += r.rowCount;
        continue;
      }
      // 가격이 둘 다 비어 있으면 "가격 문의"(tbd)로 표시한다.
      const tbd = it.price == null && it.ctnPrice == null;
      const price = it.price != null ? it.price : 0;
      const upd = await client.query(
        `UPDATE products
            SET cat = COALESCE($2, cat), name_ko = COALESCE($3, name_ko), name_en = $4,
                price = $5, ctn_price = $6, ctn_qty = $7, spec = $8, tbd = $9,
                hidden = FALSE, erp_synced_at = now(), updated_at = now()
          WHERE sku = $1 RETURNING id`,
        [it.sku, it.cat, it.nameKo, it.nameEn || null, price, it.ctnPrice, it.ctnQty, it.spec, tbd]);
      if (upd.rowCount) { updated += upd.rowCount; continue; }
      // ERP에만 있는 새 상품 — 사진·옵션은 비어 있는 채로 등록되고, 관리자 화면에서 채우면 된다.
      await client.query(
        `INSERT INTO products (sku, cat, name_ko, name_en, price, ctn_price, ctn_qty, spec, tbd, hidden, erp_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE,now())`,
        [it.sku, it.cat || '기타', it.nameKo || it.nameEn || it.sku, it.nameEn || null, price, it.ctnPrice, it.ctnQty, it.spec, tbd]);
      inserted += 1;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    await writeState({}, `FAILED ${e.message.slice(0, 200)}`);
    throw e;
  } finally {
    client.release();
  }

  await writeState(
    { last_change_at: data.latest_change_at, last_fingerprint: data.fingerprint },
    `OK 수정 ${updated} / 신규 ${inserted} / 숨김 ${hiddenCount}`
  );
  return { updated, inserted, hidden: hiddenCount, skipped: false, checkedAt: data.generated_at };
}

module.exports = { syncCatalogFromErp, readState };
