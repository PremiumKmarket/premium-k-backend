// scripts/rollback-erp-add-new.js  v1.0 (Site Order v8.8) — ERP 상품 일괄 추가 되돌리기
//
// 기본은 미리보기: 백업 파일에 적힌 상품이 지금 사이트에 몇 개 있는지만 본다(BEGIN READ ONLY, SELECT 만).
// 실제 되돌리기: node scripts/rollback-erp-add-new.js <erp-add-backup-….json> --apply --expect=<미리보기의 지울 수>
//   --include-auto   일괄 추가 뒤 자동으로 들어온 상품(기록 source='auto')도 함께 지운다.
//   --include-edited 넣은 뒤 관리자 화면에서 고친 상품(이름·가격·분류·사진 등)도 지운다. 기본은 남겨 둔다.
//   · 백업에 적힌 id와 SKU가 둘 다 같은 것만 지운다(그 뒤 관리자가 같은 SKU로 새로 만든 상품은 건드리지 않음).
//   · 자동 추가를 끈다. 지운 상품의 기록(erp_catalog_add_log)도 지워서, 나중에 다시 일괄 추가할 때 넣을 수 있게 한다.
//   · 백업을 만든 DB와 지금 DB가 다르면 멈춘다.
//   · 이미 그 상품으로 들어온 주문 기록은 그대로 남는다(주문에는 상품 이름·가격이 따로 저장되어 있음).
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { loadEnv, hide, sessionGuards } = require('./erp-add-common');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };

const num = (v) => (v === null || v === undefined ? null : Number(v));
// 넣은 뒤 관리자가 고쳤는지 — 넣을 때 값(백업)과 비교. 자동 추가분은 백업 값이 없어 사진·링크만 본다
function edited(cur, orig) {
  if (cur.img || cur.url || cur.img_page) return true;
  if (!orig) return false;
  return cur.cat !== orig.cat || cur.name_ko !== orig.name_ko || cur.name_en !== orig.name_en || (cur.spec || null) !== (orig.spec || null)
    || num(cur.price) !== num(orig.price) || num(cur.ctn_price) !== num(orig.ctn_price) || num(cur.ctn_qty) !== num(orig.ctn_qty) || !!cur.tbd !== !!orig.tbd;
}

(async () => {
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) throw new Error('되돌릴 백업 파일(erp-add-backup-….json)을 주세요');
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(backup.inserted) ? backup.inserted.filter((r) => Number.isInteger(r.id) && typeof r.sku === 'string') : [];
  if (!list.length) throw new Error('백업 파일에 상품 목록이 없습니다');
  const origBySku = new Map((backup.rows || []).map((r) => [r.sku, r]));

  const envLoaded = loadEnv(path.resolve(opt('env') || '.env'));
  const dbUrl = process.env.POSTGRES_URL;
  console.log(`설정 파일: ${envLoaded ? 'OK' : '없음'} · DB: ${dbUrl ? 'DB-OK' : '없음'}`);
  if (!dbUrl) throw new Error('POSTGRES_URL 이 없습니다 (.env 확인)');
  const host = (() => { try { return new URL(dbUrl).hostname; } catch { return ''; } })();
  console.log(`대상 DB 호스트: ${host} · 백업을 만든 DB 호스트: ${backup.db_host}`);
  if (backup.db_host && backup.db_host !== host) throw new Error('백업을 만든 DB와 지금 DB가 다릅니다 — 멈춥니다');
  const pool = new Pool({ connectionString: dbUrl, ssl: /^(localhost|127\.0\.0\.1)$/.test(host) ? false : { rejectUnauthorized: false }, max: 1 });

  const apply = flag('apply');
  let expect = null;
  if (apply) {
    if (!/^\d+$/.test(opt('expect') || '')) throw new Error('--expect=<미리보기의 지울 수> 를 함께 주세요');
    expect = Number(opt('expect'));
  }
  const client = await pool.connect();
  try {
    await sessionGuards(client);
    await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    if (apply) await client.query(`SELECT pg_advisory_xact_lock(hashtext('erp_catalog_add'))`);   // 자동 추가와 겹치지 않게
    const ids = list.map((r) => r.id), skus = list.map((r) => r.sku);
    const hasLog = (await client.query(`SELECT to_regclass('erp_catalog_add_log') AS l, to_regclass('erp_catalog_add_state') AS s`)).rows[0];
    if (flag('include-auto')) {
      const auto = hasLog.l ? (await client.query(`SELECT sku, product_id AS id FROM erp_catalog_add_log WHERE source = 'auto' AND product_id IS NOT NULL`)).rows : [];
      for (const r of auto) if (!skus.includes(r.sku)) { ids.push(r.id); skus.push(r.sku); }
      console.log(`자동으로 들어온 상품 기록 ${auto.length}개도 함께 봅니다`);
    }
    const found = (await client.query(
      `SELECT p.* FROM products p JOIN unnest($1::int[], $2::text[]) AS b(id, sku) ON b.id = p.id AND b.sku = p.sku`, [ids, skus])).rows;
    const changed = found.filter((p) => edited(p, origBySku.get(p.sku)));
    const target = flag('include-edited') ? found : found.filter((p) => !changed.includes(p));
    console.log(`\n지울 후보 ${skus.length}개 중 지금 사이트에 있는 것 ${found.length}개`);
    console.log(`  그중 넣은 뒤 관리자 화면에서 고친 상품 ${changed.length}개 — ${flag('include-edited') ? '함께 지움(--include-edited)' : '남겨 둠(지우려면 --include-edited)'}`);
    if (changed.length) console.log(`  고친 상품: ${changed.slice(0, 20).map((p) => p.sku).join(', ')}${changed.length > 20 ? ' …' : ''}`);
    console.log(`  지울 상품: ${target.length}개`);
    if (!apply) {
      await client.query('COMMIT');
      const extra = [flag('include-auto') ? ' --include-auto' : '', flag('include-edited') ? ' --include-edited' : ''].join('');
      console.log(`\n[미리보기 — DB 변경 없음] 되돌리려면(승인 후): node scripts/rollback-erp-add-new.js ${file}${extra} --apply --expect=${target.length}`);
      return;
    }
    if (target.length !== expect) throw new Error(`지울 상품 수가 미리보기와 다릅니다 (지금 ${target.length}개 / 기대 ${expect}개) — 아무것도 지우지 않았습니다`);
    const del = await client.query(`DELETE FROM products WHERE id = ANY($1::int[]) RETURNING sku`, [target.map((p) => p.id)]);
    if (del.rowCount !== expect) throw new Error(`실제로 지운 수가 다릅니다 (${del.rowCount}/${expect}) — 모두 취소했습니다`);
    if (hasLog.s) await client.query(`UPDATE erp_catalog_add_state SET enabled = false, last_result = $1, updated_at = now() WHERE id = 1`, [`되돌리기로 ${del.rowCount}개 삭제·자동 추가 끔 (${new Date().toISOString()})`]);
    if (hasLog.l) await client.query(`DELETE FROM erp_catalog_add_log WHERE sku = ANY($1::text[])`, [del.rows.map((r) => r.sku)]);
    await client.query('COMMIT');
    console.log(`\n✅ 되돌렸습니다: 상품 ${del.rowCount}개 삭제, 자동 추가 끔.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
})().catch((err) => { console.error('❌', hide(err && err.message)); process.exitCode = 1; });
