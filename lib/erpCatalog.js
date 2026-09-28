// lib/erpCatalog.js  v1.1 — ERP → Site Order 동기화 (1차: 박스가·입수 전용)
//
// 확정 정책 (2026-09-25)
//  · 1차에서 ERP 값으로 갱신하는 칸은 2개뿐: 박스가(ctn_price), 박스입수(ctn_qty)
//  · 낱개가(price)는 1차에서 갱신하지 않는다 (ERP가 진짜 낱개가를 따로 공급하고 검증된 뒤 다음 단계)
//  · 이름·분류·규격·사진·상세주소·TOGO 옵션은 건드리지 않는다
//  · 신규 상품 추가, 숨김, 삭제는 하지 않는다 (신규는 ERP 분류 정리 후 별도 단계)
//  · TOGO SOLUTION 상품은 제외
//  · ERP 값이 없거나 유효하지 않으면 기존 사이트 값 유지
// 판단 로직은 lib/erpCatalogPhase1.js 에 있고, DRY RUN 도구도 같은 함수를 쓴다.
const db = require('./db');
const { planPhase1, applyPhase1 } = require('./erpCatalogPhase1');

const ERP_BASE = process.env.TRONIC_ERP_BASE_URL;
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
    [patch.last_change_at || null, patch.last_fingerprint || null, result]);
}

async function fetchErpCatalog() {
  if (!ERP_BASE || !SECRET) throw new Error('ERP 연동 설정이 없습니다 (TRONIC_ERP_BASE_URL / PREMIUM_K_SERVER_SECRET).');
  const resp = await fetch(`${ERP_BASE}/api/site-orders/catalog`, { headers: { 'x-premium-k-server-secret': SECRET } });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`ERP 상품 조회 실패 (${resp.status}) ${body.slice(0, 200)}`);
  }
  return resp.json();
}

/**
 * 1차 동기화 (박스가·입수만)
 * @param {{force?: boolean}} opts force=true면 지문이 같아도 다시 계산한다
 */
async function syncCatalogFromErp(opts = {}) {
  const state = await readState();
  let data;
  try { data = await fetchErpCatalog(); }
  catch (e) { await writeState({}, `FAILED ${e.message.slice(0, 200)}`); throw e; }

  // 지문이 같으면 ERP 쪽에 바뀐 것이 없다
  if (!opts.force && state.last_fingerprint && data.fingerprint === state.last_fingerprint) {
    await writeState({ last_change_at: data.latest_change_at, last_fingerprint: data.fingerprint }, 'SKIPPED (변경 없음)');
    return { skipped: true, updated: 0, checkedAt: data.generated_at };
  }

  const { rows: site } = await db.query(`SELECT sku, cat, name_ko, name_en, price, ctn_price, ctn_qty, tbd FROM products`);
  const plan = planPhase1(data.items, site);

  const client = await db.pool.connect();
  let applied = 0;
  try {
    await client.query('BEGIN');
    applied = await applyPhase1(client, plan);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    await writeState({}, `FAILED ${e.message.slice(0, 200)}`);
    throw e;
  } finally { client.release(); }

  const c = plan.counts;
  await writeState({ last_change_at: data.latest_change_at, last_fingerprint: data.fingerprint },
    `OK 1차(박스가·입수) 대상 ${c.target} / 변경 ${applied} (박스가 ${c.field.ctn_price}, 입수 ${c.field.ctn_qty})`);
  return { skipped: false, updated: applied, counts: c, checkedAt: data.generated_at };
}

module.exports = { syncCatalogFromErp, readState, fetchErpCatalog };
