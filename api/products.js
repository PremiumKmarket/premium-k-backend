// api/products.js
// Returns the full catalog FROM THE DATABASE (previously a static JSON
// file that required a code deploy to change — now the admin can edit
// prices/products directly via api/admin/products.js + the admin page).
//
// If the caller has a valid, APPROVED session, real prices are included.
// Otherwise, prices are stripped and replaced with a `locked: true` flag
// so the frontend can show the blinking "login to see price" prompt.

const { getUserFromToken, getBearerToken } = require('../lib/auth');
const db = require('../lib/db');
const { applyTierPricingToAll, DEFAULT_TIER } = require('../lib/pricing');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function rowToProduct(r) {
  return {
    cat: r.cat, nameKo: r.name_ko, nameEn: r.name_en, sku: r.sku,
    price: Number(r.price), ctnPrice: r.ctn_price !== null ? Number(r.ctn_price) : undefined,
    ctnQty: r.ctn_qty || undefined, img: r.img || undefined, imgPage: r.img_page || undefined,
    url: r.url || undefined, spec: r.spec || undefined,
    lidOptions: r.lid_options || undefined, colorOptions: r.color_options || undefined,
    tbd: r.tbd,
  };
}

function stripPrices(p) {
  const { price, ctnPrice, ctnQty, ...rest } = p;
  return { ...rest, locked: true };
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const token = getBearerToken(req);
    const user = await getUserFromToken(token);
    const canSeePrices = !!(user && user.approved);

    const deviceId = req.query.deviceId || null;
    if (deviceId || user) {
      db.query(
        `INSERT INTO behavior_events (user_id, phone, device_id, event_type) VALUES ($1,$2,$3,'view_catalog')`,
        [user ? user.id : null, user ? user.phone : null, deviceId]
      ).catch(() => {});
    }

    const [{ rows: productRows }, { rows: imgRows }] = await Promise.all([
      db.query('SELECT * FROM products ORDER BY cat, sort_order, name_ko'),
      db.query('SELECT page_number, img FROM togo_page_images'),
    ]);

    const products = productRows.map(rowToProduct);
    const togoPageImages = {};
    imgRows.forEach(r => { togoPageImages[r.page_number] = r.img; });

    // 승인된 고객에게만 가격을 보여주되, 그 고객의 등급(tier)에 맞춰
    // 박스단가를 조정합니다 (Tier1=기존가, Tier2=+10%, Tier3=+15%).
    const tieredProducts = canSeePrices
      ? applyTierPricingToAll(products, user.tier || DEFAULT_TIER)
      : products;

    const outProducts = canSeePrices ? tieredProducts : tieredProducts.map(stripPrices);

    return res.json({
      products: outProducts,
      togoPageImages,
      pricesVisible: canSeePrices,
      approved: user ? user.approved : null,
      tier: user ? (user.tier || DEFAULT_TIER) : null,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
};
