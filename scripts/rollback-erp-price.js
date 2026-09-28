// scripts/rollback-erp-price.js  v1.0 — 2차(낱개가) 되돌리기
//   node scripts/rollback-erp-price.js price-backup-....csv          → 확인만
//   node scripts/rollback-erp-price.js price-backup-....csv --apply  → 실제 되돌리기
// · price 칸만 되돌린다 (백업에 다른 칸이 있으면 무시)
// · 지금 값이 백업의 new 와 같을 때만 old 로 되돌린다 — 그 뒤 사람이 고친 값은 덮지 않는다
const fs = require('fs');
const db = require('./../lib/db');
const file = process.argv[2];
const APPLY = process.argv.includes('--apply');
function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const split = (l) => { const out = []; let cur = ''; let q = false;
    for (let i = 0; i < l.length; i++) { const ch = l[i];
      if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; }
    out.push(cur); return out; };
  const head = split(lines.shift());
  return lines.map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v])));
}
(async () => {
  const client = await db.pool.connect();
  try {
    if (!file || !fs.existsSync(file)) throw new Error('백업 파일 경로를 주세요 (price-backup-....csv).');
    const rows = parseCsv(fs.readFileSync(file, 'utf8')).filter((r) => r.field === 'price');
    let ok = 0, skip = 0;
    await client.query('BEGIN');
    for (const r of rows) {
      const cur = (await client.query('SELECT price FROM products WHERE sku = $1', [r.sku])).rows[0];
      if (!cur || Number(cur.price) !== Number(r.new)) { skip++; console.log(`  건너뜀 ${r.sku} (지금 ${cur ? cur.price : '없음'} ≠ 반영값 ${r.new})`); continue; }
      if (APPLY) await client.query('UPDATE products SET price = $1 WHERE sku = $2 AND price = $3', [r.old === '' ? null : r.old, r.sku, r.new]);
      ok++; console.log(`  ${APPLY ? '되돌림' : '되돌릴 예정'} ${r.sku}: ${r.new} → ${r.old || '(비어 있음)'}`);
    }
    if (APPLY) await client.query('COMMIT'); else await client.query('ROLLBACK');
    console.log(`\n${APPLY ? '✅ 되돌리기 완료' : '※ 확인만 했습니다'}: ${ok}건${skip ? ` / 건너뜀 ${skip}건` : ''}`);
    if (!APPLY) console.log(`   실제로 되돌리려면: node scripts/rollback-erp-price.js ${file} --apply`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* 없음 */ }
    console.error('⛔ 중단:', e.message); process.exitCode = 1;
  } finally { client.release(); await db.pool.end(); }
})();
