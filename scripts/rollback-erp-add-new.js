// scripts/rollback-erp-add-new.js  v1.0 (Site Order v8.8) — ERP 상품 일괄 추가 되돌리기
//
// 기본은 미리보기: 백업 파일에 적힌 상품이 지금 사이트에 몇 개 있는지만 본다(BEGIN READ ONLY, SELECT 만).
// 실제 되돌리기: node scripts/rollback-erp-add-new.js <erp-add-backup-….json> --apply --expect=<미리보기의 지울 수>
//   --include-auto 를 붙이면 일괄 추가 뒤 자동으로 들어온 상품(기록 source='auto')도 함께 지운다.
//   · 백업에 적힌 상품 중 id와 SKU가 둘 다 같은 것만 지운다(그 뒤 관리자가 같은 SKU로 새로 만든 상품은 건드리지 않음).
//   · 자동 추가를 끈다. 지운 상품의 '넣은 기록'(erp_catalog_add_log)도 지워서, 나중에 다시 일괄 추가할 때 넣을 수 있게 한다.
//   · 백업을 만든 DB와 지금 DB가 다르면 멈춘다.
//   · 이미 그 상품으로 들어온 주문 기록은 그대로 남는다(주문에는 상품 이름·가격이 따로 저장되어 있음).
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };

function loadEnv(file) {
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return true;
}

(async () => {
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) throw new Error('되돌릴 백업 파일(erp-add-backup-….json)을 주세요');
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(backup.inserted) ? backup.inserted.filter((r) => Number.isInteger(r.id) && typeof r.sku === 'string') : [];
  if (!list.length) throw new Error('백업 파일에 상품 목록이 없습니다');

  const envLoaded = loadEnv(path.resolve(opt('env') || '.env'));
  const dbUrl = process.env.POSTGRES_URL;
  console.log(`설정 파일: ${envLoaded ? 'OK' : '없음'} · DB: ${dbUrl ? 'DB-OK' : '없음'}`);
  if (!dbUrl) throw new Error('POSTGRES_URL 이 없습니다 (.env 확인)');
  const host = (() => { try { return new URL(dbUrl).hostname; } catch { return ''; } })();
  console.log(`대상 DB 호스트: ${host} · 백업을 만든 DB 호스트: ${backup.db_host}`);
  if (backup.db_host && backup.db_host !== host) throw new Error('백업을 만든 DB와 지금 DB가 다릅니다 — 멈춥니다');
  const pool = new Pool({ connectionString: dbUrl, ssl: /^(localhost|127\.0\.0\.1)$/.test(host) ? false : { rejectUnauthorized: false }, max: 1 });
  const ids = list.map((r) => r.id), skus = list.map((r) => r.sku);

  const client = await pool.connect();
  try {
    if (flag('include-auto')) {
      const hasLog = (await client.query(`SELECT to_regclass('erp_catalog_add_log') AS l`)).rows[0].l;
      const auto = hasLog ? (await client.query(`SELECT sku, product_id AS id FROM erp_catalog_add_log WHERE source = 'auto' AND product_id IS NOT NULL`)).rows : [];
      for (const r of auto) if (!skus.includes(r.sku)) { ids.push(r.id); skus.push(r.sku); }
      console.log(`자동으로 들어온 상품 기록 ${auto.length}개도 함께 봅니다`);
    }
    if (!flag('apply')) {
      await client.query('BEGIN READ ONLY');
      const found = (await client.query(
        `SELECT p.id, p.sku FROM products p JOIN unnest($1::int[], $2::text[]) AS b(id, sku) ON b.id = p.id AND b.sku = p.sku`, [ids, skus])).rows;
      await client.query('COMMIT');
      console.log(`\n[미리보기 — DB 변경 없음] 지울 후보 ${skus.length}개 중 지금 사이트에 그대로 있는 것: ${found.length}개`);
      console.log(`되돌리려면: node scripts/rollback-erp-add-new.js ${file}${flag('include-auto') ? ' --include-auto' : ''} --apply --expect=${found.length}`);
      return;
    }
    const expect = Number(opt('expect'));
    if (!Number.isInteger(expect) || expect < 0) throw new Error('--expect=<미리보기의 지울 수> 를 함께 주세요');
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('erp_catalog_add'))`);
    const del = await client.query(
      `DELETE FROM products p USING unnest($1::int[], $2::text[]) AS b(id, sku) WHERE b.id = p.id AND b.sku = p.sku RETURNING p.sku`, [ids, skus]);
    if (del.rowCount !== expect) throw new Error(`지울 상품 수가 미리보기와 다릅니다 (지금 ${del.rowCount}개 / 기대 ${expect}개) — 아무것도 지우지 않았습니다`);
    const hasState = (await client.query(`SELECT to_regclass('erp_catalog_add_state') AS s, to_regclass('erp_catalog_add_log') AS l`)).rows[0];
    if (hasState.s) await client.query(`UPDATE erp_catalog_add_state SET enabled = false, last_result = $1, updated_at = now() WHERE id = 1`, [`되돌리기로 ${del.rowCount}개 삭제·자동 추가 끔 (${new Date().toISOString()})`]);
    if (hasState.l) await client.query(`DELETE FROM erp_catalog_add_log WHERE sku = ANY($1::text[])`, [del.rows.map((r) => r.sku)]);
    await client.query('COMMIT');
    console.log(`\n✅ 되돌렸습니다: 상품 ${del.rowCount}개 삭제, 자동 추가 끔.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
})().catch((err) => { console.error('❌', err.message); process.exitCode = 1; });
