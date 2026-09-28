// scripts/rollback-erp-phase1.js  v1.0 — 1차 동기화 되돌리기
//   node scripts/rollback-erp-phase1.js phase1-backup-....csv            → 확인만
//   node scripts/rollback-erp-phase1.js phase1-backup-....csv --apply    → 실제 되돌리기
// 지금 값이 1차 동기화가 넣은 값과 같을 때만 되돌린다(그 뒤에 사람이 고친 값은 덮지 않는다).
const fs = require('fs');
const db = require('./../lib/db');
const file = process.argv[2];
const APPLY = process.argv.includes('--apply');
const ALLOWED = new Set(['ctn_price', 'ctn_qty']);   // 1차에서 바꾸는 칸만 되돌린다

function parseCsv(text) {
  return text.replace(/^\uFEFF/, '').split(/\r?\n/).slice(1).filter(Boolean).map((l) => {
    const cells = []; let cur = ''; let q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur);
    return { sku: cells[0], field: cells[1], before: cells[2], after: cells[3] };
  });
}

(async () => {
  const client = await db.pool.connect();
  try {
    if (!file || !fs.existsSync(file)) throw new Error('백업 파일 경로를 주세요.');
    const rows = parseCsv(fs.readFileSync(file, 'utf8')).filter((r) => ALLOWED.has(r.field));
    let ok = 0; let skipped = 0;
    await client.query('BEGIN');
    for (const r of rows) {
      const cur = (await client.query(`SELECT ${r.field} AS v FROM products WHERE sku = $1`, [r.sku])).rows[0];
      if (!cur || Number(cur.v) !== Number(r.after)) { skipped++; console.log(`  건너뜀 ${r.sku}.${r.field} (지금 값이 동기화 값과 다름)`); continue; }
      if (APPLY) await client.query(`UPDATE products SET ${r.field} = $1 WHERE sku = $2`, [r.before === '' ? null : r.before, r.sku]);
      ok++;
      console.log(`  ${APPLY ? '되돌림' : '되돌릴 예정'} ${r.sku}.${r.field} ${r.after} → ${r.before || '(없음)'}`);
    }
    if (APPLY) await client.query('COMMIT'); else await client.query('ROLLBACK');
    console.log(`\n${APPLY ? '✅ 되돌리기 완료' : '※ 확인만 했습니다'}: ${ok}건${skipped ? ` / 건너뜀 ${skipped}건` : ''}`);
    if (!APPLY) console.log(`   실제로 되돌리려면: node scripts/rollback-erp-phase1.js ${file} --apply`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* 무시 */ }
    console.error('⛔ 중단:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.pool.end();
  }
})();
