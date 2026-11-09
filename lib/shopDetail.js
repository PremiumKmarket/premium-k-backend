// lib/shopDetail.js  v1.0 (Site Order v8.9) — premium-k.com(샵) 상품 상세를 주문 사이트 안에서 보여 주기
//
// · 주문 사이트 상품의 '상세 페이지 주소'(products.url)가 premium-k.com/products/<handle> 이면 그 샵 상품과 연결된 것으로 본다.
//   (DB 구조는 바꾸지 않는다 — 관리자 상품 화면의 기존 URL 칸을 그대로 쓴다)
// · 샵의 공개 상품 JSON(/products/<handle>.js)에서 설명·사진·소매가만 가져온다. 샵 관리자 권한·비밀값은 쓰지 않는다.
// · 설명 HTML은 허용한 태그·속성만 남기고(sanitize-html) https 이미지·링크만 둔다 → 주문 사이트에 그대로 넣어도 스크립트가 돌지 않는다.
// · 서버 한 대당 10분 캐시(없는 상품은 2분, 샵 오류는 30초). 샵이 느리거나 꺼져 있어도 주문 사이트는 '상세 정보를 불러오지 못함'만 표시.
// · 샵에서 상품 주소(handle)를 바꾸면 옛 주소의 .js 는 404 지만 상품 페이지는 새 주소로 넘어간다(301) → 그 새 주소를 따라간다(같은 샵 안, 최대 3번).
// sanitize-html 은 설명을 정리할 때만 불러온다 — 혹시 설치·로드에 문제가 있어도 상품 목록 전체가 아니라 상세 창만 영향을 받게.
let sanitizeHtmlLib = null;
const sanitizeHtml = (html, opts) => (sanitizeHtmlLib || (sanitizeHtmlLib = require('sanitize-html')))(html, opts);

const SHOP_ORIGIN = 'https://premium-k.com';
const SHOP_HOSTS = new Set(['premium-k.com', 'www.premium-k.com']);
const TIMEOUT_MS = 4000;
const TTL_MS = 10 * 60 * 1000, MISS_TTL_MS = 2 * 60 * 1000, ERR_TTL_MS = 30 * 1000;
const HANDLE_RE = /^[\p{L}\p{N}_-]{1,200}$/u;
const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

// 샵 상품 주소 → handle. 다른 사이트 주소·형식이 다르면 null
function handleFromUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!SHOP_HOSTS.has(u.hostname.toLowerCase())) return null;
    const m = /\/products\/([^/?#]+)/.exec(u.pathname);
    if (!m) return null;
    const h = decodeURIComponent(m[1]).trim().toLowerCase();
    return HANDLE_RE.test(h) ? h : null;
  } catch { return null; }
}

const toHttps = (src) => {
  const s = String(src || '').trim();
  if (s.startsWith('//')) return 'https:' + s;
  return s;
};

function cleanDescription(html) {
  return sanitizeHtml(String(html || ''), {
    allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'div',
      'img', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'a', 'blockquote', 'hr', 'sup', 'sub'],
    // target·rel·loading 은 아래 transformTags 가 정한 값만 들어간다(원문 값은 덮어씀)
    allowedAttributes: { img: ['src', 'alt', 'width', 'height', 'loading'], a: ['href', 'target', 'rel'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] },
    allowedSchemes: ['https'],
    allowedSchemesByTag: { img: ['https'] },
    allowProtocolRelative: false,
    transformTags: {
      img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, src: toHttps(attribs.src), loading: 'lazy' } }),
      // 샵 설명 안의 상대 주소(/blogs/...)는 샵 주소로 바꾼다(주문 사이트 안에서 깨지지 않게). https 가 아니면 주소를 뺀다.
      a: (tagName, attribs) => {
        let href;
        const raw = String(attribs.href || '').trim();
        try { if (raw) { const u = new URL(raw, SHOP_ORIGIN + '/'); if (u.protocol === 'https:') href = u.href; } } catch { /* 주소 없음 */ }
        const { href: _drop, ...rest } = attribs;
        return { tagName, attribs: { ...rest, ...(href ? { href } : {}), target: '_blank', rel: 'noopener noreferrer' } };
      },
      h1: 'h3',
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && !/^https:\/\//.test(frame.attribs.src || ''),
  }).trim();
}

const cache = new Map();      // handle → { at, data } 또는 { at, err }
const inflight = new Map();   // handle → Promise (같은 상품을 동시에 여러 번 부르면 샵에는 한 번만)

async function getWithTimeout(url, timeoutMs, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...opts, signal: controller.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('shop timeout');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 옛 handle → 샵이 넘겨 주는 새 handle (같은 샵의 /products/<handle> 일 때만). 없으면 null
async function movedHandle(handle, origin, timeoutMs) {
  const resp = await getWithTimeout(`${origin}/products/${encodeURIComponent(handle)}`, timeoutMs, { redirect: 'manual', headers: { Accept: 'text/html' } });
  if (![301, 302, 307, 308].includes(resp.status)) return null;
  const loc = resp.headers.get('location');
  if (!loc) return null;
  let u;
  try { u = new URL(loc, origin + '/'); } catch { return null; }
  const okHost = u.host === new URL(origin).host || SHOP_HOSTS.has(u.hostname.toLowerCase());
  const m = /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/products\/([^/?#]+)\/?$/i.exec(u.pathname);
  if (!okHost || !m) return null;
  let h;
  try { h = decodeURIComponent(m[1]).trim().toLowerCase(); } catch { return null; }
  return HANDLE_RE.test(h) && h !== handle ? h : null;
}

async function loadShopProduct(handle, origin, timeoutMs) {
  let h = handle;
  for (let hop = 0; hop <= 3; hop++) {
    const resp = await getWithTimeout(`${origin}/products/${encodeURIComponent(h)}.js`, timeoutMs, { headers: { Accept: 'application/json' } });
    if (resp.status === 404) {
      if (hop === 3) return null;
      const next = await movedHandle(h, origin, timeoutMs);
      if (!next) return null;
      h = next;
      continue;
    }
    if (!resp.ok) throw new Error(`shop ${resp.status}`);
    const p = await resp.json();
    const cents = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) / 100 : null);
    const imgs = [...new Set([p.featured_image, ...(Array.isArray(p.images) ? p.images : [])].filter(Boolean).map(toHttps))]
      .filter((x) => /^https:\/\//.test(x)).slice(0, 8);
    const finalHandle = String(p.handle || h);
    return {
      handle: finalHandle,
      title: String(p.title || ''),
      html: cleanDescription(p.description || p.body_html || ''),
      images: imgs,
      retailPrice: cents(p.price_min ?? p.price),
      retailPriceMax: cents(p.price_max ?? p.price),
      available: p.available !== false,
      url: `${SHOP_ORIGIN}/products/${encodeURIComponent(finalHandle)}`,
    };
  }
  return null;
}

function remember(handle, entry) {
  cache.set(handle, { at: Date.now(), ...entry });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
}

/** 샵 상품 상세. 없으면 null, 샵 오류면 예외(30초 동안은 샵에 다시 묻지 않고 같은 오류) */
async function fetchShopProduct(handle, { timeoutMs = TIMEOUT_MS, origin = SHOP_ORIGIN } = {}) {
  const hit = cache.get(handle);
  if (hit) {
    const age = Date.now() - hit.at;
    if (hit.err) { if (age < ERR_TTL_MS) throw new Error(hit.err); }
    else if (age < (hit.data ? TTL_MS : MISS_TTL_MS)) return hit.data;
  }
  if (inflight.has(handle)) return inflight.get(handle);
  const job = (async () => {
    try {
      const data = await loadShopProduct(handle, origin, timeoutMs);
      remember(handle, { data });
      return data;
    } catch (err) {
      remember(handle, { err: (err && err.message) || 'shop error' });
      throw err;
    } finally {
      inflight.delete(handle);
    }
  })();
  inflight.set(handle, job);
  return job;
}

// ── 관리자: 샵 상품 찾기 (상품 화면에서 '상세 페이지 주소'를 채울 때) ──
let indexCache = null;   // { at, list:[{handle,title,image,price}] }
async function shopIndex({ origin = SHOP_ORIGIN } = {}) {
  if (indexCache && Date.now() - indexCache.at < TTL_MS) return indexCache.list;
  const list = [];
  for (let page = 1; page <= 10; page++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let products;
    try {
      const resp = await fetchFn(`${origin}/products.json?limit=250&page=${page}`, { signal: controller.signal });
      if (!resp.ok) throw new Error(`shop ${resp.status}`);
      products = (await resp.json()).products || [];
    } finally { clearTimeout(timer); }
    for (const p of products) {
      list.push({ handle: p.handle, title: p.title, image: p.images && p.images[0] ? toHttps(p.images[0].src) : null,
        price: p.variants && p.variants[0] ? Number(p.variants[0].price) : null });
    }
    if (products.length < 250) break;
  }
  indexCache = { at: Date.now(), list };
  return list;
}

const STOP = new Set('the and with of in for g oz kg ml lb lbs pcs p x pack packs box free shipping premium korean korea fl ea bag bags sheets set sets'.split(' '));
const words = (s) => new Set((String(s || '').toLowerCase().match(/[a-z]+|\d+|[가-힣]+/g) || []).filter((w) => w.length > 1 && !STOP.has(w)));
function searchShop(list, q, limit = 20) {
  const qa = words(q);
  if (!qa.size) return [];
  return list
    .map((p) => { const b = words(p.title + ' ' + p.handle.replace(/-/g, ' ')); let hit = 0; for (const w of qa) if (b.has(w)) hit++; return { p, score: hit / qa.size }; })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.title.length - b.p.title.length)
    .slice(0, limit)
    .map((x) => ({ ...x.p, url: `${SHOP_ORIGIN}/products/${x.p.handle}`, score: Math.round(x.score * 100) / 100 }));
}

module.exports = { handleFromUrl, fetchShopProduct, cleanDescription, shopIndex, searchShop, SHOP_ORIGIN, _cache: cache };
