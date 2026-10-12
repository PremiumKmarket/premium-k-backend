// lib/fulfillment.js
//
// 주문서의 "수령 방법"별 안내 (Site Order v8.4 화면과 같은 내용).
// 카드결제 때 만드는 Shopify 주문(Draft Order)에 그대로 적어서, Shopify 주문 화면에서도
// 어디서·언제 받는지 보이게 한다. orders.delivery_method 는 VARCHAR(20) — 값은 20자 이내.
//
// 픽업은 재고가 없을 수 있으므로 "픽업 2일 전까지 담당 영업사원에게 확인 필수" (회사 결정 2026-10-13).
const PICKUP_NOTICE = 'Confirm with your sales rep at least 2 days before pickup — items may be out of stock. 픽업 2일 전까지 담당 영업사원에게 확인 필수 — 재고가 없을 수 있습니다.';

const FULFILLMENT = {
  delivery: { label: 'Premium K delivery 딜리버리', pickup: false },
  shipping: { label: 'Shipping 택배', pickup: false },
  pickup_warehouse: {
    label: 'Warehouse pickup 창고 픽업', pickup: true,
    address: '1717 Aeros Way, Montebello, CA 90640',
    hours: 'Mon–Fri 9 AM–4 PM (월–금 오전 9시–오후 4시)',
  },
  pickup_store: {
    label: 'Store pickup (LA #1) 매장 픽업 (LA 1호점)', pickup: true,
    address: '3506 W 8th St, Los Angeles, CA 90005',
    hours: 'Mon–Sat 10 AM–6 PM (월–토 오전 10시–오후 6시)',
  },
};

function fulfillmentInfo(method) {
  return FULFILLMENT[method] || null;
}

module.exports = { FULFILLMENT, PICKUP_NOTICE, fulfillmentInfo };
