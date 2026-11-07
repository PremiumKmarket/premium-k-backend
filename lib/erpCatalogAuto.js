// lib/erpCatalogAuto.js  v1.0 (Site Order v8.8) — ERP 신상품 자동 추가 (일괄 추가 이후)
//
// · 상품 목록(/api/products)을 누가 열 때, 10분에 한 번만 ERP 상품 목록을 받아 사이트에 없는 정식 코드 상품을 넣는다.
//   판단은 일괄 추가와 같은 함수(planAddNew)·같은 전체 목록으로 한다.
// · 일괄 추가(scripts/run-erp-add-new.js --apply)를 한 뒤에만 켜진다(상태 줄이 생기고 enabled=true).
//   일괄 추가 때 그 시점 사이트 상품 SKU를 모두 기록해 두므로(erp_catalog_add_log, 'baseline'),
//   한 번이라도 사이트에 있었다가 관리자 화면에서 지운 상품은 다시 넣지 않는다(관리자 삭제도 기록됨, 'deleted').
// · 상품 목록 응답을 막지 않는다: ERP 조회는 3초에서 끊고, DB는 잠겨 있으면 기다리지 않고 건너뛴다
//   (SKIP LOCKED·lock_timeout·statement_timeout). 실패는 상태 줄에만 남긴다.
// · 한 번에 25개보다 많이 넣어야 하면 넣지 않고 오류로 남긴다(ERP 쪽 실수로 한꺼번에 들어오는 것 방지 —
//   그때는 대표님 PC 실행기로 미리보기 후 넣는다).
// · ERP에서 노출을 끄거나 판매중지한 상품을 사이트에서 내리지는 않는다.
const { planAddNew, applyAddNew, checkProductsSchema } = require('./erpCatalogAdd');

const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

// 상태 한 줄 + SKU 기록. 일괄 추가 실행기가 처음 반영할 때 만든다(배포만으로는 생기지 않음).
//  source: baseline = 일괄 추가 때 이미 사이트에 있던 상품 / bulk = 일괄 추가로 넣음 / auto = 자동으로 넣음 / deleted = 관리자 화면에서 지움
const STATE_SQL = `
CREATE TABLE IF NOT EXISTS erp_catalog_add_state (
  id           INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  cursor       TEXT,
  last_run_at  TIMESTAMPTZ,
  last_ok_at   TIMESTAMPTZ,
  last_result  TEXT,
  last_error   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS erp_catalog_add_log (
  sku          TEXT PRIMARY KEY,
  product_id   INTEGER,
  source       TEXT NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

const INTERVAL_MINUTES = 10;
const TIMEOUT_MS = 3000;
const MAX_AUTO_ADD = 25;

async function fetchCatalog({ since = null, timeoutMs = TIMEOUT_MS, base = process.env.TRONIC_ERP_BASE_URL, secret = process.env.PREMIUM_K_SERVER_SECRET } = {}) {
  if (!base || !secret) throw new Error('ERP 연결 설정 없음(TRONIC_ERP_BASE_URL / PREMIUM_K_SERVER_SECRET)');
  const url = `${String(base).replace(/\/+$/, '')}/api/site-orders/catalog${since ? `?since=${encodeURIComponent(since)}` : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchFn(url, { headers: { 'x-premium-k-server-secret': secret }, signal: controller.signal });
    if (!resp.ok) throw new Error(`ERP 상품 조회 실패 (${resp.status})`);
    const data = await resp.json();
    if (!data || !Array.isArray(data.items)) throw new Error('ERP 응답 형식 이상');
    return data;
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error(`ERP 응답 없음(${timeoutMs}ms)`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 상태 줄이 다른 작업(PC 실행기·되돌리기)에 잡혀 있으면 기다리지 않고 건너뛴다
const STATE_ROW = `(SELECT id FROM erp_catalog_add_state WHERE id = 1 FOR UPDATE SKIP LOCKED)`;

let schemaCache = null;   // 서버 한 대당 한 번만 표 구조를 확인

/**
 * 10분에 한 번만 실제로 돈다. 절대 예외를 밖으로 던지지 않는다(상품 목록 응답을 막지 않게).
 * @param db  lib/db (query, pool)
 * @returns {Promise<{ran: boolean, added?: number, skus?: string[], reason?: string}>}
 */
async function maybeAutoAdd(db, opts = {}) {
  let claim;
  try {
    // 원자적으로 '이번 차례'를 잡는다 — 동시에 여러 요청이 와도 한 요청만 돈다. 잠겨 있으면 바로 건너뜀
    claim = (await db.query(
      `UPDATE erp_catalog_add_state SET last_run_at = now()
        WHERE id = ${STATE_ROW} AND enabled
          AND (last_run_at IS NULL OR last_run_at < now() - make_interval(mins => $1))
        RETURNING id`, [opts.intervalMinutes ?? INTERVAL_MINUTES])).rows[0];
  } catch (err) {
    if (err && err.code === '42P01') return { ran: false, reason: 'no_state_table' };   // 일괄 추가 전
    return { ran: false, reason: 'state_error' };
  }
  if (!claim) return { ran: false, reason: 'not_due_or_disabled' };

  const note = async (fields) => {
    try {
      await db.query(
        `UPDATE erp_catalog_add_state SET cursor = COALESCE($1, cursor),
                last_ok_at = CASE WHEN $2::text IS NULL THEN last_ok_at ELSE now() END,
                last_result = COALESCE($2, last_result), last_error = $3, updated_at = now() WHERE id = ${STATE_ROW}`,
        [fields.cursor || null, fields.result || null, fields.error || null]);
    } catch { /* 상태 기록 실패는 무시 */ }
  };

  let data;
  try {
    data = await fetchCatalog({ timeoutMs: opts.timeoutMs ?? TIMEOUT_MS, base: opts.base, secret: opts.secret });
  } catch (err) {
    await note({ error: String((err && err.message) || err).slice(0, 300) });
    return { ran: true, added: 0, reason: 'erp_unavailable' };
  }

  let client;
  try {
    client = await db.pool.connect();
  } catch (err) {
    await note({ error: `DB 연결 실패: ${String(err.message).slice(0, 200)}` });
    return { ran: true, added: 0, reason: 'db_unavailable' };
  }
  try {
    await client.query('BEGIN');
    // 이 트랜잭션은 오래 기다리지 않는다 — 잠금 1초, 쿼리 3초, 중간에 멈추면 30초 뒤 DB가 끊는다
    await client.query(`SET LOCAL lock_timeout = '1s'`);
    await client.query(`SET LOCAL statement_timeout = '3s'`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = '30s'`);
    // 실행기·되돌리기와 같은 잠금 — 겹치면 이번 차례는 건너뛴다
    const got = (await client.query(`SELECT pg_try_advisory_xact_lock(hashtext('erp_catalog_add')) AS ok`)).rows[0].ok;
    if (!got) { await client.query('ROLLBACK'); return { ran: true, added: 0, reason: 'busy' }; }
    const st = (await client.query('SELECT enabled FROM erp_catalog_add_state WHERE id = 1')).rows[0];
    if (!st || !st.enabled) { await client.query('ROLLBACK'); return { ran: true, added: 0, reason: 'disabled' }; }
    if (!schemaCache || !schemaCache.ok) schemaCache = await checkProductsSchema(client);
    const site = (await client.query('SELECT sku, cat, name_ko, name_en, ctn_qty FROM products')).rows;
    const known = new Set((await client.query('SELECT sku FROM erp_catalog_add_log')).rows.map((r) => r.sku));
    const plan = planAddNew(data.items, site, { knownSkus: known });
    if (plan.add.length > MAX_AUTO_ADD) {
      await client.query('ROLLBACK');
      await note({ error: `자동 추가 대상 ${plan.add.length}개 — ${MAX_AUTO_ADD}개 초과라 넣지 않음(PC 실행기로 미리보기 후 반영)` });
      return { ran: true, added: 0, reason: 'too_many' };
    }
    const inserted = await applyAddNew(client, plan.add, 'auto', schemaCache);
    await client.query('COMMIT');
    const skus = inserted.map((r) => r.sku);
    await note({ cursor: data.latest_change_at,
      result: `${new Date().toISOString()} ERP 상품 ${data.items.length}개 확인, 새로 추가 ${skus.length}개${skus.length ? ` (${skus.slice(0, 10).join(', ')}${skus.length > 10 ? ' …' : ''})` : ''}, 확인 필요 ${plan.review.length}개` });
    return { ran: true, added: skus.length, skus };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await note({ error: `자동 추가 실패: ${String((err && err.message) || err).slice(0, 250)}` });
    return { ran: true, added: 0, reason: 'apply_failed' };
  } finally {
    client.release();
  }
}

// 관리자 화면에서 상품을 지웠을 때 — 자동 추가가 다시 넣지 않게 기록(표가 아직 없으면 = 일괄 추가 전이면 아무것도 안 함)
async function recordSiteDelete(db, sku, productId) {
  if (!sku) return;
  try {
    await db.query(
      `INSERT INTO erp_catalog_add_log (sku, product_id, source) VALUES ($1, $2, 'deleted')
       ON CONFLICT (sku) DO UPDATE SET source = 'deleted', product_id = EXCLUDED.product_id, recorded_at = now()`, [sku, productId || null]);
  } catch (err) {
    if (!err || err.code !== '42P01') console.error('[erp-catalog] delete record failed', err && err.message);
  }
}

module.exports = { STATE_SQL, fetchCatalog, maybeAutoAdd, recordSiteDelete, MAX_AUTO_ADD, INTERVAL_MINUTES, TIMEOUT_MS };
