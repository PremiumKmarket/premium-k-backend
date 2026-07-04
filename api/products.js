// api/products.js
// Returns the full catalog. If the caller has a valid, APPROVED session,
// real prices are included. Otherwise, prices are stripped and replaced
// with a `locked: true` flag so the frontend can show the blinking
// "로그인/회원가입 시 가격 확인 가능" prompt instead.

const products = require('../data/products.json');
const togoPageImages = require('../data/togo_page_images.json');
const { getUserFromToken, getBearerToken } = require('../lib/auth');
const db = require('../lib/db');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
