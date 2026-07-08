// api/products.js
const { getUserFromToken, getBearerToken } = require('../lib/auth');
const db = require('../lib/db');

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

    const outProducts = canSeePrices ? products : products.map(stripPrices);

    return res.json({
      products: outProducts,
      togoPageImages,
      pricesVisible: canSeePrices,
      approved: user ? user.approved : null,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
};
