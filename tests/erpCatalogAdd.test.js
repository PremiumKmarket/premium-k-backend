// tests/erpCatalogAdd.test.js — ERP 신상품 추가 판단(lib/erpCatalogAdd.js)·시각 읽기(lib/erpCatalogAuto.js) 단위 시험
// 실행: node --test tests/   (DB·ERP 없이 돈다)
const test = require('node:test');
const assert = require('node:assert/strict');
const { planAddNew, stripPack, cleanText, nonProductReason, suggestCategory, learnWords, SITE_CATS } = require('../lib/erpCatalogAdd');
const { parseErpTime } = require('../lib/erpCatalogAuto');

const item = (sku, nameKo, nameEn, extra = {}) => ({ sku, removed: false, nameKo, nameEn, cat: null, spec: null, ctnQty: 10, ctnPrice: 100, price: 12, piecePrice: 11, updatedAt: '2026-11-07 10:00:00.123456+00', ...extra });
const site = [
  { sku: 'THFZSF0001', cat: '수산물/건어물', name_ko: '백골뱅이', name_en: 'Whelk', ctn_qty: 24 },
  { sku: 'THRTSA0001', cat: '양념/스낵', name_ko: '쌈장', name_en: 'Ssamjang', ctn_qty: 12 },
  { sku: 'OLDCODE-1', cat: '즉석식품', name_ko: '오색송편', name_en: 'Five-Color Songpyeon (320g)', ctn_qty: 20 },
  { sku: 'TG-001', cat: 'TOGO SOLUTION', name_ko: '용기', name_en: 'Container', ctn_qty: 300 },
];
const allowed = new Set(SITE_CATS);
const cat = (ko, en, c = null) => suggestCategory({ nameKo: ko, nameEn: en, cat: c }, learnWords(site), allowed).cat;

test('포장 표기·직원 메모·꺾쇠를 뺀다', () => {
  assert.equal(stripPack('Korean Blood Clam 12p 1CTN(CASE)=40P'), 'Korean Blood Clam 12p');
  assert.equal(stripPack('Seaweed Snack 40p CTN'), 'Seaweed Snack');
  assert.equal(cleanText('Gim [Item Value $6.60] <Special>'), 'Gim Special');
  assert.equal(cleanText('Tea unit price $1.35'), 'Tea');
  assert.equal(cleanText('Mandu *** Delivered with open box'), 'Mandu');
});

test('상품이 아닌 줄을 거른다', () => {
  for (const n of ['Invoice April 2026', 'Freight', 'Credit Apply', 'ITEM-2', '300g', '64박스 (16 x 4단 적재)', 'Sample Kimchi', 'No Charge Item', 'CRV', '└ option']) {
    assert.ok(nonProductReason(n), n);
  }
  for (const n of ['피조개 12p (100g)', 'Korean Blood Clam Sashimi', '떡볶이']) assert.equal(nonProductReason(n), null, n);
});

test('이름으로 분류를 정한다', () => {
  assert.equal(cat('피조개 12p (100g)', 'Korean Blood Clam Sashimi (Akagai) 12p 100g'), '수산물/건어물');
  assert.equal(cat('꽃게맛 코인육수', 'Crab Coin Cook'), '양념/스낵');
  assert.equal(cat('포기김치', 'Napa Cabbage Kimchi'), '나물/간편식');
  assert.equal(cat('떡볶이', 'Tteokbokki'), '즉석식품');
  assert.equal(cat('텀블러', 'Tumbler'), '주방용품');
  assert.equal(cat('아메리카노', 'Americano Coffee'), '음료/주류');
  assert.equal(cat('콜라겐', 'Collagen'), '건강식품');
  assert.equal(cat('선풍기', 'Desk Fan'), '기타');
  assert.equal(cat('자연산 개불 (500g)', 'Wild Spoon Worm (500g)'), '수산물/건어물');   // 'Spoon' 때문에 주방용품으로 가지 않게
  assert.equal(cat('수저 세트', 'Spoon Set'), '주방용품');
  assert.equal(cat('아무거나', 'Anything', '음료/주류'), '음료/주류');   // ERP 분류가 사이트 분류와 같으면 그대로
});

test('넣을 것·넣지 않을 것을 가른다', () => {
  const erp = [
    item('THFZSF0018', '피조개 12p (100g)', 'Korean Blood Clam Sashimi (Akagai) 12p 100g 1CTN(CASE)=40P', { ctnPrice: 520, ctnQty: 40, piecePrice: null }),
    item('THFZSF0001', '백골뱅이', 'Whelk'),                                   // 이미 있음
    item('THRTKT0099', '가위', 'Scissors', { removed: true }),               // ERP에서 내림
    item('TEMP-00012', '새 상품', 'New item'),                               // 임시 코드
    item('CRABSOY70GPR', '간장게장', 'Soy Crab'),                            // 옛 코드
    item('THFZRE0184', '오색송편', 'Five-Color Songpyeon (320g)', { ctnQty: 20 }),  // 사이트에 옛 코드로 있음
    item('THFZRE0200', '찹쌀떡', 'Mochi', { ctnQty: 30 }),
    item('THFZSN0200', '', 'Mochi 30p CTN', { ctnQty: 1 }),                 // 같은 상품 코드 둘(입수가 다르게 적혀 있어도)
    item('THRTNP0001', 'Invoice May 2026', 'Invoice May 2026'),              // 상품 아님
    item('THRTNP0002', '', '8801234567890 CT'),                               // 바코드뿐
    item('THRTSA0050', '고추장', 'Gochujang', { ctnPrice: null }),            // 박스가 없음 → 가격 문의
    item('THRTSA0060', '참기름', 'Sesame Oil'),
    item('THRTSA0060', '참기름', 'Sesame Oil'),                               // ERP 목록에 같은 SKU 두 번
    item('THRTTG0001', '용기', 'Container', { cat: 'TOGO SOLUTION' }),        // TOGO
    item('THRTSA0070', '', 'Perilla Oil'),                                    // 한글명 없음 → 영문명으로
    item('THRTSA0080', '들깨가루', 'Perilla Powder'),                         // 예전에 넣었다가 사이트에서 지움
  ];
  const plan = planAddNew(erp, site, { previouslyAdded: new Set(['THRTSA0080']) });
  const addSkus = plan.add.map((a) => a.row.sku).sort();
  assert.deepEqual(addSkus, ['THFZSF0018', 'THRTSA0050', 'THRTSA0070']);
  const why = Object.fromEntries(plan.review.map((r) => [r.sku, r.why]));
  assert.match(why['TEMP-00012'], /임시 코드/);
  assert.match(why.CRABSOY70GPR, /옛 코드/);
  assert.match(why.THFZRE0184, /다른 코드\(OLDCODE-1\)/);
  assert.ok(planAddNew([item('THFZRE0184', '오색송편', 'Five-Color Songpyeon (320g)', { ctnQty: 1 })], site).review.length === 1);   // 입수가 달라도 같은 이름이면 확인 필요
  assert.match(why.THFZRE0200, /같은 상품으로 보이는 코드 2개/);
  assert.match(why.THFZSN0200, /같은 상품으로 보이는 코드 2개/);
  assert.match(why.THRTNP0001, /상품 아님/);
  assert.match(why.THRTNP0002, /바코드/);
  assert.match(why.THRTSA0060, /두 번 이상/);
  assert.match(why.THRTSA0080, /지운 상품/);
  assert.equal(plan.skipped.exists, 1);
  assert.equal(plan.skipped.removed, 1);
  assert.equal(plan.skipped.togo, 1);

  const clam = plan.add.find((a) => a.row.sku === 'THFZSF0018').row;
  assert.equal(clam.cat, '수산물/건어물');
  assert.equal(clam.name_en, 'Korean Blood Clam Sashimi (Akagai) 12p 100g');
  assert.equal(clam.ctn_price, 520);
  assert.equal(clam.ctn_qty, 40);
  assert.equal(clam.price, null);          // 낱개가는 ERP piece_price 만 — 없으면 비워 둔다
  assert.equal(clam.tbd, false);
  const gochu = plan.add.find((a) => a.row.sku === 'THRTSA0050').row;
  assert.equal(gochu.tbd, true);
  assert.equal(gochu.ctn_price, null);
  const perilla = plan.add.find((a) => a.row.sku === 'THRTSA0070').row;
  assert.equal(perilla.name_ko, 'Perilla Oil');
  assert.equal(plan.counts.tbd, 1);
});

test('자동 추가는 최근 바뀐 상품만 넣되, 중복 판단은 전체 목록으로 한다', () => {
  const erp = [
    item('THFZRE0200', '찹쌀떡', 'Mochi', { ctnQty: 30 }),
    item('THFZSN0200', '찹쌀떡', 'Mochi', { ctnQty: 30 }),
    item('THRTSA0050', '고추장', 'Gochujang'),
    item('THRTSA0051', '된장', 'Doenjang'),
  ];
  const plan = planAddNew(erp, site, { onlySkus: new Set(['THFZSN0200', 'THRTSA0050']) });
  assert.deepEqual(plan.add.map((a) => a.row.sku), ['THRTSA0050']);
  assert.deepEqual(plan.review.map((r) => r.sku), ['THFZSN0200']);   // 쌍둥이(THFZRE0200)는 안 바뀌었어도 중복으로 잡힘
  assert.equal(plan.skipped.unchanged, 1);                              // 된장: 넣을 수 있지만 이번에 바뀐 상품이 아님
});

test('ERP 시각 문자열을 읽는다', () => {
  const base = Date.UTC(2026, 10, 7, 10, 0, 0);
  assert.equal(parseErpTime('2026-11-07 10:00:00+00'), base);
  assert.equal(parseErpTime('2026-11-07T10:00:00Z'), base);
  assert.equal(parseErpTime('2026-11-07 02:00:00-08'), base);
  assert.equal(parseErpTime('2026-11-07 15:30:00+05:30'), base);
  assert.equal(Math.round(parseErpTime('2026-11-07 10:00:00.123456+00')), base + 123);
  assert.equal(parseErpTime('어제'), null);
  assert.equal(parseErpTime(null), null);
});
