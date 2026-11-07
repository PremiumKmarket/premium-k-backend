// lib/erpCatalogAdd.js  v1.0 (Site Order v8.8) — ERP에 있는데 주문 사이트에 없는 상품을 사이트 목록에 추가
//
// 정책 (2026-11-07 대표님 결정: "ERP에 있거나 제안서에 있는 것은 다 보여야 한다", 일괄 추가 + 이후 자동, 이름으로 자동 분류)
//  · 대상: ERP /api/site-orders/catalog 가 내보내는 상품 = ERP에서 판매중이고 'Site Order 노출'이 켜진 상품.
//    (제안서로 ERP에 등록한 상품도 여기에 포함된다. 제안서를 ERP에 아직 안 올린 상품은 ERP 등록이 먼저다.)
//  · 하는 일: 사이트에 같은 SKU가 없으면 새로 넣는 것뿐. 이미 있는 상품은 손대지 않는다(가격·이름 갱신은 별도 1·2차 도구).
//    ERP에서 노출을 끄거나 판매중지해도 사이트에서 자동으로 내리지 않는다.
//  · 넣지 않는 것: ERP 목록 안 중복 SKU, 샘플·무상·승압기·시험용 상품, 이름이 없거나 바코드뿐인 상품,
//    같은 상품으로 보이는 코드가 둘 이상(이름이 같음)인 경우, 사이트에 같은 이름의 상품이 다른 코드로 이미 있는 경우,
//    이 도구가 넣었다가 사이트 관리자 화면에서 지운 상품 — 모두 보고서에 '확인 필요'로 남긴다.
//  · 분류: ERP 분류가 사이트 분류와 같으면 그대로, 아니면 상품 이름으로 추천(규칙 + 기존 사이트 상품의 단어).
//    판단이 안 되면 '기타'.
//  · 가격: 박스가(ctn_price)·박스입수(ctn_qty)·낱개가(price)는 ERP 값 그대로. 박스가가 없으면 '가격 문의'(tbd)로 넣는다.
//  · 이름: ERP 이름 끝의 포장 표기 "1CTN(CASE)=40P" 를 떼고, 화면을 깨뜨릴 수 있는 < > 는 뺀다.
//    한글명이 없으면 영문명을, 영문명이 없으면 한글명을 쓴다(화면이 두 칸을 모두 쓰기 때문).

const TOGO_CAT = 'TOGO SOLUTION';
const SITE_CATS = ['수산물/건어물', '즉석식품', '양념/스낵', '나물/간편식', '건강식품', '주방용품', '음료/주류'];
const FALLBACK_CAT = '기타';
// ERP 정식 상품 코드: TH + 보관(FZ 냉동·RT 상온 등 2자) + 종류(SF·KT·WL… 2자) + 숫자 4자리 (예: THFZSF0018)
// 그 밖의 코드(예: CRABSOY70GPR, ABALONESLICE-2)는 옛 상품 목록에서 넘어온 것으로, 같은 상품의 TH 코드가 따로 있는 경우가 많다.
const STANDARD_SKU = /^TH[A-Z]{2}[A-Z]{2}\d{4}$/;
const DISPLAY_CATS = new Set(['NEW', 'SALE', 'BEST', 'HOT']);

const blank = (v) => v == null || String(v).trim() === '';
const squash = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

// 포장 표기 떼기: "… 1CTN(CASE)=40P", "… 40p CTN", "… 20P/CTN"
function stripPack(v) {
  let s = squash(v);
  s = s.replace(/\s*\d*\s*CTN\s*\(\s*CASE\s*\)\s*=\s*\d+\s*P\s*$/i, '');
  s = s.replace(/\s+\d+\s*(p|pc|pcs|ea)\s*\/?\s*(ctn|case|box)\s*$/i, '');
  return squash(s);
}
// ERP 이름에 직원용 메모가 붙은 경우가 있다(예: "[Item Value $6.60]", "unit price $1.35", "*** Delivered with …") — 손님 화면에는 빼고 보여준다
const stripNotes = (v) => String(v ?? '')
  .replace(/\[[^\]]*(item\s*value|delivered|open\s*box)[^\]]*\]/gi, ' ')
  .replace(/\bunit\s*price\s*\$?\s*[\d.,]+/gi, ' ')
  .replace(/\*{2,}.*$/, ' ');
const cleanText = (v, max = 300) => {
  const s = stripPack(stripNotes(v)).replace(/[<>]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ');
  return squash(s).slice(0, max);
};

// ERP 상품 목록에는 인보이스에 줄로 넣으려고 만든 '상품 아닌 항목'(운임·배송비·크레딧·월별 청구 등)과
// 다른 상품의 옵션·메모 줄이 섞여 있다(9/25 확인: Invoice April 2026, Freight, ITEM-2, "300g", "64박스 (16 x 4단 적재)" 등).
// 'Site Order 노출'은 기본값이 켜짐이라 이것만으로는 거를 수 없어서 이름으로 거른다.
function nonProductReason(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  if (n.startsWith('└') || n.startsWith('▶')) return '하위·메모 표시줄';
  const low = n.toLowerCase();
  if (/sampling|sample|샘플/.test(low)) return '샘플';
  if (/no\s*charge|free\s*of\s*charge|\bfoc\b|무상/.test(low)) return '무상(No Charge)';
  if (/transformer|승압기/.test(low)) return '승압기';
  if (/\btest\b|테스트/.test(low)) return '시험용 상품';
  if (/^(ab)+$/i.test(n.replace(/\s/g, ''))) return '시험용 데이터';
  if (/^invoice\b|청구서/.test(low)) return '청구 항목';
  if (/freight|shipping\s*(charge|cost)|delivery\s*charge|배송비|운임|운송료/.test(low)) return '운임·배송비';
  if (/credit\s*apply|크레딧|discount\s*apply|할인\s*적용/.test(low)) return '크레딧·할인';
  if (/mark(e)?ting\s*fee|service\s*fee|수수료|\bfee\b/.test(low)) return '수수료';
  if (/\bcrv\b|redemption\s*value|deposit\s*fee/.test(low)) return '용기 보증금(CRV)';
  if (/^item(-\d+)?$/i.test(n)) return '이름 없는 임시 항목';
  if (/\breturned\b|반품|incorrect\s*expiration|라벨\s*오류/.test(low)) return '반품·불량 메모가 붙은 항목';
  if (/팔렛|팔레트|pallet|적재/.test(low)) return '적재·팔렛 메모';
  if (/^[\d.,\s]*(g|kg|ml|l|lb|lbs|oz|p|ea|박스|개)?$/i.test(n)) return '용량·수량만 있는 줄';
  return null;
}
function looksLikeBarcode(name) {
  const n = squash(name);
  if (!n) return false;
  if (/^\d{8,}\s*(CT|EA|BOX|PK)?$/i.test(n)) return true;
  const digits = (n.match(/\d/g) || []).length;
  const letters = (n.match(/[A-Za-z가-힣]/g) || []).length;
  return digits >= 8 && letters <= 2;
}

// ── 분류 규칙 ──
// strong(3점) = 상품 종류를 정하는 말(김치, 비빔밥, 막걸리, 소스…), weak(2점) = 재료 말(황태, 오징어, 버터…), en(1점) = 영문 단어.
// 예) "황태 김치" → 김치(나물/간편식 3) > 황태(수산 2),  "버터 오징어다리" → 버터(양념 2) = 오징어(수산 2) → 규칙 순서로 수산.
// 한글은 이름 안 어디든 찾는다(붙여 쓴 이름이 많음). 영문은 단어 단위.
const RULES = [
  { cat: '음료/주류', strong: /막걸리|소주|맥주|와인|사케|청주|증류주|약주|탁주|식혜|수정과|음료|주스|쥬스|커피|아메리카노|헤이즐넛|아이스티|탄산수|생수|에이드|라떼|우유/, weak: null,
    enStrong: /\b(makgeolli|soju|juice|coffee|americano|latte|cafe\s*latte|cafelatte|ade|iced\s*tea|milk)\b/i,
    en: /\b(makgeolli|soju|beer|wine|sake|liquor|juice|beverage|drinks?|coffee|soda|sikhye|cider)\b/i },
  { cat: '건강식품', enStrong: /\b(ginseng|collagen|gaba[-\s]*lagen|supplements?|extract)\b/i, strong: /홍삼|인삼|산삼|흑삼|녹용|진액|엑기스|쌍화|비타민|숙취|두유|콩국물|영양제|프로폴리스|꽃차|건강즙|[가-힣]즙|콜라겐|가바|유산균|[가-힣]차(?=[\s(\d]|$)/, weak: /건강|약콩/,
    en: /\b(ginseng|extract|supplements?|vitamins?|hangover|soy\s*milk|herbal|tea|collagen|gaba|probiotics?)\b/i },
  { cat: '주방용품', enStrong: /\b(tumblers?|bottles?|dish\s*cloths?|kitchen\s*(cloth|towel)s?|scrubbers?|gloves?|containers?|grill\s*pan)\b/i, strong: /용기|도시락통|불판|그릴|종이컵|뚜껑|젓가락|숟가락|수저|집게|가위|위생장갑|비닐장갑|호일|쿠킹|비닐봉투|냅킨|빨대|킵밥|트레이|접시|그릇|행주|수세미|텀블러|보틀|바틀|채반|조리판|국자|뒤집개|도마/, weak: null,
    en: /\b(containers?|lids?|cups?|chopsticks?|spoons?(?!\s*worm)|tongs|gloves?|foil|wrap|napkins?|straws?|trays?|plates?|bowls?|grill\s*pan|tumblers?|bottles?|dish\s*cloths?|kitchen\s*(cloth|towel)s?|scrubbers?|ladle)\b/i },
  { cat: '수산물/건어물', enStrong: /\b(sashimi|akagai|clams?|squid(?!\s+fish\s*cake)|whelk|spoon\s*worms?|jellyfish|abalone|seaweed|nori|laver|anchovy|pollack|pollock|roe|eel|mackerel|cuttlefish|scallops?|jerky|crab)\b/i, strong: /오징어다리|젓갈|명란젓|창란젓|오징어젓|어리굴젓|식해|게장|과메기|건어물|[가-힣]포(?=[\s(]|$)|쥐포|알포|노가리|수산/,
    weak: /조개|바지락|꼬막|홍합|전복|소라|골뱅이|개불|해파리|매생이|날치알|우니|도루묵|임연수|삼치|전어|민어|병어|굴(?!비|뚝)|해삼|멍게|성게|오징어|한치|문어|낙지|쭈꾸미|주꾸미|꼴뚜기|새우|대게|홍게|꽃게|게살|킹크랩|랍스터|장어|아나고|고등어|갈치|조기|굴비|명태|황태|북어|코다리|먹태|대구|연어|참치|광어|우럭|도미|가자미|볼락|복어|아귀|멸치|꽁치|청어|가리비|관자|미역|다시마|파래|톳|[가-힣]*김(?=[\s(\d]|$)|숏다리|노리|명란|창란|어란|생선|[가-힣]회(?=[\s(]|$)/,
    en: /\b(fish|clams?|squid|octopus|shrimps?|prawns?|crabs?|lobster|eel|anago|mackerel|anchovy|seaweed|laver|nori|kelp|abalone|oysters?|mussels?|scallops?|whelk|roe|pollack|pollock|cod|salmon|tuna|flounder|cuttlefish|sashimi|akagai|seafood|jerky|saury|herring|filefish|monkfish|sea\s*mustard|sea\s*cucumber|urchin|gwamegi)\b/i },
  { cat: '즉석식품', enStrong: /\b(tteokbokki|dumplings?|mandu|noodles?|kalguksu|ramen|udon|fish\s*cake(\s*bar)?|bread|dough|songpyeon|rice\s*cakes?|mochi|sweet\s*potato(es)?|ready[-\s]*to[-\s]*eat|rte)\b/i, strong: /고구마|떡볶이|떡국|송편|꿀떡|찹쌀떡|인절미|가래떡|만두|어묵|핫바|순대|족발|보쌈|국밥|찌개|[가-힣]탕(?!수육)|[가-힣]죽(?=[\s(]|$)|비빔밥|볶음밥|영양밥|김밥|주먹밥|국수|칼국수|라면|냉면|우동|쫄면|즉석|피자|돈까스|돈가스|부침개|[가-힣]전(?=[\s(]|$)|생지|떡갈비|불고기|소시지|[가-힣]밥(?=[\s(]|$)/,
    weak: /떡(?!갈비)|빵|도우|갈비|햄|닭|간편/,
    en: /\b(dumplings?|mandu|songpyeon|rice\s*cakes?|tteok|tteokbokki|noodles?|ramen|udon|soup|stew|ready[-\s]*to[-\s]*eat|rte|frozen\s*meals?|pizza|bread|dough|bulgogi|sausages?|chicken|sundae|jokbal)\b/i },
  { cat: '나물/간편식', enStrong: /\b(kimchi|natto|namul|bibimbap\s*mix|tofu|(organic|brown|white|gaba)\s*(\(\w+\)\s*)?rice(?!\s*(cake|noodle)))\b/i, strong: /나물|고사리|도라지|시래기|시레기|곤드레|무말랭이|반찬|장아찌|김치|깍두기|나또|두부|가바쌀|백미|현미쌀|잡곡/,
    weak: /버섯|콩(?!국물)|쌀|잡곡|현미|보리|누룽지|절임/,
    en: /\b(namul|banchan|side\s*dish|kimchi|natto|tofu|mushrooms?|radish|greens?|beans?|grains?)\b/i },
  { cat: '양념/스낵', enStrong: /\b(sauce|ssamjang|gochujang|doenjang|wasabi|coin\s*cook|broth|seasoning|snacks?|sesame\s*oil|perilla\s*oil|cold\s*pressed|vinegar|relish)\b/i, strong: /양념(?!.*(게장|족발|갈비|불고기))|소스|고추장|된장|간장|쌈장|초장|청국장|참기름|들기름|식용유|식초|소금|설탕|고춧가루|와사비|액젓|조청|물엿|과자|스낵|젤리|사탕|쿠키|초콜릿|강정|부각|한과|약과|육수|코인|다시팩|조미료|꾸이|초대리|다시마초|[가-힣]장(?=[\s(]|$)/,
    weak: /기름|깨|버터|잼|꿀|견과|칩/,
    en: /\b(sauce|paste|gochujang|doenjang|soy\s*sauce|oils?|vinegar|salt|sugar|pepper|wasabi|butter|jam|honey|syrup|snacks?|chips?|jelly|candy|cookies?|chocolate|nuts?|crackers?|seasoning|broth|stock|bouillon|coin\s*cook)\b/i },
];

function ruleScores(ko, en) {
  const s = {};
  for (const r of RULES) {
    let n = 0;
    if (r.strong && r.strong.test(ko)) n += 3;
    else if (r.weak && r.weak.test(ko)) n += 2;
    if (r.enStrong && r.enStrong.test(en)) n += 3;
    else if (r.en.test(en)) n += 1;
    if (n) s[r.cat] = n;
  }
  return s;
}

const STOP = new Set(['ctn', 'case', 'box', 'ea', 'pk', 'pcs', 'pc', 'the', 'and', 'with', 'of', 'for', 'x', 'g', 'kg', 'ml', 'l', 'lb', 'lbs', 'oz',
  'premium', 'korean', 'korea', 'new', 'ct', 'retail', 'set', 'large', 'small', 'big', 'mini',
  // 맛·포장을 나타내는 말은 분류 단서가 아니다(예: 막걸리 "Original" 때문에 과자 "Original"이 음료로 가지 않게)
  'original', 'spicy', 'flavor', 'sweet', 'hot', 'fresh', 'organic', 'mix', 'kit', 'pack', 'packs', 'box', 'boxes', 'item', 'value',
  '오리지널', '매운맛', '순한맛', '맛', '세트', '대용량', '프리미엄', '대형', '중형', '소형', 'functional', 'reusable', 'kakao', '카카오프렌즈', 'roasted', 'fire']);
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

const isRealCat = (c) => !blank(c) && !DISPLAY_CATS.has(String(c).trim().toUpperCase()) && String(c).trim().toUpperCase() !== TOGO_CAT;

// 기존 사이트 상품(비TOGO, 실제 분류)에서 단어 → 분류 빈도를 배운다 (브랜드 이름 등 규칙에 없는 단서)
function learnWords(siteRows) {
  const wordCat = new Map();
  for (const s of siteRows) {
    if (!isRealCat(s.cat)) continue;
    for (const w of tokens(s.name_en, s.name_ko)) {
      if (!wordCat.has(w)) wordCat.set(w, {});
      const m = wordCat.get(w); m[s.cat] = (m[s.cat] || 0) + 1;
    }
  }
  return wordCat;
}

// 이름 속 '종류'가 분명한 경우 먼저 정한다 (예: 게 맛 코인육수는 수산물이 아니라 육수)
const OVERRIDES = [
  [/coin\s*cook|코인\s*육수|코인육수/i, '양념/스낵', '코인육수'],
];

function suggestCategory(item, wordCat, allowedCats) {
  const erpCat = squash(item.cat);
  if (erpCat && allowedCats.has(erpCat)) return { cat: erpCat, why: 'ERP 분류' };
  const both = `${item.nameKo || ''} ${item.nameEn || ''}`;
  for (const [re, cat, label] of OVERRIDES) if (re.test(both) && allowedCats.has(cat)) return { cat, why: label };
  const ko = stripPack(`${erpCat} ${item.nameKo || ''}`), en = stripPack(`${erpCat} ${item.nameEn || ''}`);
  const score = {};
  const rs = ruleScores(`${ko} ${en}`, en);
  for (const [c, n] of Object.entries(rs)) score[c] = (score[c] || 0) + n;
  const hits = {};
  for (const w of tokens(item.nameEn, item.nameKo)) {
    const m = wordCat.get(w); if (!m) continue;
    const total = Object.values(m).reduce((a, b) => a + b, 0);
    for (const [c, n] of Object.entries(m)) {
      score[c] = (score[c] || 0) + n / total;
      (hits[c] = hits[c] || []).push(w);
    }
  }
  const ranked = Object.entries(score).filter(([c]) => allowedCats.has(c)).sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] < 0.6) return { cat: FALLBACK_CAT, why: '판단 근거 없음' };
  const [best, bestScore] = ranked[0];
  if (ranked[1] && ranked[1][1] === bestScore) {
    // 동점이면 규칙(이름 속 품목 단어)이 있는 쪽 → 그래도 같으면 규칙 순서(RULES)가 앞선 쪽
    const order = RULES.map((r) => r.cat);
    const tied = ranked.filter(([, s]) => s === bestScore).map(([c]) => c);
    tied.sort((a, b) => (rs[b] ? 1 : 0) - (rs[a] ? 1 : 0) || order.indexOf(a) - order.indexOf(b));
    return { cat: tied[0], why: `동점 → ${rs[tied[0]] ? '품목 단어' : '규칙 순서'}` };
  }
  const why = rs[best] ? '품목 단어' : `비슷한 상품 단어: ${(hits[best] || []).slice(0, 3).join(', ')}`;
  return { cat: best, why };
}

const posNum = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

function toSiteRow(item, cat) {
  const ko = cleanText(item.nameKo), en = cleanText(item.nameEn);
  const ctnPrice = posNum(item.ctnPrice);
  return {
    sku: String(item.sku).trim(),
    cat,
    name_ko: ko || en,
    name_en: en || ko,
    spec: blank(item.spec) ? null : cleanText(item.spec, 120),
    ctn_qty: posInt(item.ctnQty),
    ctn_price: ctnPrice,
    price: posNum(item.piecePrice),   // 낱개가 — ERP piece_price 만(단가 unit_price 로 대신하지 않음)
    tbd: ctnPrice === null,           // 박스가가 없으면 '가격 문의'
  };
}

const normName = (v) => cleanText(v).toLowerCase().replace(/[^a-z0-9가-힣]+/g, '');

/**
 * @param {Array} erpItems  ERP /catalog 의 items (removed 포함 가능)
 * @param {Array} siteRows  사이트 products 행 {sku, cat, name_ko, name_en, ctn_qty}
 * @param {Object} [opts]
 * @param {Set<string>} [opts.previouslyAdded]  이 도구가 예전에 넣은 SKU(erp_catalog_add_log). 사이트에 없으면 관리자가 지운 것 → 다시 넣지 않음
 * @param {Set<string>|null} [opts.onlySkus]    자동 추가용: 이 SKU들만 넣을 후보로 본다(ERP에서 최근 바뀐 상품).
 *                                              중복 코드 판단에는 전체 목록을 그대로 쓴다.
 * @returns {{ add: Array, review: Array, skipped: Object, counts: Object }}
 */
function planAddNew(erpItems, siteRows, opts = {}) {
  const previouslyAdded = opts.previouslyAdded || new Set();
  const onlySkus = opts.onlySkus || null;
  const siteSkus = new Set(siteRows.map((r) => String(r.sku || '').trim()).filter(Boolean));
  const wordCat = learnWords(siteRows);
  const allowedCats = new Set([...SITE_CATS, ...siteRows.filter((r) => isRealCat(r.cat)).map((r) => r.cat)]);

  const seen = new Map();
  for (const i of erpItems) { const k = String(i.sku || '').trim(); seen.set(k, (seen.get(k) || 0) + 1); }

  // 사이트에 이미 있는 상품의 이름 (TOGO 제외) — 옛 코드로 올라가 있는 같은 상품을 TH 코드로 또 넣지 않게.
  // 박스입수는 보지 않는다: ERP에 같은 상품이 입수 1·20 처럼 다르게 적힌 경우가 있다(로컬 확인: THFZRE0184 20 / THFZSN0184 1).
  const nameKeys = (en, ko) => [`en:${normName(en)}`, `ko:${normName(ko)}`].filter((k) => !/^(en|ko):$/.test(k));
  const siteNameKeys = new Map();
  for (const r of siteRows) {
    if (String(r.cat || '').trim().toUpperCase() === TOGO_CAT) continue;
    for (const k of nameKeys(r.name_en, r.name_ko)) if (!siteNameKeys.has(k)) siteNameKeys.set(k, String(r.sku || '').trim());
  }

  const add = [], review = [];
  const skipped = { exists: 0, removed: 0, togo: 0, unchanged: 0 };
  const candidates = [];
  for (const i of erpItems) {
    const sku = String(i.sku || '').trim();
    if (i.removed) { skipped.removed += 1; continue; }
    if (!sku || !/^[A-Za-z0-9._-]{1,40}$/.test(sku)) { review.push({ sku, item: i, why: 'SKU에 한글·공백 등이 들어 있음(대부분 포장재 코드)' }); continue; }
    if (/^TEMP-/i.test(sku)) { review.push({ sku, item: i, why: '임시 코드(TEMP-) — ERP에서 정식 코드를 붙인 뒤 자동으로 올라감' }); continue; }
    if (!STANDARD_SKU.test(sku)) { review.push({ sku, item: i, why: '옛 코드(TH 코드 아님) — 같은 상품이 TH 코드로 이미 있을 수 있음' }); continue; }
    if (siteSkus.has(sku)) { skipped.exists += 1; continue; }
    if (String(i.cat || '').trim().toUpperCase() === TOGO_CAT) { skipped.togo += 1; continue; }
    if (previouslyAdded.has(sku)) { review.push({ sku, item: i, why: '예전에 ERP에서 넣었다가 사이트 관리자 화면에서 지운 상품 — 다시 넣지 않음' }); continue; }
    if (seen.get(sku) > 1) { review.push({ sku, item: i, why: 'ERP 목록에 같은 SKU가 두 번 이상' }); continue; }
    const ex = nonProductReason(i.nameEn) || nonProductReason(i.nameKo);
    if (ex) { review.push({ sku, item: i, why: `상품 아님: ${ex}` }); continue; }
    if (blank(i.nameEn) && blank(i.nameKo)) { review.push({ sku, item: i, why: '영문명·한글명 모두 없음' }); continue; }
    if (looksLikeBarcode(i.nameEn) && blank(i.nameKo)) { review.push({ sku, item: i, why: '상품명이 바코드·숫자뿐' }); continue; }
    candidates.push(i);
  }

  // 같은 상품으로 보이는 코드 여러 개(포장 표기를 뗀 영문명이 같거나 한글명이 같음) → 어느 코드가 맞는지 사람이 정한다
  //  (예: THFZRE0184 / THFZSN0184 'Five-Color Songpyeon (320g)' — 박스입수는 20과 1로 다르게 적혀 있었다)
  const groupOf = new Map();
  const byKey = new Map();
  for (const i of candidates) {
    for (const k of nameKeys(i.nameEn, i.nameKo)) {
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(i);
    }
  }
  for (const g of byKey.values()) {
    if (g.length < 2) continue;
    const merged = new Set(g);
    for (const x of g) for (const y of (groupOf.get(x) || [])) merged.add(y);
    for (const x of merged) groupOf.set(x, merged);
  }
  for (const i of candidates) {
    const sku = String(i.sku).trim();
    const g = [...(groupOf.get(i) || [i])];
    if (g.length > 1) { review.push({ sku, item: i, why: `같은 상품으로 보이는 코드 ${g.length}개: ${g.map((x) => x.sku).join(', ')}` }); continue; }
    const twin = nameKeys(i.nameEn, i.nameKo).map((k) => siteNameKeys.get(k)).find(Boolean);
    if (twin) { review.push({ sku, item: i, why: `사이트에 같은 이름의 상품이 다른 코드(${twin})로 이미 있음` }); continue; }
    const { cat, why } = suggestCategory(i, wordCat, allowedCats);
    add.push({ row: toSiteRow(i, cat), catWhy: why, item: i });
  }

  // 자동 추가: 최근 바뀐 상품만 넣고, 보고도 그 상품들만 (나머지는 이미 일괄 추가 때 보고된 것)
  let outAdd = add, outReview = review;
  if (onlySkus) {
    outAdd = add.filter((a) => onlySkus.has(a.row.sku));
    skipped.unchanged = add.length - outAdd.length;
    outReview = review.filter((r) => onlySkus.has(r.sku));
  }
  const byCat = {};
  for (const a of outAdd) byCat[a.row.cat] = (byCat[a.row.cat] || 0) + 1;
  return {
    add: outAdd, review: outReview, skipped,
    counts: { erp: erpItems.length, add: outAdd.length, review: outReview.length, tbd: outAdd.filter((a) => a.row.tbd).length, byCat, ...skipped },
  };
}

// 한 트랜잭션 안에서 넣는다(부르는 쪽이 BEGIN/COMMIT). 같은 SKU가 그새 생겼으면 건너뛴다(ON CONFLICT).
// 넣은 상품은 erp_catalog_add_log 에 적는다(되돌리기·'지운 상품 다시 넣지 않기'용) — 표는 STATE_SQL(lib/erpCatalogAuto.js)이 만든다.
async function applyAddNew(client, add, source = 'bulk') {
  const inserted = [];
  for (const { row } of add) {
    const r = await client.query(
      `INSERT INTO products (cat, name_ko, name_en, sku, price, ctn_price, ctn_qty, spec, tbd, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
               COALESCE((SELECT max(sort_order) FROM products WHERE cat = $1), 0) + 1)
       ON CONFLICT (sku) DO NOTHING RETURNING id, sku`,
      [row.cat, row.name_ko, row.name_en, row.sku, row.price, row.ctn_price, row.ctn_qty, row.spec, row.tbd]);
    if (!r.rows[0]) continue;
    inserted.push(r.rows[0]);
    await client.query(
      `INSERT INTO erp_catalog_add_log (sku, product_id, source) VALUES ($1, $2, $3)
       ON CONFLICT (sku) DO UPDATE SET product_id = EXCLUDED.product_id, source = EXCLUDED.source, added_at = now()`,
      [r.rows[0].sku, r.rows[0].id, source]);
  }
  return inserted;
}

module.exports = { STANDARD_SKU, planAddNew, applyAddNew, suggestCategory, learnWords, stripPack, cleanText, nonProductReason, SITE_CATS, FALLBACK_CAT, TOGO_CAT };
