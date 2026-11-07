// scripts/run-erp-add-new.js  v1.0 (Site Order v8.8) — ERP에 있는데 주문 사이트에 없는 상품 일괄 추가
//
// 기본은 미리보기(DRY RUN): Site Order DB는 BEGIN READ ONLY 로 SELECT 만, ERP는 조회(GET) 한 번. DB를 바꾸지 않는다.
// 결과는 이 폴더에 CSV 두 개로 남긴다.
//   erp-add-plan-<날짜>.csv    넣을 상품(분류·분류 근거·이름·박스가·가격문의 여부)
//   erp-add-review-<날짜>.csv  넣지 않고 확인이 필요한 상품(옛 코드·임시 코드·중복 코드·상품 아님 등)과 이유
//
// 실제 반영: node scripts/run-erp-add-new.js --apply --expect=<미리보기에서 나온 '추가' 수>
//   · 한 트랜잭션. 그 사이 ERP·사이트가 바뀌어 수가 다르면 아무것도 넣지 않고 멈춘다.
//   · 넣은 상품 목록을 erp-add-backup-<날짜>.json 으로 남긴다(되돌리기용).
//   · 이후 자동 추가를 켠다(--no-auto 를 주면 켜지 않음).
// 되돌리기: node scripts/rollback-erp-add-new.js erp-add-backup-<날짜>.json
// 자동 추가 끄기: node scripts/run-erp-add-new.js --disable-auto
// 자동 추가 상태 보기(읽기 전용): node scripts/run-erp-add-new.js --status
//
// 설정은 .env 파일에서 읽는다(기본: 지금 폴더의 .env, 다른 곳이면 --env=경로). 비밀값은 화면에 찍지 않는다.
//   POSTGRES_URL (Site Order DB) · TRONIC_ERP_BASE_URL · PREMIUM_K_SERVER_SECRET
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { planAddNew, applyAddNew } = require('../lib/erpCatalogAdd');
const { STATE_SQL, fetchCatalog } = require('../lib/erpCatalogAuto');

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

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const writeCsv = (file, head, rows) =>
  fs.writeFileSync(file, '﻿' + [head.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n'));
const stamp = () => { const d = new Date(), z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`; };
// 이 도구가 예전에 넣은 SKU (표가 아직 없으면 빈 목록)
async function loadAdded(client) {
  const has = (await client.query(`SELECT to_regclass('erp_catalog_add_log') AS l`)).rows[0].l;
  return new Set(has ? (await client.query('SELECT sku FROM erp_catalog_add_log')).rows.map((r) => r.sku) : []);
}

(async () => {
  const envFile = path.resolve(opt('env') || '.env');
  const envLoaded = loadEnv(envFile);
  const dbUrl = process.env.POSTGRES_URL;
  console.log(`설정 파일: ${envLoaded ? 'OK' : '없음'} · DB: ${dbUrl ? 'DB-OK' : '없음'} · ERP 주소: ${process.env.TRONIC_ERP_BASE_URL ? 'OK' : '없음'} · 서버 비밀값: ${process.env.PREMIUM_K_SERVER_SECRET ? 'SECRET-OK' : '없음'}`);
  if (!dbUrl) throw new Error('POSTGRES_URL 이 없습니다 (.env 확인)');
  const host = (() => { try { return new URL(dbUrl).hostname; } catch { return ''; } })();
  const pool = new Pool({ connectionString: dbUrl, ssl: /^(localhost|127\.0\.0\.1)$/.test(host) ? false : { rejectUnauthorized: false }, max: 2 });
  console.log(`대상 DB 호스트: ${host}`);

  try {
    if (flag('disable-auto')) {
      const r = await pool.query(`UPDATE erp_catalog_add_state SET enabled = false, updated_at = now() WHERE id = 1 RETURNING id`).catch((e) => (e.code === '42P01' ? { rows: [] } : Promise.reject(e)));
      console.log(r.rows.length ? '✅ 자동 추가를 껐습니다.' : '자동 추가 설정이 아직 없습니다(일괄 추가 전).');
      return;
    }

    if (flag('status')) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        const has = (await client.query(`SELECT to_regclass('erp_catalog_add_state') AS s`)).rows[0].s;
        const st = has ? (await client.query('SELECT * FROM erp_catalog_add_state WHERE id = 1')).rows[0] : null;
        const n = has ? (await client.query(`SELECT source, count(*)::int AS n FROM erp_catalog_add_log GROUP BY source ORDER BY source`)).rows : [];
        await client.query('COMMIT');
        if (!st) { console.log('자동 추가 설정이 아직 없습니다(일괄 추가 전).'); return; }
        console.log(`자동 추가: ${st.enabled ? '켜짐' : '꺼짐'}`);
        console.log(`  마지막 실행: ${st.last_run_at ? new Date(st.last_run_at).toLocaleString() : '-'} · 마지막 성공: ${st.last_ok_at ? new Date(st.last_ok_at).toLocaleString() : '-'}`);
        console.log(`  마지막 결과: ${st.last_result || '-'}`);
        console.log(`  마지막 오류: ${st.last_error || '없음'}`);
        console.log(`  넣은 기록: ${n.map((r) => `${r.source === 'bulk' ? '일괄' : '자동'} ${r.n}개`).join(' · ') || '없음'}`);
      } finally { client.release(); }
      return;
    }

    const data = await fetchCatalog({ timeoutMs: 30000 });
    console.log(`ERP 노출 상품 ${data.items.length}개 (ERP 기준 시각 ${data.generated_at})`);

    if (!flag('apply')) {
      // ── 미리보기: 읽기 전용 ──
      const client = await pool.connect();
      let site, prev;
      try {
        await client.query('BEGIN READ ONLY');
        site = (await client.query('SELECT sku, cat, name_ko, name_en, ctn_qty FROM products')).rows;
        prev = await loadAdded(client);
        await client.query('COMMIT');
      } finally { client.release(); }
      const plan = planAddNew(data.items, site, { previouslyAdded: prev });
      const t = stamp();
      writeCsv(`erp-add-plan-${t}.csv`, ['SKU', '분류', '분류 근거', '한글명(표시)', '영문명(표시)', '규격', '박스입수', '박스가', '낱개가', '가격문의'],
        plan.add.map(({ row, catWhy }) => [row.sku, row.cat, catWhy, row.name_ko, row.name_en, row.spec, row.ctn_qty, row.ctn_price, row.price, row.tbd ? '예' : '']));
      writeCsv(`erp-add-review-${t}.csv`, ['SKU', '이유', 'ERP 한글명', 'ERP 영문명', '박스가'],
        plan.review.map((r) => [r.sku, r.why, r.item.nameKo, r.item.nameEn, r.item.ctnPrice]));
      const c = plan.counts;
      console.log(`\n[미리보기 — DB 변경 없음] 사이트 현재 상품 ${site.length}개`);
      console.log(`  추가할 상품: ${c.add}개 (그중 박스가 없어 '가격 문의': ${c.tbd}개)`);
      console.log(`  분류별: ${Object.entries(c.byCat).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
      console.log(`  확인 필요(넣지 않음): ${c.review}개 · 이미 사이트에 있음: ${c.exists}개 · TOGO: ${c.togo}개`);
      console.log(`  저장한 파일: erp-add-plan-${t}.csv, erp-add-review-${t}.csv`);
      console.log(`\n반영하려면: node scripts/run-erp-add-new.js --apply --expect=${c.add}`);
      return;
    }

    // ── 실제 반영 ──
    const expect = Number(opt('expect'));
    if (!Number.isInteger(expect) || expect < 0) throw new Error('--expect=<미리보기의 추가 수> 를 함께 주세요');
    const client = await pool.connect();
    let inserted = [], plan;
    const t = stamp();
    const backup = `erp-add-backup-${t}.json`;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('erp_catalog_add'))`);
      await client.query('LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE');   // 반영하는 동안 관리자 화면의 상품 추가·수정은 잠깐 기다림
      const site = (await client.query('SELECT sku, cat, name_ko, name_en, ctn_qty FROM products')).rows;
      plan = planAddNew(data.items, site, { previouslyAdded: await loadAdded(client) });
      if (plan.add.length !== expect) throw new Error(`추가 대상이 미리보기와 다릅니다 (지금 ${plan.add.length}개 / 기대 ${expect}개) — 다시 미리보기 하세요. 아무것도 넣지 않았습니다.`);
      await client.query(STATE_SQL);
      inserted = await applyAddNew(client, plan.add, 'bulk');
      if (inserted.length !== expect) throw new Error(`실제로 들어간 수가 다릅니다 (${inserted.length}/${expect}) — 모두 취소했습니다.`);
      await client.query(
        `INSERT INTO erp_catalog_add_state (id, enabled, cursor, last_ok_at, last_result, updated_at)
         VALUES (1, $1, $2, now(), $3, now())
         ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, cursor = EXCLUDED.cursor, last_ok_at = now(),
           last_result = EXCLUDED.last_result, last_error = NULL, updated_at = now()`,
        [!flag('no-auto'), data.latest_change_at, `일괄 추가 ${inserted.length}개 (${new Date().toISOString()})`]);
      // 되돌리기 파일을 먼저 저장하고 나서 확정한다 — 파일을 못 쓰면 아무것도 넣지 않는다
      fs.writeFileSync(backup, JSON.stringify({ created_at: new Date().toISOString(), db_host: host, inserted,
        rows: plan.add.map((a) => a.row) }, null, 2));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (fs.existsSync(backup)) fs.renameSync(backup, backup.replace(/\.json$/, '.not-applied.json'));
      throw err;
    } finally { client.release(); }
    // 반영 직후 결과를 CSV로도 남긴다(무엇이 어느 분류로 들어갔는지)
    writeCsv(`erp-add-applied-${t}.csv`, ['SKU', '분류', '분류 근거', '한글명(표시)', '영문명(표시)', '박스입수', '박스가', '낱개가', '가격문의'],
      plan.add.map(({ row, catWhy }) => [row.sku, row.cat, catWhy, row.name_ko, row.name_en, row.ctn_qty, row.ctn_price, row.price, row.tbd ? '예' : '']));
    console.log(`\n✅ 상품 ${inserted.length}개를 추가했습니다. 되돌리기용 파일: ${backup} · 넣은 목록: erp-add-applied-${t}.csv`);
    console.log(flag('no-auto') ? '자동 추가는 켜지 않았습니다.' : `이후 ERP에 새로 등록되는 정식 코드 상품은 주문 사이트를 열 때 10분 간격으로 자동 추가됩니다(배포 후).`);
  } finally {
    await pool.end();
  }
})().catch((err) => { console.error('❌', err.message); process.exitCode = 1; });
