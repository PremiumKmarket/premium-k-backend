// tests/erpCatalogSync.test.js — ERP 가격 반영 판단(lib/erpCatalogSync.js) 단위 시험
// 실행: node --test tests/*.test.js   (DB·ERP 없이 돈다)
const test = require('node:test');
const assert = require('node:assert/strict');
const { planUpdate, tsKey } = require('../lib/erpCatalogSync');

const erp = (sku, extra = {}) => ({ sku, removed: false, nameKo: sku, nameEn: sku, ctnQty: 16, ctnPrice: 96, piecePrice: 6, updatedAt: '2026-11-21 01:00:00.000001+00', ...extra });
const site = (sku, extra = {}) => ({ id: `id-${sku}`, sku, cat: '수산물/건어물', ctn_price: '96.00', ctn_qty: 16, price: '6.00', tbd: false, ...extra });

test('값이 같으면 바꾸지 않는다', () => {
  const p = planUpdate([erp('A')], [site('A')]);
  assert.equal(p.update.length, 0);
  assert.equal(p.counts.same, 1);
});

test('박스가·입수·낱개가가 다르면 바꾸고, 가격 문의는 푼다', () => {
  const p = planUpdate([erp('A', { ctnPrice: 120, ctnQty: 20 })], [site('A', { ctn_price: '96.00', ctn_qty: 16, price: '6.00', tbd: true })]);
  assert.equal(p.update.length, 1);
  assert.deepEqual(p.update[0].after, { ctn_price: 120, ctn_qty: 20, price: 6, tbd: false });
  assert.deepEqual(p.update[0].changes.sort(), ['ctn_price', 'ctn_qty', 'tbd']);
});

test('ERP에 박스가가 없으면 사이트 가격을 그대로 둔다', () => {
  const p = planUpdate([erp('A', { ctnPrice: null })], [site('A', { ctn_price: '50.00' })]);
  assert.equal(p.update.length, 0);
  assert.equal(p.counts.noErpPrice, 1);
});

test('ERP에 낱개가·입수가 없으면 사이트 값을 그대로 둔다', () => {
  const p = planUpdate([erp('A', { ctnPrice: 100, piecePrice: null, ctnQty: null })], [site('A', { ctn_price: '96.00', ctn_qty: 16, price: '6.00' })]);
  assert.deepEqual(p.update[0].after, { ctn_price: 100, ctn_qty: 16, price: 6, tbd: false });
});

test('TOGO·사이트에 없는 상품·노출 해제 상품은 건드리지 않는다', () => {
  const p = planUpdate([erp('T', { ctnPrice: 1 }), erp('X'), erp('R', { removed: true, ctnPrice: 1 })],
    [site('T', { cat: 'TOGO SOLUTION' }), site('R', { ctn_price: '50.00' })]);
  assert.equal(p.update.length, 0);
  assert.equal(p.counts.togo, 1); assert.equal(p.counts.notOnSite, 1); assert.equal(p.counts.removed, 1);
});

test('큰 변화(3배 넘게)와 입수 1은 자동으로 바꾸지 않고 확인 필요로 남긴다', () => {
  const p = planUpdate([erp('UP', { ctnPrice: 400, piecePrice: null }), erp('DOWN', { ctnPrice: 20, piecePrice: null }), erp('Q1', { ctnPrice: 90, ctnQty: 1, piecePrice: null }), erp('OK', { ctnPrice: 250, piecePrice: null })],
    [site('UP', { ctn_price: '96.00' }), site('DOWN', { ctn_price: '96.00' }), site('Q1', { ctn_qty: 16 }), site('OK', { ctn_price: '96.00' })]);
  assert.deepEqual(p.update.map((u) => u.sku), ['OK']);
  assert.deepEqual(p.review.map((r) => r.sku).sort(), ['DOWN', 'Q1', 'UP']);
});

test('자동 실행은 지난번 뒤로 ERP에서 바뀐 상품만 본다 (마이크로초까지)', () => {
  const items = [erp('OLD', { ctnPrice: 100, piecePrice: null, updatedAt: '2026-11-21 01:00:00.000001+00' }), erp('NEW', { ctnPrice: 100, piecePrice: null, updatedAt: '2026-11-21 01:00:00.000002+00' })];
  const p = planUpdate(items, [site('OLD'), site('NEW')], { since: '2026-11-21 01:00:00.000001+00' });
  assert.deepEqual(p.update.map((u) => u.sku), ['NEW']);
  assert.equal(p.counts.notChanged, 1);
  assert.ok(tsKey('2026-11-21T01:00:00Z') < tsKey('2026-11-21 01:00:00.000001+00'));
});

test('ERP 목록에 같은 SKU가 두 번이면 확인 필요', () => {
  const p = planUpdate([erp('D', { ctnPrice: 100 }), erp('D', { ctnPrice: 110 })], [site('D')]);
  assert.equal(p.update.length, 0);
  assert.equal(p.review.length, 2);
});

// v8.13 — 2026-11-21 운영 미리보기에서 나온 실제 사례
const { planAddNew } = require('../lib/erpCatalogAdd');
const item = (sku, nameKo, nameEn, extra = {}) => ({ sku, nameKo, nameEn, cat: null, spec: null, ctnQty: 20, ctnPrice: 200, piecePrice: 10, removed: false, ...extra });
const srow = (sku, name_ko, name_en, cat = '수산물/건어물') => ({ id: 'x' + sku, sku, cat, name_ko, name_en });

test('품번만 바뀐 같은 상품(이름이 거의 같음)은 넣지 않고 확인 필요', () => {
  const site = [srow('TKRPR500', 'Frozen Red Pollock Roe (500g)', 'Frozen Red Pollock Roe (500g)', 'NEW'),
    srow('THFZSF0089', 'Frozen Salted Pollock Roe Tube', 'Frozen Salted Pollock Roe Tube', 'NEW'),
    srow('THFZSF0059', '해운대 양념초장 350G', 'Sweet & Sour Vinegar Gochujang Sauce 350G', '양념/스낵'),
    srow('THRTSF0047', '서래곱창김 20P', 'Seorae Gopchang Seaweed 2.2G x 20P'),
    srow('THRTSN0052', '최석당 저온압착 참기름 180ML', "Choi's Stone Cold Pressed Oil 180ML - Sesame Oil", '양념/스낵'),
    srow('ET-302308', 'ET-302308', 'ET-302308', 'TOGO SOLUTION')];
  const items = [item('THFZSF0088', '빨간 명란 정란 500g', 'Frozen Red Pollock Roe (500g, 17.64oz)', { ctnPrice: 220, piecePrice: 11 }),
    item('THFZSF0090', '송가수산 실속형 명란 분란 1kg', 'Frozen Salted Pollock Roe Tube (1Kg, 2.2lb)', { ctnPrice: 250, ctnQty: 10, piecePrice: 25 }),
    item('THRTSN0059', '[잘식비]해운대 양념초장 (350g)', 'Sweet & Sour Vinegar Gochujang 350g', { ctnPrice: 70, ctnQty: 35, piecePrice: 2 }),
    item('THRTSF0168', '[아임리얼]서래곱창김', "[I'm Real]Seorae Gopchang Seaweed(2.2g x 20p)", { ctnPrice: 50.4, ctnQty: 12, piecePrice: 4.2 }),
    item('THRTSN0150', '[최석당] 저온압착 참기름 (100ml)', 'Premium Cold Pressed Oil (100ml) - Sesame', { ctnPrice: 180, ctnQty: 30, piecePrice: 6 }),
    item('THRTKT0125', '[카카오프렌즈]리쥬러블 텀블러 - 라이언 / 투명', 'KAKAOReusable Tumbler -RYAN / CLEAR', { ctnPrice: 220, ctnQty: 100, piecePrice: 2.2 })];
  const p = planAddNew(items, site, {});
  assert.deepEqual(p.add.map((a) => a.row.sku).sort(), ['THRTKT0125', 'THRTSN0150']);
  assert.deepEqual(p.review.map((r) => r.sku).sort(), ['THFZSF0088', 'THFZSF0090', 'THRTSF0168', 'THRTSN0059']);
  assert.ok(p.review.every((r) => /이름이 거의 같은 상품/.test(r.why)));
});

test('박스가 ≠ 낱개가 × 입수면 넣지도 바꾸지도 않는다', () => {
  const add = planAddNew([item('THRTFH0901', '곤드레나물', 'Gondre Namul', { ctnPrice: 288, ctnQty: 20, piecePrice: 8 })], [], {});
  assert.equal(add.add.length, 0);
  assert.match(add.review[0].why, /≠ 낱개가/);
  const upd = planUpdate([erp('THRTFH0110', { ctnPrice: 288, ctnQty: 20, piecePrice: 8 })], [site('THRTFH0110', { ctn_price: '288.00', ctn_qty: 36, price: '8.00' })]);
  assert.equal(upd.update.length, 0);
  assert.match(upd.review[0].why, /≠ 낱개가/);
  // 1% 안의 반올림 차이는 괜찮다
  const ok = planUpdate([erp('A', { ctnPrice: 99.9, ctnQty: 30, piecePrice: 3.33 })], [site('A', { ctn_price: '90.00', ctn_qty: 30, price: '3.00' })]);
  assert.equal(ok.update.length, 1);
});
