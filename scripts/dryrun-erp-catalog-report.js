// scripts/dryrun-erp-catalog-report.js  v1.3 — DRY RUN 전용 (읽기만 함)
//
// ★ DB를 절대 바꾸지 않는다. Site Order DB에는 SELECT 한 건, ERP에는 조회(GET) 한 건뿐이다.
//   INSERT / UPDATE / DELETE / ALTER / CREATE / DROP / TRUNCATE 없음. 결과는 CSV 파일로만 쓴다.
//
// 만드는 보고서
//  A. report-A-field-diff.csv    기존 상품(비TOGO, SKU 일치)의 항목별 변경 내역
//                                 ERP 값이 비어 있으면 "변경 아님"(기존 값 유지 원칙)
//  B. report-B-new-category.csv  ERP에만 있는 신규 상품의 추천 분류 (ERP에 쓰지 않음)
//  C. report-C-other.csv         갱신·신규 어디에도 들지 않은 ERP 상품의 정체
//  P1. report-P1-price-qty.csv   1차 동기화(가격·입수)에서 실제로 바뀔 값 — 실제 동기화와 같은 함수(planPhase1)로 계산
//  P15. report-P15-name-ko.csv   한글명 1.5차 제안 (사이트 한글명 칸이 영어, ERP에는 한글이 있는 상품)
//
// 실행:
//   set "POSTGRES_URL=..."  set "TRONIC_ERP_BASE_URL=..."  set "PREMIUM_K_SERVER_SECRET=..."
//   node scripts/dryrun-erp-catalog-report.js
const fs = require('fs');
const db = require('./../lib/db');
const { planPhase1 } = require('./../lib/erpCatalogPhase1');   // 실제 1차 동기화와 같은 판단 로직

const ERP_BASE = process.env.TRONIC_ERP_BASE_URL;
const SECRET = process.env.PREMIUM_K_SERVER_SECRET;
const TOGO_CAT = 'TOGO SOLUTION';

const blank = (v) => v == null || String(v).trim() === '';
const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
// ERP 상품명 끝의 포장 표기 "1CTN(CASE)=20P" 를 떼어낸 이름 (고객용 이름과 비교하기 위해)
const stripPack = (v) => String(v ?? '').replace(/\s*\d*\s*CTN\s*\(\s*CASE\s*\)\s*=\s*\d+\s*P\s*$/i, '').replace(/\s+/g, ' ').trim();
const hasHangul = (v) => /[가-힣]/.test(String(v ?? ''));
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const writeCsv = (file, head, rows) =>
  fs.writeFileSync(file, '\uFEFF' + [head.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n'));

function nonProductReason(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  if (n.startsWith('└')) return '하위 표시줄(└)';
  const low = n.toLowerCase();
  if (/sampling|sample|샘플/.test(low)) return '샘플';
  if (/no\s*charge|무상/.test(low)) return '무상(No Charge)';
  if (/transformer|승압기/.test(low)) return '승압기';
  if (/\btest\b|테스트/.test(low)) return '테스트 상품';
  if (/^(ab)+$/i.test(n.replace(/\s/g, ''))) return '테스트 데이터';
  return null;
}
function looksLikeBarcode(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!n) return false;
  if (/^\d{8,}\s*(CT|EA|BOX|PK)?$/i.test(n)) return true;
  const digits = (n.match(/\d/g) || []).length;
  const letters = (n.match(/[A-Za-z가-힣]/g) || []).length;
  return digits >= 8 && letters <= 2;
}

// 분류 추천용 단어 뽑기 — 숫자·단위·포장 표기는 뺀다
const STOP = new Set(['ctn', 'case', 'box', 'ea', 'pk', 'pcs', 'pc', 'the', 'and', 'with', 'of', 'for', 'x', 'g', 'kg', 'ml', 'l', 'lb', 'oz',
  'premium', 'korean', 'korea', 'new', '1p', '1ctn', 'ct']);
function tokens(...names) {
  const out = new Set();
  for (const name of names) {
    for (const w of String(name || '').toLowerCase().split(/[^a-z0-9가-힣]+/)) {
      if (!w || w.length < 2 || STOP.has(w) || /^\d/.test(w)) continue;
      out.add(w);
    }
  }
  return [...out];
}

(async () => {
  try {
    if (!ERP_BASE || !SECRET) throw new Error('TRONIC_ERP_BASE_URL / PREMIUM_K_SERVER_SECRET 을 먼저 설정해주세요.');
    const resp = await fetch(`${ERP_BASE}/api/site-orders/catalog`, { headers: { 'x-premium-k-server-secret': SECRET } });
    if (!resp.ok) throw new Error(`ERP 조회 실패 (${resp.status}) ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    const erpAll = data.items || [];

    // ERP 목록 안의 중복 SKU 확인
    const skuSeen = new Map();
    for (const i of erpAll) skuSeen.set(String(i.sku), (skuSeen.get(String(i.sku)) || 0) + 1);
    const dupSkus = [...skuSeen.entries()].filter(([, n]) => n > 1).map(([s]) => s);

    const erpVisible = erpAll.filter((i) => !i.removed);
    const erp = new Map(erpVisible.map((i) => [String(i.sku), i]));

    // Site Order — 읽기만 한다 (SELECT 한 건)
    const { rows: site } = await db.query(
      `SELECT sku, cat, name_ko, name_en, price, ctn_price, ctn_qty, spec, hidden, tbd FROM products`);
    const siteMap = new Map(site.map((r) => [String(r.sku), r]));
    const isTogo = (r) => String(r?.cat || '').trim().toUpperCase() === TOGO_CAT;

    // ── ERP 743개를 하나도 빠짐없이 한 칸에 넣는다 ──
    const bucket = new Map();      // sku -> {bucket, reason}
    for (const [sku, e] of erp) {
      const s = siteMap.get(sku);
      if (dupSkus.includes(sku)) { bucket.set(sku, { b: 'DUPLICATE_SKU', r: 'ERP 목록에 같은 SKU가 두 번 이상' }); continue; }
      if (s && isTogo(s)) { bucket.set(sku, { b: 'KEEP_LOCAL_TOGO', r: '사이트의 TOGO SOLUTION 상품 — 정책상 연동으로 건드리지 않음' }); continue; }
      if (s) { bucket.set(sku, { b: 'UPDATE_EXISTING', r: '사이트에 같은 SKU 있음(비TOGO)' }); continue; }
      const ex = nonProductReason(e.nameEn) || nonProductReason(e.nameKo);
      if (ex) { bucket.set(sku, { b: 'EXCLUDED_NON_PRODUCT', r: ex }); continue; }
      if (blank(e.nameEn) && blank(e.nameKo)) { bucket.set(sku, { b: 'MISSING_REQUIRED', r: '영문명·한글명 모두 없음' }); continue; }
      if (looksLikeBarcode(e.nameEn) && blank(e.nameKo)) { bucket.set(sku, { b: 'REVIEW_BARCODE_NAME', r: '상품명이 바코드/숫자뿐' }); continue; }
      bucket.set(sku, { b: 'ADD_FROM_ERP', r: 'ERP에만 있음' });
    }
    const countBy = {};
    for (const { b } of bucket.values()) countBy[b] = (countBy[b] || 0) + 1;

    // ── A. 기존 상품 항목별 변경 ──
    const FIELDS = [
      ['nameEn', (e) => e.nameEn, (s) => s.name_en, 'text'],
      ['nameKo', (e) => e.nameKo, (s) => s.name_ko, 'text'],
      ['category', (e) => e.cat, (s) => s.cat, 'text'],
      ['spec', (e) => e.spec, (s) => s.spec, 'text'],
      ['ctnQty', (e) => e.ctnQty, (s) => s.ctn_qty, 'num'],
      ['ctnPrice', (e) => e.ctnPrice, (s) => s.ctn_price, 'num'],
      ['price', (e) => e.price, (s) => s.price, 'num'],
    ];
    const fieldCount = Object.fromEntries(FIELDS.map(([f]) => [f, 0]));
    const fieldCosmetic = Object.fromEntries(FIELDS.map(([f]) => [f, 0]));   // 공백·대소문자만 다른 경우
    const fieldSkipped = Object.fromEntries(FIELDS.map(([f]) => [f, 0]));    // ERP가 비어서 기존 값 유지
    const packOnly = { nameEn: 0, nameKo: 0 };   // 포장 표기만 다른 이름
    let koFix = 0;                               // 사이트 한글명 칸이 영어인 경우
    const aRows = [];
    const examples = { nameEn: [], nameKo: [], spec: [], category: [] };
    let noChangeCount = 0;
    for (const [sku, info] of bucket) {
      if (info.b !== 'UPDATE_EXISTING') continue;
      const e = erp.get(sku); const s = siteMap.get(sku);
      let changed = false;
      for (const [f, ev, sv, kind] of FIELDS) {
        const a = ev(e); const b = sv(s);
        if (blank(a)) { fieldSkipped[f]++; continue; }               // ERP 빈 값 → 기존 유지
        let diff; let kindLabel = '실제로 다름';
        if (kind === 'num') diff = Number(a) !== Number(b);
        else {
          diff = String(a) !== String(b ?? '');
          if (diff && norm(a) === norm(b)) { kindLabel = '공백·대소문자만 다름'; fieldCosmetic[f]++; }
          else if (diff && (f === 'nameEn' || f === 'nameKo') && norm(stripPack(a)) === norm(b)) { kindLabel = '포장표기(1CTN)만 다름'; packOnly[f]++; }
          else if (diff && f === 'nameKo' && !hasHangul(b) && hasHangul(a)) { kindLabel = '사이트 한글명 칸에 영어 → ERP 한글'; koFix++; }
        }
        if (!diff) continue;
        changed = true;
        fieldCount[f]++;
        aRows.push([sku, s.name_ko || s.name_en || '', f, b ?? '', a ?? '', kindLabel]);
        if (examples[f] && examples[f].length < 10) examples[f].push({ sku, site: b ?? '(비어 있음)', erp: a, kindLabel });
      }
      if (!changed) noChangeCount++;
    }
    writeCsv('report-A-field-diff.csv', ['SKU', '현재 사이트 상품명', '항목', '현재 사이트 값', 'ERP 값(바뀔 값)', '차이 유형'], aRows);

    // ── B. 신규 상품 분류 추천 (ERP에 쓰지 않음) ──
    // 기존 사이트 상품(비TOGO, 분류 있음)을 기준으로, 이름에 같은 단어가 들어간 상품이 어느 분류에 많은지 본다
    // "NEW" 처럼 신상품 표시용 분류는 상품 종류가 아니므로 추천 기준에서 뺀다
    const DISPLAY_CATS = new Set(['NEW', 'SALE', 'BEST', 'HOT']);
    const isRealCat = (c) => !blank(c) && !DISPLAY_CATS.has(String(c).trim().toUpperCase());
    const siteCats = [...new Set(site.filter((s) => !isTogo(s) && isRealCat(s.cat)).map((s) => s.cat))].sort();
    const wordCat = new Map();   // word -> {cat -> count}
    const learn = (cat, ...names) => {
      for (const w of tokens(...names)) {
        if (!wordCat.has(w)) wordCat.set(w, {});
        const m = wordCat.get(w); m[cat] = (m[cat] || 0) + 1;
      }
    };
    // 기준 1: 사이트 상품의 분류 (TOGO·NEW 등 표시용 제외)
    for (const s of site) if (!isTogo(s) && isRealCat(s.cat)) learn(s.cat, s.name_en, s.name_ko);
    // 기준 2: ERP에 이미 분류가 들어간 상품 (사이트에 없는 음료/주류 같은 분류도 추천할 수 있게)
    const erpCats = new Set();
    for (const e of erp.values()) {
      if (!isRealCat(e.cat) || String(e.cat).trim().toUpperCase() === TOGO_CAT || e.cat === '미분류') continue;
      erpCats.add(e.cat);
      learn(e.cat, e.nameEn, e.nameKo);
    }
    const siteCatSet = new Set(siteCats);
    const bRows = [];
    const bSummary = {};
    let noSuggest = 0;
    for (const [sku, info] of bucket) {
      if (info.b !== 'ADD_FROM_ERP') continue;
      const e = erp.get(sku);
      const score = {}; const hits = {};
      for (const w of tokens(e.nameEn, e.nameKo)) {
        const m = wordCat.get(w); if (!m) continue;
        const total = Object.values(m).reduce((a, b) => a + b, 0);
        for (const [cat, n] of Object.entries(m)) {
          // 여러 분류에 흩어진 흔한 단어는 덜 믿는다
          score[cat] = (score[cat] || 0) + n / total;
          (hits[cat] ||= []).push(w);
        }
      }
      const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
      let rec = ''; let reason = ''; let conf = '';
      if (isRealCat(e.cat) && e.cat !== '미분류') {
        // ERP에 이미 분류가 있으면 추천하지 않고 그대로 쓴다
        rec = e.cat; conf = 'ERP 지정'; reason = 'ERP에 이미 분류가 입력되어 있음';
        bSummary[rec] = (bSummary[rec] || 0) + 1;
      } else if (ranked.length) {
        const [best, sc] = ranked[0];
        const second = ranked[1]?.[1] || 0;
        rec = best;
        conf = sc >= 1.5 && sc >= second * 2 ? '높음' : (sc >= 0.8 ? '보통' : '낮음');
        reason = `같은 단어가 들어간 기존 상품(사이트·ERP)의 분류 — 단어: ${[...new Set(hits[best])].slice(0, 5).join(', ')}`;
        if (ranked[1]) reason += ` (다음 후보: ${ranked[1][0]})`;
        bSummary[best] = (bSummary[best] || 0) + 1;
      } else {
        noSuggest++;
        reason = '기존 상품과 겹치는 단어 없음 — 직접 지정 필요';
        conf = '없음';
      }
      const notOnSite = rec && !siteCatSet.has(rec) ? '사이트에 없는 분류(새로 생김)' : '';
      bRows.push([sku, e.nameEn ?? '', e.nameKo ?? '', e.cat ?? '', rec, conf, reason, notOnSite]);
    }
    writeCsv('report-B-new-category.csv', ['SKU', 'nameEn', 'nameKo', '현재 ERP 분류', '추천 분류', '확신도', '추천 근거', '참고'], bRows);

    // ── C. 갱신·신규에 들지 않은 ERP 상품 ──
    const cRows = [];
    for (const [sku, info] of bucket) {
      if (info.b === 'UPDATE_EXISTING' || info.b === 'ADD_FROM_ERP') continue;
      const e = erp.get(sku); const s = siteMap.get(sku);
      cRows.push([info.b, sku, e.nameEn ?? '', e.nameKo ?? '', s ? (s.name_ko || s.name_en || '') : '', s?.cat ?? '', info.r]);
    }
    cRows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    writeCsv('report-C-other.csv', ['구분', 'SKU', 'ERP nameEn', 'ERP nameKo', '현재 사이트명', '현재 사이트 분류', '이유'], cRows);

    // ── P1. 1차 동기화(가격·입수) 최종 DRY RUN ──
    const plan = planPhase1(erpAll, site);
    const p1Rows = plan.rows.map((r) => {
      const d = r.detail;
      const g = (c, k) => (d[c] ? d[c][k] ?? '' : '');
      return [r.sku, r.name, g('ctn_price', 'cur'), g('ctn_price', 'erp'), g('ctn_price', 'final'),
        g('price', 'cur'), g('price', 'erp'), g('price', 'final'),
        g('ctn_qty', 'cur'), g('ctn_qty', 'erp'), g('ctn_qty', 'final'),
        r.tbd ? '가격문의 상품' : '', r.action,
        ['ctn_price', 'price', 'ctn_qty'].map((c) => d[c]?.note).filter((n) => n && n !== '같음').join(' / ')];
    });
    writeCsv('report-P1-price-qty.csv', ['SKU', '상품명', '현재 박스가', 'ERP 박스가', '최종 박스가', '현재 낱개가', 'ERP 낱개가',
      '최종 낱개가', '현재 입수', 'ERP 입수', '최종 입수', '참고', 'action', '설명'], p1Rows);

    // ── P15. 한글명 1.5차 제안 (DB에 쓰지 않음) ──
    // 넓은 규칙으로 자동 삭제하지 않는다. 이름 "맨 끝"이 정확히 " 1CTN(CASE)=숫자P" 인 경우에만 그 부분을 뗀 제안을 만들고,
    // 그 외에는 ERP 원문을 그대로 제안하고 "사람 확인"으로 표시한다.
    const EXACT_TAIL = /^(.*\S)\s1CTN\(CASE\)=\d+P$/;
    const p15Rows = [];
    let p15Clean = 0; let p15Manual = 0;
    for (const s2 of site) {
      if (isTogo(s2)) continue;
      const e = erp.get(String(s2.sku));
      if (!e || blank(e.nameKo)) continue;
      if (hasHangul(s2.name_ko) || !hasHangul(e.nameKo)) continue;
      const raw = String(e.nameKo);
      const m = raw.match(EXACT_TAIL);
      let proposal; let how; let check = '';
      if (m) { proposal = m[1].trim(); how = '끝의 " 1CTN(CASE)=숫자P" 만 뗌'; p15Clean++; }
      else { proposal = raw; how = 'ERP 원문 그대로'; check = '사람 확인 필요'; p15Manual++; }
      if (/CTN|CASE/i.test(proposal)) check = '포장 표기가 남아 있음 — 사람 확인 필요';
      p15Rows.push([s2.sku, s2.name_ko ?? '', raw, proposal, how, check]);
    }
    writeCsv('report-P15-name-ko.csv', ['SKU', '현재 Site nameKo', 'ERP raw nameKo', '제안 Site nameKo', '제안 방식', '확인'], p15Rows);

    // ── 화면 보고 ──
    const line = (k, v) => console.log(`${String(k).padEnd(28, ' ')} ${v}`);
    console.log('\n================ DRY RUN 보고 (DB는 바뀌지 않았습니다) ================');
    console.log('\n[C] ERP 노출 상품 전체 구성');
    line('ERP 노출 합계', erp.size);
    for (const k of ['UPDATE_EXISTING', 'ADD_FROM_ERP', 'KEEP_LOCAL_TOGO', 'REVIEW_BARCODE_NAME', 'EXCLUDED_NON_PRODUCT', 'MISSING_REQUIRED', 'DUPLICATE_SKU']) line(k, countBy[k] || 0);
    const sum = Object.values(countBy).reduce((a, b) => a + b, 0);
    line('합계 확인', `${sum} ${sum === erp.size ? '= 전부 설명됨 ✅' : '≠ 불일치 ⚠'}`);
    line('ERP 원본 중 removed 표시', erpAll.length - erpVisible.length);
    line('ERP 원본 중 중복 SKU', dupSkus.length);

    console.log('\n[A] 기존 상품(SKU 일치, 비TOGO) 항목별 변경 수');
    line('대상 상품 수', countBy.UPDATE_EXISTING || 0);
    line('실제로 바뀌는 값이 없는 상품', noChangeCount);
    console.log('  항목        변경   (공백·대소문자만)   ERP 빈 값→기존 유지');
    for (const [f] of FIELDS) console.log(`  ${f.padEnd(10)} ${String(fieldCount[f]).padStart(5)}   ${String(fieldCosmetic[f]).padStart(10)}           ${String(fieldSkipped[f]).padStart(5)}`);
    console.log(`\n  이름 차이 분석`);
    console.log(`    영문명: 포장표기(1CTN)만 다름 ${packOnly.nameEn} / 그 외 실제로 다름 ${fieldCount.nameEn - packOnly.nameEn - fieldCosmetic.nameEn}`);
    console.log(`    한글명: 포장표기(1CTN)만 다름 ${packOnly.nameKo} / 사이트 칸이 영어→ERP 한글 ${koFix} / 그 외 ${fieldCount.nameKo - packOnly.nameKo - koFix - fieldCosmetic.nameKo}`);
    for (const f of ['nameEn', 'nameKo', 'spec', 'category']) {
      console.log(`\n  ▶ ${f} 변경 예시 (최대 10개)`);
      if (!examples[f].length) console.log('    (없음)');
      for (const x of examples[f]) console.log(`    ${x.sku} [${x.kindLabel}]\n      사이트: ${x.site}\n      ERP   : ${x.erp}`);
    }

    console.log('\n[B] 신규 상품 분류 추천 (ERP에 쓰지 않음)');
    line('신규 상품 수', bRows.length);
    line('추천 가능', bRows.length - noSuggest);
    line('추천 없음(직접 지정)', noSuggest);
    console.log('  추천 분류별 개수:');
    for (const [c, n] of Object.entries(bSummary).sort((a, b) => b[1] - a[1])) console.log(`    ${c.padEnd(20)} ${n}`);
    const confCount = bRows.reduce((a, r) => { a[r[5]] = (a[r[5]] || 0) + 1; return a; }, {});
    console.log(`  확신도: ERP 지정 ${confCount['ERP 지정'] || 0} / 높음 ${confCount['높음'] || 0} / 보통 ${confCount['보통'] || 0} / 낮음 ${confCount['낮음'] || 0} / 없음 ${confCount['없음'] || 0}`);
    console.log(`  기준 분류(사이트): ${siteCats.join(', ')}  (표시용 NEW 등 제외)`);
    console.log(`  기준 분류(ERP)   : ${[...erpCats].sort().join(', ')}`);
    const newCats = [...erpCats].filter((c) => !siteCatSet.has(c));
    if (newCats.length) console.log(`  ※ 사이트에 아직 없는 분류: ${newCats.join(', ')}`);

    // B 추가 집계 — 사이트에 새로 생기는 분류별 개수
    const newCatCount = {};
    for (const r of bRows) if (r[7]) newCatCount[r[4]] = (newCatCount[r[4]] || 0) + 1;
    const erpAssigned = bRows.filter((r) => r[5] === 'ERP 지정').length;
    const suggested = bRows.filter((r) => r[4] && r[5] !== 'ERP 지정').length;
    console.log(`  ERP 지정 분류 ${erpAssigned} / 추천 분류 ${suggested} / 미추천 ${noSuggest}`);
    console.log('  사이트에 새로 생기는 분류별 개수:' + (Object.keys(newCatCount).length ? '' : ' (없음)'));
    for (const [cName, n] of Object.entries(newCatCount).sort((a, b) => b[1] - a[1])) console.log(`    ${cName.padEnd(20)} ${n}`);

    const pc = plan.counts;
    console.log('\n[P1] 1차 동기화 (박스가·입수 전용) — 실제 동기화와 같은 계산');
    line('대상 (비TOGO, SKU 일치)', pc.target);
    line('실제로 바뀌는 상품', pc.willChange);
    line('바뀌는 값 없음', pc.noChange);
    console.log(`  칸별 변경: 박스가 ${pc.field.ctn_price} / 입수 ${pc.field.ctn_qty}  (낱개가는 1차 대상 아님)`);
    console.log(`  ERP 값 없음·무효 → 기존 유지: 박스가 ${pc.keptBecauseErpInvalid.ctn_price} / 입수 ${pc.keptBecauseErpInvalid.ctn_qty}`);
    console.log(`  건드리지 않음: TOGO ${pc.togoSkipped} / 사이트 전용 ${pc.siteOnlySkipped}`);
    if (pc.tbdGetsPrice) console.log(`  참고: "가격 문의"로 표시 중인데 가격이 들어가는 상품 ${pc.tbdGetsPrice}개 (표시 상태는 1차에서 바꾸지 않음)`);

    console.log('\n[P15] 한글명 1.5차 제안 (DB에 쓰지 않음)');
    line('대상 (사이트 칸 영어 + ERP 한글)', p15Rows.length);
    line('끝의 포장표기만 뗀 제안', p15Clean);
    line('ERP 원문 그대로 (사람 확인)', p15Manual);

    console.log('\n파일 5개를 만들었습니다 (엑셀로 열어보세요):');
    console.log(`  report-P1-price-qty.csv    (${p1Rows.length}줄)  ← 1차 동기화 최종 확인용`);
    console.log(`  report-P15-name-ko.csv     (${p15Rows.length}줄)  ← 한글명 제안`);
    console.log(`  report-A-field-diff.csv    (${aRows.length}줄)`);
    console.log(`  report-B-new-category.csv  (${bRows.length}줄)`);
    console.log(`  report-C-other.csv         (${cRows.length}줄)`);
    console.log('※ 이 도구는 DB를 전혀 바꾸지 않았습니다 (읽기 전용).');
  } catch (e) {
    console.error('⛔ 확인 실패:', e.message);
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
})();
