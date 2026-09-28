# ERP → Site Order 상품 동기화 (v1.2)

서버에는 동기화 창구·cron 이 없다(Vercel Hobby 서버 기능 12개 유지). 모든 반영은 **대표님 PC의 1회 실행기**로만 한다.
모든 실행기는 **기본이 확인(DRY RUN)**이고, 실제 반영은 `--apply --expect=숫자` 를 함께 줘야 한다.

| 단계 | 실행기 | 바꾸는 칸 | 되돌리기 |
|---|---|---|---|
| 1차 | `scripts/run-erp-phase1-sync.js` | ctn_price, ctn_qty | `scripts/rollback-erp-phase1.js 백업` |
| 2차 | `scripts/run-erp-price-sync.js` | price 하나 | `scripts/rollback-erp-price.js 백업` |
| 보고 | `scripts/dryrun-erp-catalog-report.js` | 없음(읽기 전용) | — |

2차는 ERP v3.2.4 이상(piecePrice)이 필요하다. 구버전이면 모든 상품이 SKIP_NO_PIECE_PRICE.

## 공통 안전 검사 (lib/erpCatalogGuards.js) — 자동 반영 제외
비율은 **ERP 박스가 ÷ (ERP 입수 × ERP 낱개가)** 로만 계산한다. 사이트의 기존 값으로 대신하지 않는다
(사이트 값은 오래됐거나 수동 입력일 수 있어 교차 검증 의미가 없어진다). 허용 범위 0.65~1.35.

1차 (바뀌는 값이 있는 상품만, 이 순서로):
1. REVIEW_QTY_TO_ONE — 사이트 입수 > 1 인데 ERP 입수 = 1 (1→1, 실제 1입 상품은 정상)
2. REVIEW_DATA_MISSING — ERP 박스가·입수·낱개가 중 하나라도 없음 (ERP 구버전이면 여기로 — 정상)
3. REVIEW_RATIO — 비율이 범위 밖

## 2차 분류 — 모든 대상 SKU 가 정확히 하나, 판정 우선순위
1. REVIEW_QTY_TO_ONE
2. SKIP_PRICE_INQUIRY — 사이트의 명시적 "가격 문의" 표시(tbd)만 기준, price=0 으로 추정하지 않음
3. SKIP_NO_PIECE_PRICE — ERP piecePrice 없음
4. REVIEW_DATA_MISSING — piecePrice 는 있으나 ERP 박스가·입수, 또는 사이트 현재 낱개가가 없음/0
5. REVIEW_RATIO
6. REVIEW_PRICE_JUMP — 사이트 현재 낱개가 대비 50% 초과
7. UNCHANGED
8. AUTO_UPDATE

## 절대 쓰지 않는 값·바꾸지 않는 칸
ERP unit_price, 옛 price 칸, 박스가로 계산한 값. 이름·분류·규격·사진·주소·옵션·가격문의·숨김, 신규 추가, TOGO 전체.
