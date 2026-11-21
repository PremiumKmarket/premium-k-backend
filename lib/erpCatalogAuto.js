// lib/erpCatalogAuto.js  v2.0 (Site Order v8.12) — ERP → 주문 사이트 자동 연동 (신상품 추가 + 가격 반영)
//
// · 처음 한 번은 '일괄 맞추기'(미리보기 → 승인 → 반영)로 시작한다. 반영할 때 그 시점 사이트 상품 SKU를 모두 기록하고
//   (erp_catalog_add_log, 'baseline') 자동 연동을 켠다. 배포만으로는 아무것도 바뀌지 않는다(상태 표가 없으면 쉰다).
// · 그 뒤로는 상품 목록(/api/products)을 누가 열 때 10분에 한 번 ERP 상품 목록을 받아
//     ① 사이트에 없는 정식 코드 상품을 넣고(lib/erpCatalogAdd.js — 일괄과 같은 판단),
//     ② 지난번 이후 ERP에서 바뀐 상품의 박스가·입수·낱개가를 사이트에 반영한다(lib/erpCatalogSync.js).
// · 한 번에 25개보다 많이 넣거나 50개보다 많이 바꿔야 하면 자동으로 하지 않고 상태에 남긴다
//   (ERP 쪽 실수로 한꺼번에 바뀌는 것 방지 — ERP 'Site Order 관리'에서 미리보기 후 반영).
// · 상품 목록 응답을 막지 않는다: ERP 조회는 3초에서 끊고, DB는 잠겨 있으면 기다리지 않고 건너뛴다. 실패는 상태에만 남긴다.
// · 한 번이라도 사이트에 있었다가 관리자 화면에서 지운 상품은 다시 넣지 않는다(지우면 'deleted'로 기록).
// · ERP에서 노출을 끄거나 판매중지한 상품을 사이트에서 내리지는 않는다.
const { planAddNew, applyAddNew, planDigest, checkProductsSchema } = require('./erpCatalogAdd');
const { planUpdate, applyUpdate, updateDigestLines } = require('./erpCatalogSync');
const crypto = require('crypto');

const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

//  erp_catalog_add_log.source: baseline = 일괄 맞추기 때 이미 사이트에 있던 상품 / bulk = 일괄로 넣음 / auto = 자동으로 넣음
//                              deleted = 관리자 화면에서 지움 / rolled_back = 되돌리기로 지움
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
  product_id   TEXT,
  source       TEXT NOT NULL,
  batch        TEXT,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS erp_catalog_price_log (
  id           BIGSERIAL PRIMARY KEY,
  batch        TEXT NOT NULL,
  product_id   TEXT NOT NULL,
  sku          TEXT NOT NULL,
  before       JSONB NOT NULL,
  after        JSONB NOT NULL,
  rolled_back_at TIMESTAMPTZ,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS erp_catalog_price_log_batch ON erp_catalog_price_log (batch)`;

const INTERVAL_MINUTES = 10;
const TIMEOUT_MS = 3000;
const MAX_AUTO_ADD = 25;
const MAX_AUTO_UPDATE = 50;

const newBatch = (kind) => `${kind}-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}-${crypto.randomBytes(2).toString('hex')}`;

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

const SITE_COLS = 'id::text AS id, sku, cat, name_ko, name_en, ctn_qty, ctn_price, price, tbd';
async function loadKnown(client) {
  const has = (await client.query(`SELECT to_regclass('erp_catalog_add_log') AS l`)).rows[0].l;
  return new Set(has ? (await client.query('SELECT sku FROM erp_catalog_add_log')).rows.map((r) => r.sku) : []);
}

// 일괄 맞추기 계획(읽기만): 넣을 상품 + 바꿀 가격 + 확인 필요. 미리보기와 반영이 같은 함수를 쓴다.
async function buildPlan(client, data) {
  const schema = await checkProductsSchema(client);
  const site = (await client.query(`SELECT ${SITE_COLS} FROM products`)).rows;
  const known = await loadKnown(client);
  const add = planAddNew(data.items, site, { knownSkus: known });
  const upd = planUpdate(data.items, site, {});
  const digest = crypto.createHash('sha256')
    .update(planDigest(add.add) + '\n' + updateDigestLines(upd.update).sort().join('\n')).digest('hex').slice(0, 12);
  return { schema, siteCount: site.length, add, upd, digest };
}

function planSummary(p) {
  return {
    siteCount: p.siteCount,
    schemaOk: p.schema.ok, schemaProblems: p.schema.problems,
    digest: p.digest,
    add: { count: p.add.add.length, tbd: p.add.counts.tbd, byCat: p.add.counts.byCat, exists: p.add.counts.exists, togo: p.add.counts.togo, removed: p.add.counts.removed },
    addReview: p.add.review.length,
    update: { count: p.upd.update.length, same: p.upd.counts.same, noErpPrice: p.upd.counts.noErpPrice, togo: p.upd.counts.togo },
    updateReview: p.upd.review.length,
  };
}

async function sessionGuards(client) {
  await client.query(`SET LOCAL lock_timeout = '5s'`);
  await client.query(`SET LOCAL statement_timeout = '20s'`);
  await client.query(`SET LOCAL idle_in_transaction_session_timeout = '30s'`);
}

// 미리보기 — DB를 바꾸지 않는다(READ ONLY 트랜잭션)
async function preview(db, data) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await sessionGuards(client);
    const p = await buildPlan(client, data);
    await client.query('COMMIT');
    return p;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// 일괄 반영 — 미리보기의 지문·수와 같을 때만. 한 트랜잭션. 반영 뒤 자동 연동을 켠다(enableAuto=false면 켜지 않음).
async function applyBulk(db, data, { expectAdd, expectUpdate, plan, enableAuto = true }) {
  const client = await db.pool.connect();
  const batch = newBatch('bulk');
  try {
    await client.query('BEGIN');
    await sessionGuards(client);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('erp_catalog_add'))`);
    await client.query('LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE');   // 반영하는 동안 관리자 화면의 상품 추가·수정은 잠깐 기다림
    await client.query(STATE_SQL);
    const p = await buildPlan(client, data);
    if (!p.schema.ok) throw Object.assign(new Error(`상품 표 구조가 예상과 다름: ${p.schema.problems.join(', ')} — 아무것도 바꾸지 않았습니다.`), { status: 409 });
    if (p.add.add.length !== expectAdd || p.upd.update.length !== expectUpdate || p.digest !== plan) {
      throw Object.assign(new Error(`미리보기 뒤로 ERP나 사이트가 바뀌었습니다 (지금 추가 ${p.add.add.length}·가격 ${p.upd.update.length}·지문 ${p.digest}) — 다시 미리보기 하세요. 아무것도 바꾸지 않았습니다.`), { status: 409 });
    }
    await client.query(
      `INSERT INTO erp_catalog_add_log (sku, product_id, source, batch)
       SELECT sku, id::text, 'baseline', $1 FROM products WHERE sku IS NOT NULL AND btrim(sku) <> ''
       ON CONFLICT (sku) DO NOTHING`, [batch]);
    const inserted = await applyAddNew(client, p.add.add, 'bulk', p.schema);
    if (inserted.length !== expectAdd) throw Object.assign(new Error(`실제로 들어간 수가 다릅니다 (${inserted.length}/${expectAdd}) — 모두 취소했습니다.`), { status: 409 });
    await client.query(`UPDATE erp_catalog_add_log SET batch = $1 WHERE source = 'bulk' AND sku = ANY($2::text[])`, [batch, inserted.map((r) => r.sku)]);
    const changed = await applyUpdate(client, p.upd.update, batch, p.schema);
    if (changed.length !== expectUpdate) throw Object.assign(new Error(`실제로 바뀐 가격 수가 다릅니다 (${changed.length}/${expectUpdate}) — 모두 취소했습니다.`), { status: 409 });
    const result = `${new Date().toISOString()} 일괄 맞추기 ${batch}: 추가 ${inserted.length}개, 가격 반영 ${changed.length}개`;
    await client.query(
      `INSERT INTO erp_catalog_add_state (id, enabled, cursor, last_ok_at, last_result, last_error, updated_at)
       VALUES (1, $1, $2, now(), $3, NULL, now())
       ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, cursor = COALESCE(EXCLUDED.cursor, erp_catalog_add_state.cursor),
         last_ok_at = now(), last_result = EXCLUDED.last_result, last_error = NULL, updated_at = now()`,
      [!!enableAuto, data.latest_change_at || null, result]);
    await client.query('COMMIT');
    return { batch, added: inserted, updated: changed, autoEnabled: !!enableAuto };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// 상태 줄이 다른 작업(일괄·되돌리기)에 잡혀 있으면 기다리지 않고 건너뛴다
const STATE_ROW = `(SELECT id FROM erp_catalog_add_state WHERE id = 1 FOR UPDATE SKIP LOCKED)`;
let schemaCache = null;   // 서버 한 대당 한 번만 표 구조를 확인

/**
 * 자동 연동 한 차례. 10분에 한 번만 실제로 돈다(force=true면 바로). 절대 예외를 밖으로 던지지 않는다(상품 목록 응답을 막지 않게).
 * @returns {Promise<{ran: boolean, added?: number, updated?: number, reason?: string}>}
 */
async function maybeAutoSync(db, opts = {}) {
  let claim;
  try {
    claim = (await db.query(
      `UPDATE erp_catalog_add_state SET last_run_at = now()
        WHERE id = ${STATE_ROW} AND enabled
          AND ($2::boolean OR last_run_at IS NULL OR last_run_at < now() - make_interval(mins => $1))
        RETURNING id, cursor`, [opts.intervalMinutes ?? INTERVAL_MINUTES, !!opts.force])).rows[0];
  } catch (err) {
    if (err && err.code === '42P01') return { ran: false, reason: 'no_state_table' };   // 일괄 맞추기 전
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
    return { ran: true, added: 0, updated: 0, reason: 'erp_unavailable' };
  }

  let client;
  try {
    client = await db.pool.connect();
  } catch (err) {
    await note({ error: `DB 연결 실패: ${String(err.message).slice(0, 200)}` });
    return { ran: true, added: 0, updated: 0, reason: 'db_unavailable' };
  }
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '1s'`);
    await client.query(`SET LOCAL statement_timeout = '3s'`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = '30s'`);
    const got = (await client.query(`SELECT pg_try_advisory_xact_lock(hashtext('erp_catalog_add')) AS ok`)).rows[0].ok;
    if (!got) { await client.query('ROLLBACK'); return { ran: true, added: 0, updated: 0, reason: 'busy' }; }
    const st = (await client.query('SELECT enabled, cursor FROM erp_catalog_add_state WHERE id = 1')).rows[0];
    if (!st || !st.enabled) { await client.query('ROLLBACK'); return { ran: true, added: 0, updated: 0, reason: 'disabled' }; }
    if (!schemaCache || !schemaCache.ok) schemaCache = await checkProductsSchema(client);
    const site = (await client.query(`SELECT ${SITE_COLS} FROM products`)).rows;
    const known = new Set((await client.query('SELECT sku FROM erp_catalog_add_log')).rows.map((r) => r.sku));
    const addPlan = planAddNew(data.items, site, { knownSkus: known });
    const updPlan = planUpdate(data.items, site, { since: st.cursor });
    const problems = [];
    let addRows = addPlan.add, updRows = updPlan.update, holdCursor = false;
    if (addRows.length > MAX_AUTO_ADD) { problems.push(`추가 대상 ${addRows.length}개 — ${MAX_AUTO_ADD}개 초과라 넣지 않음`); addRows = []; }
    if (updRows.length > MAX_AUTO_UPDATE) { problems.push(`가격 반영 대상 ${updRows.length}개 — ${MAX_AUTO_UPDATE}개 초과라 바꾸지 않음`); updRows = []; holdCursor = true; }
    const batch = newBatch('auto');
    const inserted = await applyAddNew(client, addRows, 'auto', schemaCache);
    if (inserted.length) await client.query(`UPDATE erp_catalog_add_log SET batch = $1 WHERE source = 'auto' AND sku = ANY($2::text[])`, [batch, inserted.map((r) => r.sku)]);
    const changed = await applyUpdate(client, updRows, batch, schemaCache);
    await client.query('COMMIT');
    const addSkus = inserted.map((r) => r.sku), updSkus = changed.map((r) => r.sku);
    const list = (a) => (a.length ? ` (${a.slice(0, 8).join(', ')}${a.length > 8 ? ' …' : ''})` : '');
    const review = addPlan.review.length + updPlan.review.length;
    await note({
      // 가격 반영을 보류했으면 시각을 앞으로 옮기지 않는다 — 다음 일괄 맞추기 때 빠지지 않게
      cursor: holdCursor ? null : data.latest_change_at,
      result: `${new Date().toISOString()} ${batch}: ERP 상품 ${data.items.length}개 확인, 새로 추가 ${addSkus.length}개${list(addSkus)}, 가격 반영 ${updSkus.length}개${list(updSkus)}, 확인 필요 ${review}개`,
      error: problems.length ? `${problems.join(' / ')} — ERP 'Site Order 관리'에서 미리보기 후 반영` : null,
    });
    return { ran: true, added: addSkus.length, updated: updSkus.length, skus: addSkus, updatedSkus: updSkus, held: problems };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await note({ error: `자동 연동 실패: ${String((err && err.message) || err).slice(0, 250)}` });
    return { ran: true, added: 0, updated: 0, reason: 'apply_failed' };
  } finally {
    client.release();
  }
}

// 되돌리기: 한 차례(batch)에 넣은 상품을 지우고 바꾼 가격을 되돌린다. 그 뒤로 누가 손댄 상품은 건너뛴다.
// apply=false 면 무엇을 되돌릴지 보기만 한다. 되돌리면 자동 연동을 끈다(다시 켜는 것은 따로).
async function rollbackBatch(db, batch, { apply = false } = {}) {
  const client = await db.pool.connect();
  try {
    await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    await sessionGuards(client);
    if (apply) await client.query(`SELECT pg_advisory_xact_lock(hashtext('erp_catalog_add'))`);
    const adds = (await client.query(
      `SELECT l.sku, l.product_id, l.recorded_at, p.id::text AS live_id, p.updated_at
         FROM erp_catalog_add_log l LEFT JOIN products p ON p.id::text = l.product_id
        WHERE l.batch = $1 AND l.source IN ('bulk', 'auto')`, [batch])).rows;
    // 넣은 뒤 누가 고친 상품(수정 시각이 넣은 시각보다 5초 넘게 뒤)은 지우지 않는다
    const delAdds = adds.filter((a) => a.live_id && (!a.updated_at || new Date(a.updated_at) - new Date(a.recorded_at) <= 5000));
    const keptAdds = adds.filter((a) => a.live_id && !delAdds.includes(a));
    const prices = (await client.query(
      `SELECT l.id, l.product_id, l.sku, l.before, l.after, p.ctn_price, p.ctn_qty, p.price, p.tbd
         FROM erp_catalog_price_log l LEFT JOIN products p ON p.id::text = l.product_id
        WHERE l.batch = $1 AND l.rolled_back_at IS NULL`, [batch])).rows;
    const same = (r) => r.after && Number(r.ctn_price) === Number(r.after.ctn_price) && (r.ctn_qty == null ? null : Number(r.ctn_qty)) === r.after.ctn_qty
      && (r.price == null ? null : Number(r.price)) === r.after.price && !!r.tbd === !!r.after.tbd;
    const undoPrices = prices.filter((r) => r.product_id && same(r));
    const keptPrices = prices.filter((r) => !undoPrices.includes(r));
    if (!apply) { await client.query('COMMIT'); return { batch, apply: false, deleteCount: delAdds.length, keepAdds: keptAdds.map((a) => a.sku), restoreCount: undoPrices.length, keepPrices: keptPrices.map((r) => r.sku) }; }
    if (delAdds.length) {
      await client.query('DELETE FROM products WHERE id::text = ANY($1::text[])', [delAdds.map((a) => a.live_id)]);
      await client.query(`UPDATE erp_catalog_add_log SET source = 'rolled_back', recorded_at = now() WHERE sku = ANY($1::text[])`, [delAdds.map((a) => a.sku)]);
    }
    if (undoPrices.length) {
      await client.query(
        `WITH x AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(id text, ctn_price numeric, ctn_qty int, price numeric, tbd boolean))
         UPDATE products p SET ctn_price = x.ctn_price, ctn_qty = x.ctn_qty, price = x.price, tbd = x.tbd, updated_at = now()
           FROM x WHERE p.id::text = x.id`,
        [JSON.stringify(undoPrices.map((r) => ({ id: r.product_id, ...r.before })))]);
      await client.query('UPDATE erp_catalog_price_log SET rolled_back_at = now() WHERE id = ANY($1::bigint[])', [undoPrices.map((r) => r.id)]);
    }
    await client.query(`UPDATE erp_catalog_add_state SET enabled = false, last_result = $1, updated_at = now() WHERE id = 1`,
      [`${new Date().toISOString()} 되돌리기 ${batch}: 상품 ${delAdds.length}개 지움, 가격 ${undoPrices.length}개 되돌림 — 자동 연동 꺼짐`]);
    await client.query('COMMIT');
    return { batch, apply: true, deleted: delAdds.length, keepAdds: keptAdds.map((a) => a.sku), restored: undoPrices.length, keepPrices: keptPrices.map((r) => r.sku), autoEnabled: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function getStatus(db) {
  try {
    const st = (await db.query('SELECT enabled, cursor, last_run_at, last_ok_at, last_result, last_error, updated_at FROM erp_catalog_add_state WHERE id = 1')).rows[0] || null;
    const bySource = (await db.query('SELECT source, count(*)::int AS n FROM erp_catalog_add_log GROUP BY source ORDER BY source')).rows;
    const batches = (await db.query(
      `SELECT batch, max(at) AS at, sum(adds)::int AS adds, sum(prices)::int AS prices FROM (
         SELECT batch, max(recorded_at) AS at, count(*) AS adds, 0 AS prices FROM erp_catalog_add_log WHERE source IN ('bulk', 'auto') AND batch IS NOT NULL GROUP BY batch
         UNION ALL
         SELECT batch, max(recorded_at), 0, count(*) FROM erp_catalog_price_log WHERE rolled_back_at IS NULL GROUP BY batch) t
       GROUP BY batch ORDER BY max(at) DESC LIMIT 20`)).rows;
    return { set: !!st, state: st, bySource, batches };
  } catch (err) {
    if (err && err.code === '42P01') return { set: false, state: null, bySource: [], batches: [] };
    throw err;
  }
}

async function setAuto(db, enabled) {
  const r = await db.query(`UPDATE erp_catalog_add_state SET enabled = $1, updated_at = now() WHERE id = 1 RETURNING enabled`, [!!enabled])
    .catch((e) => (e.code === '42P01' ? { rows: [] } : Promise.reject(e)));
  return r.rows[0] ? r.rows[0].enabled : null;
}

// 관리자 화면에서 상품을 지웠을 때 — 자동 추가가 다시 넣지 않게 기록(표가 아직 없으면 = 일괄 맞추기 전이면 아무것도 안 함)
async function recordSiteDelete(db, sku, productId) {
  if (!sku) return;
  try {
    await db.query(
      `INSERT INTO erp_catalog_add_log (sku, product_id, source) VALUES ($1, $2, 'deleted')
       ON CONFLICT (sku) DO UPDATE SET source = 'deleted', product_id = EXCLUDED.product_id, recorded_at = now()`, [sku, productId == null ? null : String(productId)]);
  } catch (err) {
    if (!err || err.code !== '42P01') console.error('[erp-catalog] delete record failed', err && err.message);
  }
}

module.exports = {
  STATE_SQL, fetchCatalog, buildPlan, planSummary, preview, applyBulk, maybeAutoSync, maybeAutoAdd: maybeAutoSync,
  rollbackBatch, getStatus, setAuto, recordSiteDelete, MAX_AUTO_ADD, MAX_AUTO_UPDATE, INTERVAL_MINUTES, TIMEOUT_MS,
};
