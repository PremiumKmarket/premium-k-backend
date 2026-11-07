// lib/erpCatalogAuto.js  v1.0 (Site Order v8.8) — ERP 신상품 자동 추가 (일괄 추가 이후)
//
// · 상품 목록(/api/products)을 누가 열 때, 10분에 한 번만 ERP 상품 목록을 받아
//   '지난번 이후 ERP에서 바뀐(새로 등록·수정된) 상품' 중 사이트에 없는 정식 코드 상품을 넣는다.
//   판단은 일괄 추가와 같은 함수(planAddNew)를 쓰고, 중복 코드 판단에는 ERP 전체 목록을 쓴다.
// · 일괄 추가(scripts/run-erp-add-new.js --apply)를 한 뒤에만 켜진다(상태 줄이 생기고 enabled=true).
// · ERP가 느리거나 꺼져 있어도 상품 목록은 그대로 나온다: ERP 조회는 3초에서 끊고, 실패는 상태 줄에만 남긴다.
// · 한 번에 25개보다 많이 넣어야 하면 넣지 않고 오류로 남긴다(ERP 쪽 실수로 한꺼번에 들어오는 것 방지 —
//   그때는 대표님 PC 실행기로 미리보기 후 넣는다).
// · ERP에서 노출을 끄거나 판매중지한 상품을 사이트에서 내리지는 않는다.
// · 이 도구가 넣었다가 사이트 관리자 화면에서 지운 상품은 다시 넣지 않는다(erp_catalog_add_log).
const { planAddNew, applyAddNew } = require('./erpCatalogAdd');

const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

// 상태 한 줄 + 넣은 상품 기록. 일괄 추가 실행기가 처음 반영할 때 만든다(배포만으로는 생기지 않음).
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
  sku         TEXT PRIMARY KEY,
  product_id  INTEGER,
  source      TEXT NOT NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

const INTERVAL_MINUTES = 10;
const TIMEOUT_MS = 3000;
const MAX_AUTO_ADD = 25;
const OVERLAP_MS = 15 * 60 * 1000;   // ERP 저장 시각과 커밋 시각 차이로 빠지는 상품이 없게 15분 겹쳐서 본다(이미 있는 상품은 어차피 건너뜀)

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

// ERP가 주는 시각 문자열("2026-09-23 11:45:53.121587+00", "2026-09-23T11:45:53Z" 등) → 밀리초. 못 읽으면 null.
function parseErpTime(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(String(v || '').trim());
  if (!m) return null;
  const frac = m[7] ? Number(`0.${m[7]}`) * 1000 : 0;
  let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + frac;
  const tz = m[8];
  if (tz && tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const d = tz.slice(1).replace(':', '');
    ms -= sign * (Number(d.slice(0, 2)) * 60 + Number(d.slice(2, 4) || 0)) * 60000;
  }
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 10분에 한 번만 실제로 돈다. 절대 예외를 밖으로 던지지 않는다(상품 목록 응답을 막지 않게).
 * @param db  lib/db (query, pool)
 * @returns {Promise<{ran: boolean, added?: number, skus?: string[], reason?: string}>}
 */
async function maybeAutoAdd(db, opts = {}) {
  let claim;
  try {
    // 원자적으로 '이번 차례'를 잡는다 — 동시에 여러 요청이 와도 한 요청만 돈다
    claim = (await db.query(
      `UPDATE erp_catalog_add_state SET last_run_at = now()
        WHERE id = 1 AND enabled AND cursor IS NOT NULL
          AND (last_run_at IS NULL OR last_run_at < now() - make_interval(mins => $1))
        RETURNING cursor`, [opts.intervalMinutes ?? INTERVAL_MINUTES])).rows[0];
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
                last_result = COALESCE($2, last_result), last_error = $3, updated_at = now() WHERE id = 1`,
        [fields.cursor || null, fields.result || null, fields.error || null]);
    } catch { /* 상태 기록 실패는 무시 */ }
  };

  const cursorMs = parseErpTime(claim.cursor);
  if (cursorMs === null) { await note({ error: `기준 시각을 읽을 수 없음: ${String(claim.cursor).slice(0, 60)}` }); return { ran: true, added: 0, reason: 'bad_cursor' }; }

  let data;
  try {
    data = await fetchCatalog({ timeoutMs: opts.timeoutMs ?? TIMEOUT_MS, base: opts.base, secret: opts.secret });
  } catch (err) {
    await note({ error: String((err && err.message) || err).slice(0, 300) });
    return { ran: true, added: 0, reason: 'erp_unavailable' };
  }
  if (parseErpTime(data.latest_change_at) === null) {
    await note({ error: 'ERP 응답에 최신 변경 시각이 없음' });
    return { ran: true, added: 0, reason: 'bad_response' };
  }
  const changed = new Set(data.items
    .filter((i) => { const t = parseErpTime(i.updatedAt); return t === null || t > cursorMs - OVERLAP_MS; })
    .map((i) => String(i.sku || '').trim()));

  let client;
  try {
    client = await db.pool.connect();
  } catch (err) {
    await note({ error: `DB 연결 실패: ${String(err.message).slice(0, 200)}` });
    return { ran: true, added: 0, reason: 'db_unavailable' };
  }
  try {
    await client.query('BEGIN');
    // 실행기·되돌리기와 같은 잠금 — 겹치면 이번 차례는 건너뛴다
    const got = (await client.query(`SELECT pg_try_advisory_xact_lock(hashtext('erp_catalog_add')) AS ok`)).rows[0].ok;
    if (!got) { await client.query('ROLLBACK'); return { ran: true, added: 0, reason: 'busy' }; }
    const st = (await client.query('SELECT enabled FROM erp_catalog_add_state WHERE id = 1')).rows[0];
    if (!st || !st.enabled) { await client.query('ROLLBACK'); return { ran: true, added: 0, reason: 'disabled' }; }   // 잠금 기다리는 사이 꺼졌으면 멈춤
    const site = (await client.query('SELECT sku, cat, name_ko, name_en, ctn_qty FROM products')).rows;
    const prev = new Set((await client.query('SELECT sku FROM erp_catalog_add_log')).rows.map((r) => r.sku));
    const plan = planAddNew(data.items, site, { previouslyAdded: prev, onlySkus: changed });
    if (plan.add.length > MAX_AUTO_ADD) {
      await client.query('ROLLBACK');
      await note({ error: `자동 추가 대상 ${plan.add.length}개 — ${MAX_AUTO_ADD}개 초과라 넣지 않음(PC 실행기로 미리보기 후 반영)` });
      return { ran: true, added: 0, reason: 'too_many' };
    }
    const inserted = await applyAddNew(client, plan.add, 'auto');
    await client.query('COMMIT');
    const skus = inserted.map((r) => r.sku);
    await note({ cursor: data.latest_change_at,
      result: `${new Date().toISOString()} ERP 변경 상품 ${changed.size}개 확인, 새로 추가 ${skus.length}개${skus.length ? ` (${skus.slice(0, 10).join(', ')}${skus.length > 10 ? ' …' : ''})` : ''}, 확인 필요 ${plan.review.length}개` });
    return { ran: true, added: skus.length, skus };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await note({ error: `자동 추가 실패: ${String((err && err.message) || err).slice(0, 250)}` });
    return { ran: true, added: 0, reason: 'apply_failed' };
  } finally {
    client.release();
  }
}

module.exports = { STATE_SQL, fetchCatalog, maybeAutoAdd, parseErpTime, MAX_AUTO_ADD, INTERVAL_MINUTES, OVERLAP_MS };
