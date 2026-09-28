// scripts/run-erp-phase1-sync.js  v1.2  (공통 안전 검사 결과 출력) — ERP → Site Order 1차 동기화(박스가·입수) 1회 실행기
//
// 기본은 확인만 한다(DB를 바꾸지 않음). 실제 반영은 --apply 와 --expect=숫자 를 함께 줘야만 한다.
//   node scripts/run-erp-phase1-sync.js                    → 확인만 (바뀔 목록 출력)
//   node scripts/run-erp-phase1-sync.js --apply --expect=13 → 바뀔 상품 수가 정확히 13일 때만 반영
//
// 안전장치
//  · --expect 숫자가 지금 계산한 변경 수와 다르면 멈춘다 (검토 후 자료가 바뀐 경우를 막음)
//  · 반영 전에 바뀌기 전 값을 백업 CSV로 저장한다 → rollback-erp-phase1.js 로 되돌릴 수 있다
//  · 한 번에(트랜잭션) 반영하고, 반영 직후 값을 다시 읽어 계획과 다르면 전부 취소한다
//  · 갱신 칸은 박스가·입수 2개뿐, 낱개가 제외, TOGO 제외 (lib/erpCatalogPhase1.js 와 같은 로직)
const fs = require('fs');
const db = require('./../lib/db');
const { planPhase1, applyPhase1 } = require('./../lib/erpCatalogPhase1');

const ERP_BASE = process.env.TRONIC_ERP_BASE_URL;
const SECRET = process.env.PREMIUM_K_SERVER_SECRET;
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const expectArg = args.find((a) => a.startsWith('--expect='));
const EXPECT = expectArg ? Number(expectArg.split('=')[1]) : null;
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

(async () => {
  const client = await db.pool.connect();
  try {
    if (!ERP_BASE || !SECRET) throw new Error('TRONIC_ERP_BASE_URL / PREMIUM_K_SERVER_SECRET 을 먼저 설정해주세요.');
    const resp = await fetch(`${ERP_BASE}/api/site-orders/catalog`, { headers: { 'x-premium-k-server-secret': SECRET } });
    if (!resp.ok) throw new Error(`ERP 조회 실패 (${resp.status})`);
    const data = await resp.json();
    const { rows: site } = await client.query(`SELECT sku, cat, name_ko, name_en, price, ctn_price, ctn_qty, tbd FROM products`);
    const plan = planPhase1(data.items, site);
    const c = plan.counts;

    console.log('\n=== 1차 동기화 (박스가·입수) ===');
    console.log(`대상 ${c.target} / 바뀌는 상품 ${plan.updates.length} (박스가 ${c.field.ctn_price}, 입수 ${c.field.ctn_qty})`);
    console.log('낱개가(price)는 1차에서 갱신하지 않습니다.');
    console.log('\n바뀌는 목록:');
    console.log(`  ${'SKU'.padEnd(16)} ${'박스가 (현재 → ERP)'.padEnd(24)} 입수 (현재 → ERP)`);
    const siteBySku = new Map(site.map((r) => [String(r.sku), r]));
    for (const u of plan.updates) {
      const cur = siteBySku.get(u.sku) || {};
      const cp = 'ctn_price' in u.set ? `${cur.ctn_price ?? '(없음)'} → ${u.set.ctn_price}` : `${cur.ctn_price ?? '(없음)'} (그대로)`;
      const cq = 'ctn_qty' in u.set ? `${cur.ctn_qty ?? '(없음)'} → ${u.set.ctn_qty}` : `${cur.ctn_qty ?? '(없음)'} (그대로)`;
      console.log(`  ${u.sku.padEnd(16)} ${cp.padEnd(24)} ${cq}`);
    }

    const rv = plan.reviews || [];
    console.log(`\n안전 검사로 자동 반영 제외: ${rv.length}개 ${JSON.stringify(plan.counts.review)}`);
    for (const r of rv) console.log(`  ${r.sku.padEnd(16)} [${r.code}] ${r.reason}`);
    if (!APPLY) {
      console.log('\n※ 확인만 했습니다. DB는 바뀌지 않았습니다.');
      console.log(`   실제 반영하려면: node scripts/run-erp-phase1-sync.js --apply --expect=${plan.updates.length}`);
      return;
    }
    if (EXPECT == null || EXPECT !== plan.updates.length) {
      throw new Error(`--expect=${EXPECT ?? '(없음)'} 가 지금 계산한 변경 수 ${plan.updates.length}와 다릅니다. 확인 후 다시 실행하세요. (아무것도 바뀌지 않았습니다)`);
    }
    if (!plan.updates.length) { console.log('\n바뀔 것이 없습니다.'); return; }

    // 1) 백업 — 바뀌기 전 값
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = `phase1-backup-${stamp}.csv`;
    const lines = ['sku,field,before,after'];
    for (const u of plan.updates) for (const k of Object.keys(u.set)) lines.push([u.sku, k, u.before[k] ?? '', u.set[k]].map(csvCell).join(','));
    fs.writeFileSync(backupFile, '\uFEFF' + lines.join('\r\n'));
    console.log(`\n백업 저장: ${backupFile}`);

    // 2) 반영 + 반영 직후 확인 (다르면 전부 취소)
    await client.query('BEGIN');
    const applied = await applyPhase1(client, plan);
    const { rows: after } = await client.query(
      `SELECT sku, ctn_price, ctn_qty FROM products WHERE sku = ANY($1::text[])`, [plan.updates.map((u) => u.sku)]);
    const bySku = new Map(after.map((r) => [String(r.sku), r]));
    const bad = [];
    for (const u of plan.updates) {
      const r = bySku.get(u.sku);
      for (const [k, v] of Object.entries(u.set)) if (!r || Number(r[k]) !== Number(v)) bad.push(`${u.sku}.${k}`);
    }
    if (applied !== plan.updates.length || bad.length) {
      await client.query('ROLLBACK');
      throw new Error(`반영 결과가 계획과 달라 전부 취소했습니다 (반영 ${applied}/${plan.updates.length}, 불일치 ${bad.join(', ') || '없음'}). DB는 바뀌지 않았습니다.`);
    }
    await client.query('COMMIT');
    console.log(`\n✅ 반영 완료: ${applied}개 상품`);
    console.log(`   되돌리기: node scripts/rollback-erp-phase1.js ${backupFile}`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* 트랜잭션이 없으면 무시 */ }
    console.error('⛔ 중단:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.pool.end();
  }
})();
