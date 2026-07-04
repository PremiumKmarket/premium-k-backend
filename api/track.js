// api/track.js
const db = require('../lib/db');
const { getUserFromToken, getBearerToken } = require('../lib/auth');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

const ALLOWED_EVENTS = new Set([
  'view_product', 'add_to_cart', 'remove_from_cart', 'search',
  'submit_order', 'open_lightbox', 'switch_mode', 'category_browse',
]);

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { eventType, sku, detail, deviceId } = req.body;
    if (!ALLOWED_EVENTS.has(eventType)) {
      return res.status(400).json({ error: 'INVALID_EVENT' });
    }

    const token = getBearerToken(req);
    const user = await getUserFromToken(token);

    await db.query(
      `INSERT INTO behavior_events (user_id, phone, device_id, event_type, sku, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [user ? user.id : null, user ? user.phone : null, deviceId || null, eventType, sku || null, detail ? JSON.stringify(detail) : null]
    );

    return res.status(204).end();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
};
