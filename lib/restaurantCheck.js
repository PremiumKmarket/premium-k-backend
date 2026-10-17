// lib/restaurantCheck.js — 가입할 때 넣은 레스토랑 이름 + 주소가 실제 영업 중인 식당인지 구글 지도(Places API New)로 확인
// (회사 결정 2026-10-16, James 요청)
//
//   확인됨(verified)  : 같은 번지·거리·우편번호에 영업 중(OPERATIONAL)인 식당(구글 대표 업종 기준)이 있고, 가게 이름이 입력한 이름과 같음
//   (주의) 그 식당이 실제로 있다는 것만 확인한다 — 가입한 사람이 그 식당 주인인지는 확인하지 못한다.
//          그래서 같은 식당(placeId)으로 이미 가입한 계정이 있으면 register.js가 골드로 처리한다.
//   확인 안 됨(not_found) : 위 조건에 맞는 곳이 없음
//   확인 실패(error)  : 구글 응답 없음·오류 (가입은 막지 않음)
//   꺼짐(off)          : GOOGLE_PLACES_API_KEY 환경변수가 없음 → 확인하지 않음
//
// 비용: Text Search Pro (월 5,000건까지 무료). 가입 1건에 1번만 부른다. 키 값은 로그·응답에 남기지 않는다.

// 식당으로 보는 구글 업종: restaurant·○○_restaurant(한식·스시 등)·포장/배달 전문·푸드코트·다이너·카페·바·델리.
// 'food'는 마트·그로서리에도 붙어서 넣지 않는다.
const FOOD_TYPES = new Set([
  'restaurant', 'meal_takeaway', 'meal_delivery', 'food_court', 'diner', 'bistro', 'cafe', 'bar', 'pub', 'wine_bar', 'deli',
]);
const FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.types,places.primaryType,places.businessStatus';
const TIMEOUT_MS = 4000;

const HANGUL = /[가-힣]/;
const ZIP_RE = /\b(\d{5})(?:-\d{4})?\b/g;

const isFoodType = (t) => typeof t === 'string' && (FOOD_TYPES.has(t) || /_restaurant$/.test(t));
// 구글의 대표 업종(primaryType)으로 판단 — 마트인데 보조 업종에 deli가 붙은 경우 등을 막기 위해.
// 대표 업종이 없을 때만 보조 업종 목록을 보되, 마트·그로서리 업종이 섞여 있으면 식당으로 보지 않는다.
const NOT_FOOD = new Set(['grocery_store', 'supermarket', 'market', 'convenience_store', 'wholesaler', 'warehouse_store', 'store', 'food_store', 'asian_grocery_store']);
function isFoodPlace(p) {
  if (p && p.primaryType) return isFoodType(p.primaryType);
  const ts = Array.isArray(p && p.types) ? p.types : [];
  return ts.some(isFoodType) && !ts.some((t) => NOT_FOOD.has(t));
}

// 주소에서 우편번호(마지막 5자리)·번지(맨 앞 숫자)·거리 이름 첫 단어(방향 W·North 등은 건너뜀)를 뽑는다
const DIRS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest']);
function addrKey(address) {
  const s = String(address || '').trim();
  const zips = [...s.matchAll(ZIP_RE)].map((m) => m[1]);
  const m = s.match(/^#?\s*(\d+)[\s,-]+(.*)$/);
  let street = null;
  if (m) {
    const words = m[2].split(/[\s,]+/).map((w) => w.toLowerCase().replace(/[^0-9a-z가-힣]/g, '')).filter(Boolean);
    street = words.find((w) => !DIRS.has(w)) || null;
  }
  return { zip: zips.length ? zips[zips.length - 1] : null, num: m ? m[1] : null, street };
}

const STOP = new Set(['restaurant', 'restaurants', 'resturant', 'cafe', 'the', 'inc', 'llc', 'corp', 'co', 'and', 'bbq', 'grill', 'kitchen']);
// 이름을 단어 목록으로: 소문자·기호 제거 (한글·영문·숫자만), "&"는 and
function tokens(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/&/g, ' and ').replace(/['’`]/g, '')
    .split(/[^0-9a-z가-힣\u3040-\u30ff\u4e00-\u9fff]+/).filter(Boolean);
}
function bigrams(s) { const out = []; for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2)); return out; }
function dice(x, y) {
  const bx = bigrams(x), by = bigrams(y);
  if (!bx.length || !by.length) return 0;
  const pool = [...by]; let hit = 0;
  for (const g of bx) { const i = pool.indexOf(g); if (i >= 0) { hit++; pool.splice(i, 1); } }
  return (2 * hit) / (bx.length + by.length);
}
function similarTokens(ta, tb) {
  if (!ta.length || !tb.length) return false;
  const ja = ta.join(''), jb = tb.join('');
  if (ja.length < 2 || jb.length < 2) return false;
  if (ja === jb) return true;
  // 짧은 쪽 단어가 모두 긴 쪽에 있고, 긴 쪽 단어의 2/3 이상을 차지 ("BCD Tofu House" ↔ "BCD Tofu House Wilshire")
  const [sh, lo] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (sh.every((w) => lo.includes(w)) && sh.length / lo.length >= 0.67) return true;
  return dice(ja, jb) >= 0.75;   // 띄어쓰기·철자 차이 ("서울가든" ↔ "서울가든 LA점")
}
// 가게 이름 비교: 흔한 단어(restaurant·the·bbq 등)를 뺀 이름끼리, 또는 원래 이름끼리 같으면 같은 가게로 본다.
// 일부러 엄격하게 — 애매하면 "확인 안 됨"(골드)으로 가고 담당자가 확인한다.
function nameSimilar(a, b) {
  const ta = tokens(a), tb = tokens(b);
  const sa = ta.filter((w) => !STOP.has(w)), sb = tb.filter((w) => !STOP.has(w));
  return similarTokens(sa, sb) || similarTokens(ta, tb);
}

function judge(places, restaurantName, address) {
  const want = addrKey(address);
  const brief = (p) => ({
    placeId: p.id || null,
    name: (p.displayName && p.displayName.text) || '',
    address: p.formattedAddress || '',
    type: p.primaryType || (Array.isArray(p.types) ? p.types[0] : '') || '',
    status: p.businessStatus || '',
  });
  let nearest = null;
  for (const p of places) {
    if (!p || typeof p !== 'object') continue;
    const got = addrKey(p.formattedAddress);
    const sameAddr = !!(want.zip && got.zip === want.zip && want.num && got.num === want.num && want.street && got.street === want.street);
    const food = isFoodPlace(p);
    const open = p.businessStatus === 'OPERATIONAL';
    const sameName = nameSimilar(restaurantName, p.displayName && p.displayName.text);
    if (sameAddr && food && open && sameName) return { status: 'verified', match: brief(p) };
    if (!nearest && (sameAddr || sameName)) {
      nearest = { ...brief(p), why: !food ? 'not_food' : !open ? 'not_operational' : !sameAddr ? 'address_differs' : 'name_differs' };
    }
  }
  return { status: 'not_found', nearest };
}

// 반환: { status: 'verified'|'not_found'|'error'|'off', match?, nearest?, error? }  — 절대 throw 하지 않음
async function checkRestaurant(restaurantName, address, { fetchImpl } = {}) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return { status: 'off' };
  const base = (process.env.GOOGLE_PLACES_BASE_URL || 'https://places.googleapis.com').replace(/\/+$/, '');
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) return { status: 'error', error: 'NO_FETCH' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await f(`${base}/v1/places:searchText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELD_MASK },
      body: JSON.stringify({
        textQuery: `${restaurantName}, ${address}`.slice(0, 400),
        regionCode: 'US',
        languageCode: HANGUL.test(restaurantName) ? 'ko' : 'en',
        pageSize: 5,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return { status: 'error', error: `HTTP_${resp.status}` };
    const data = await resp.json().catch(() => null);
    if (!data || typeof data !== 'object') return { status: 'error', error: 'BAD_JSON' };
    try {
      return judge(Array.isArray(data.places) ? data.places : [], restaurantName, address);
    } catch (e) {
      return { status: 'error', error: 'BAD_RESPONSE' };
    }
  } catch (e) {
    return { status: 'error', error: e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK' };
  } finally {
    clearTimeout(timer);
  }
}

// ===== 2026-10-17 — 가입 화면 "레스토랑 검색": 고객이 구글 지도 검색 결과에서 자기 식당을 고르면 무조건 플래티늄 (James 결정) =====
// 검색 결과마다 서버가 서명한 표(token)를 붙여 보낸다. 가입할 때 그 표가 맞으면 "검색에서 고른 식당"으로 인정 (구글 재호출 없음).
const crypto = require('crypto');
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
function tokenKey() {
  const base = process.env.PREMIUM_K_SERVER_SECRET || process.env.GOOGLE_PLACES_API_KEY || '';
  return base ? crypto.createHash('sha256').update('pk-restaurant-token|' + base).digest() : null;
}
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
function signPlace(place, now = Date.now()) {
  const key = tokenKey(); if (!key) return null;
  const payload = b64u(JSON.stringify({ p: place.placeId, n: place.name, a: place.address, t: place.type, e: now + TOKEN_TTL_MS }));
  const sig = b64u(crypto.createHmac('sha256', key).update(payload).digest());
  return `${payload}.${sig}`;
}
// 맞으면 { placeId, name, address, type }, 틀리거나 만료면 null
function verifyPlaceToken(token, now = Date.now()) {
  try {
    const key = tokenKey(); if (!key || typeof token !== 'string' || token.length > 2000) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const want = crypto.createHmac('sha256', key).update(payload).digest();
    const got = unb64u(sig);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    const d = JSON.parse(unb64u(payload).toString('utf8'));
    if (!d || typeof d.p !== 'string' || typeof d.n !== 'string' || !(Number(d.e) > now)) return null;
    return { placeId: d.p, name: d.n, address: String(d.a || ''), type: String(d.t || '') };
  } catch (e) { return null; }
}

// 구글 지도에서 식당 검색 — 영업 중인 식당(대표 업종 기준)만, 최대 5곳. 반환: { status: 'ok'|'error'|'off', results?, error? } (throw 안 함)
async function searchRestaurants(query, { fetchImpl } = {}) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return { status: 'off' };
  const base = (process.env.GOOGLE_PLACES_BASE_URL || 'https://places.googleapis.com').replace(/\/+$/, '');
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) return { status: 'error', error: 'NO_FETCH' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await f(`${base}/v1/places:searchText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELD_MASK },
      body: JSON.stringify({ textQuery: String(query).slice(0, 200), regionCode: 'US', languageCode: HANGUL.test(query) ? 'ko' : 'en', pageSize: 10 }),
      signal: controller.signal,
    });
    if (!resp.ok) return { status: 'error', error: `HTTP_${resp.status}` };
    const data = await resp.json().catch(() => null);
    const places = data && Array.isArray(data.places) ? data.places : [];
    const results = places
      .filter((p) => p && typeof p === 'object' && p.id && isFoodPlace(p) && p.businessStatus === 'OPERATIONAL')
      .slice(0, 5)
      .map((p) => ({
        placeId: String(p.id),
        name: String((p.displayName && p.displayName.text) || '').slice(0, 120),
        address: String(p.formattedAddress || '').slice(0, 300),
        type: String(p.primaryType || '').slice(0, 60),
      }))
      .filter((r) => r.name);
    return { status: 'ok', results };
  } catch (e) {
    return { status: 'error', error: e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { checkRestaurant, judge, nameSimilar, isFoodPlace, addrKey, searchRestaurants, signPlace, verifyPlaceToken };
