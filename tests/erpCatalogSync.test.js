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
  const p = planUpdate([erp('UP', { ctnPrice: 400 }), erp('DOWN', { ctnPrice: 20 }), erp('Q1', { ctnPrice: 90, ctnQty: 1 }), erp('OK', { ctnPrice: 250 })],
    [site('UP', { ctn_price: '96.00' }), site('DOWN', { ctn_price: '96.00' }), site('Q1', { ctn_qty: 16 }), site('OK', { ctn_price: '96.00' })]);
  assert.deepEqual(p.update.map((u) => u.sku), ['OK']);
  assert.deepEqual(p.review.map((r) => r.sku).sort(), ['DOWN', 'Q1', 'UP']);
});

test('자동 실행은 지난번 뒤로 ERP에서 바뀐 상품만 본다 (마이크로초까지)', () => {
  const items = [erp('OLD', { ctnPrice: 100, updatedAt: '2026-11-21 01:00:00.000001+00' }), erp('NEW', { ctnPrice: 100, updatedAt: '2026-11-21 01:00:00.000002+00' })];
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
