// scripts/run-erp-price-sync.js  v1.0 — ERP → Site Order 2차 동기화(낱개가) 1회 실행기
//
//   node scripts/run-erp-price-sync.js                     → 확인만(DRY RUN). 8개 분류 + report-P2-buckets.csv
//   node scripts/run-erp-price-sync.js --apply --expect=N  → AUTO_UPDATE 가 정확히 N 일 때만 반영
// 안전장치
//  · --apply 와 --expect 가 함께 있어야 하고, N 이 지금 계산한 AUTO_UPDATE 수와 다르면 중단
//  · 반영 전 백업 CSV (sku, field, old, new)
//  · 한 번에(트랜잭션) 반영 → 반영한 줄을 다시 읽어 price 는 계획대로, 나머지 칸은 한 글자도 안 바뀌었는지 확인 → 아니면 전부 취소
//  · 바꾸는 칸은 price 하나. ERP piecePrice 만 쓴다(lib/erpCatalogPrice.js)
const fs = require('fs');
const db = require('./../lib/db');
const { planPrice, applyPrice, BUCKETS } = require('./../lib/erpCatalogPrice');

const ERP_BASE = process.env.TRONIC_ERP_BASE_URL;
const SECRET = process.env.PREMIUM_K_SERVER_SECRET;
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const EXPECT = (() => { const a = args.find((x) => x.startsWith('--expect=')); return a ? Number(a.split('=')[1]) : null; })();
const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

(async () => {
  const client = await db.pool.connect();
  try {
    if (!ERP_BASE || !SECRET) throw new Error('TRONIC_ERP_BASE_URL / PREMIUM_K_SERVER_SECRET 을 먼저 설정해주세요.');
    const resp = await fetch(`${ERP_BASE}/api/site-orders/catalog`, { headers: { 'x-premium-k-server-secret': SECRET } });
    if (!resp.ok) throw new Error(`ERP 조회 실패 (${resp.status})`);
    const data = await resp.json();
    const { rows: site } = await client.query(`SELECT sku, cat, name_ko, name_en, price, ctn_price, ctn_qty, tbd FROM products`);
    const plan = planPrice(data.items, site);
    const c = plan.counts;

    console.log('\n=== 2차 동기화 (낱개가) — DRY RUN ===');
    if (!plan.erpSendsPiece) console.log('※ ERP가 아직 piecePrice 를 보내지 않는 구버전입니다 → 모든 상품이 SKIP_NO_PIECE_PRICE');
    console.log(`검사 대상 ${c.target} (SKU 일치·비TOGO) / 제외: TOGO ${c.togoSkipped}, 사이트 전용 ${c.siteOnlySkipped}`);
    for (const b of BUCKETS) console.log(`  ${b.padEnd(20)} ${c.bucket[b]}`);
    const sum = Object.values(c.bucket).reduce((a, x) => a + x, 0);
    console.log(`  ${'합계'.padEnd(18)} ${sum} ${c.bucketSumOk ? '= 검사 대상과 일치 ✅' : '≠ 검사 대상 ⚠ (중단)'}`);
    if (!c.bucketSumOk) throw new Error('분류 합계가 검사 대상 수와 다릅니다. 반영하지 않습니다.');
    for (const b of BUCKETS) {
      const list = plan.rows.filter((r) => r.bucket === b);
      if (!list.length || b === 'UNCHANGED' || b === 'SKIP_NO_PIECE_PRICE') continue;
      console.log(`\n[${b}] ${list.length}개`);
      console.log(`  ${'SKU'.padEnd(14)} ${'현재가'.padStart(8)} ${'ERP낱개'.padStart(8)} ${'박스가'.padStart(8)} ${'입수'.padStart(5)} ${'비율'.padStart(6)}  이유`);
      for (const r of list.slice(0, 60)) {
        console.log(`  ${r.sku.padEnd(14)} ${String(r.cur ?? '-').padStart(8)} ${String(r.erp ?? '-').padStart(8)} ${String(r.ctnPrice ?? '-').padStart(8)} ${String(r.ctnQty ?? '-').padStart(5)} ${String(r.ratio ?? '-').padStart(6)}  ${r.reason}`);
      }
      if (list.length > 60) console.log(`  … 외 ${list.length - 60}개 (CSV 참고)`);
    }
    fs.writeFileSync('report-P2-buckets.csv', '\uFEFF' + [['bucket', 'SKU', '상품명', '현재 Site price', 'ERP piecePrice', 'ctnPrice', 'ctnQty', 'ratio', 'reason'].map(cell).join(','),
      ...plan.rows.map((r) => [r.bucket, r.sku, r.name, r.cur, r.erp, r.ctnPrice, r.ctnQty, r.ratio, r.reason].map(cell).join(','))].join('\r\n'));
    console.log('\n전체 목록: report-P2-buckets.csv');

    if (!APPLY) {
      console.log('\n※ 확인만 했습니다. DB는 바뀌지 않았습니다.');
      console.log(`   실제 반영하려면: node scripts/run-erp-price-sync.js --apply --expect=${c.bucket.AUTO_UPDATE}`);
      return;
    }
    if (EXPECT == null || EXPECT !== plan.updates.length) {
      throw new Error(`--expect=${EXPECT ?? '(없음)'} 가 지금 계산한 AUTO_UPDATE ${plan.updates.length}와 다릅니다. (아무것도 바뀌지 않았습니다)`);
    }
    if (!plan.updates.length) { console.log('\n반영할 것이 없습니다.'); return; }
    const skus = plan.updates.map((u) => u.sku);
    const snap = async () => new Map((await client.query(`SELECT sku, row_to_json(p)::jsonb AS j FROM products p WHERE sku = ANY($1::text[])`, [skus])).rows.map((r) => [r.sku, r.j]));
    const before = await snap();
    const backup = `price-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    fs.writeFileSync(backup, '\uFEFF' + ['sku,field,old,new', ...plan.updates.map((u) => [u.sku, 'price', u.before.price ?? '', u.set.price].map(cell).join(','))].join('\r\n'));
    console.log(`\n백업 저장: ${backup}`);
    await client.query('BEGIN');
    const applied = await applyPrice(client, plan);
    const after = await snap();
    const bad = [];
    for (const u of plan.updates) {
      const b = { ...before.get(u.sku) }, a = { ...after.get(u.sku) };
      if (Number(a.price) !== Number(u.set.price)) bad.push(`${u.sku}.price`);
      delete a.price; delete b.price;
      if (JSON.stringify(a) !== JSON.stringify(b)) bad.push(`${u.sku}: price 외 칸 변경`);
    }
    if (applied !== plan.updates.length || bad.length) {
      await client.query('ROLLBACK');
      throw new Error(`반영 결과가 계획과 달라 전부 취소했습니다 (반영 ${applied}/${plan.updates.length}; ${bad.join(', ') || '개수 불일치'}). DB는 바뀌지 않았습니다.`);
    }
    await client.query('COMMIT');
    console.log(`\n✅ 반영 완료: ${applied}개 (price 한 칸)`);
    console.log(`   되돌리기(확인만): node scripts/rollback-erp-price.js ${backup}`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* 없음 */ }
    console.error('⛔ 중단:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.pool.end();
  }
})();
