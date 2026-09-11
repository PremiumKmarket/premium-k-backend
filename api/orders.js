// api/orders.js
//
// SECURITY-CRITICAL FILE — see audit finding F01 (2026-09-11).
// The server NEVER trusts a client-supplied price, unitPrice, or total.
// Every order is repriced here from the `products` table using the
// caller's actual tier, exactly the same way api/products.js prices the
// catalog for display. The client only sends WHAT was ordered (sku, qty,
// mode) — never HOW MUCH it costs.

const db = require('../lib/db');
const { getUserFromToken, getBearerToken } = require('../lib/auth');
const { applyTierPricing, DEFAULT_TIER } = require('../lib/pricing');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function nextInvoiceNumber() {
  const now = new Date();
  const year = now.getFullYear();
  const yy = String(year).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');

  const { rows } = await db.query(
    `INSERT INTO invoice_counters (year, counter) VALUES ($1, 100)
     ON CONFLICT (year) DO UPDATE SET counter = invoice_counters.counter + 1
     RETURNING counter`,
    [year]
  );
  const seq = String(rows[0].counter).padStart(4, '0');
  return `${yy}-${mm}${dd}${seq}`;
}

const MAX_QTY = 100000; // sanity ceiling — not a business rule, just guards against typos/abuse

// 클라이언트가 보낸 { sku, qty, mode }만 신뢰하고, 가격은 전부 서버가
// DB 카탈로그 + 고객 등급으로 다시 계산합니다. 알 수 없는 SKU나 잘못된
// 수량이 있으면 주문 전체를 거부합니다 (부분 반영하지 않음).
async function repriceItems(rawItems, tier) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { error: 'EMPTY_ITEMS', message: 'No items in the order. 주문할 상품이 없습니다.' };
  }

  const skus = [...new Set(rawItems.map((i) => String(i.sku || '')))].filter(Boolean);
  if (skus.length === 0) {
    return { error: 'EMPTY_ITEMS', message: 'No items in the order. 주문할 상품이 없습니다.' };
  }

  const { rows: productRows } = await db.query(
    `SELECT * FROM products WHERE sku = ANY($1::text[])`,
    [skus]
  );
  const productBySku = new Map(productRows.map((r) => [r.sku, r]));

  const unknownSkus = [];
  const invalidQty = [];
  const items = [];
  let total = 0;

  for (const raw of rawItems) {
    const sku = String(raw.sku || '');
    const qty = Number(raw.qty);
    const mode = raw.mode === 'carton' ? 'carton' : 'unit';

    const row = productBySku.get(sku);
    if (!row) { unknownSkus.push(sku); continue; }
    if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY) { invalidQty.push(sku); continue; }

    const baseProduct = {
      price: row.price !== null ? Number(row.price) : null,
      ctnPrice: row.ctn_price !== null ? Number(row.ctn_price) : null,
      ctnQty: row.ctn_qty || null,
      tbd: row.tbd,
    };

    if (row.tbd) {
      items.push({
        sku, nameKo: row.name_ko, nameEn: row.name_en, qty, mode,
        unitPrice: null, lineTotal: null, tbd: true,
      });
      continue;
    }

    const priced = applyTierPricing(baseProduct, tier);
    const unitPrice = mode === 'carton' ? priced.ctnPrice : priced.price;
    if (unitPrice === null || unitPrice === undefined) { invalidQty.push(sku); continue; }

    const lineTotal = Math.round(unitPrice * qty * 100) / 100;
    total += lineTotal;
    items.push({
      sku, nameKo: row.name_ko, nameEn: row.name_en, qty, mode,
      unitPrice, lineTotal, tbd: false,
    });
  }

  if (unknownSkus.length) {
    return { error: 'UNKNOWN_SKU', message: `Unknown product(s): ${unknownSkus.join(', ')}. 알 수 없는 상품이 있습니다.`, detail: unknownSkus };
  }
  if (invalidQty.length) {
    return { error: 'INVALID_QTY', message: `Invalid quantity for: ${invalidQty.join(', ')}. 수량이 올바르지 않습니다.`, detail: invalidQty };
  }

  return { items, total: Math.round(total * 100) / 100 };
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const user = await getUserFromToken(getBearerToken(req));
    if (!user) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Login required. 로그인이 필요합니다.' });
    const { rows } = await db.query(
      `SELECT id, invoice_number, customer_name, address, rep_name, delivery_method, payment_method, items, total, order_text, created_at
       FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [user.id]
    );
    return res.json({ orders: rows });
  }

  if (req.method === 'PATCH') {
    // 프론트가 서버 응답(가격/합계)을 받아 영수증 텍스트를 만든 뒤, 그 텍스트만
    // 여기로 붙여넣습니다. 가격/합계/아이템은 이 경로로 절대 수정할 수 없습니다.
    const user = await getUserFromToken(getBearerToken(req));
    if (!user) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Login required. 로그인이 필요합니다.' });
    const { id, orderText } = req.body;
    if (!id || typeof orderText !== 'string') return res.status(400).json({ error: 'INVALID_BODY' });
    const { rows } = await db.query(
      `UPDATE orders SET order_text = $1 WHERE id = $2 AND user_id = $3 RETURNING id`,
      [orderText, id, user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });
    return res.status(204).end();
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // 인보이스 번호 발급도 로그인 + 승인된 고객만 가능합니다 (예전엔 익명으로도
    // 번호 카운터를 소모할 수 있었던 구멍을 막았습니다 — audit S06).
    const user = await getUserFromToken(getBearerToken(req));
    if (!user) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Login required. 로그인이 필요합니다.' });
    if (!user.approved) return res.status(403).json({ error: 'NOT_APPROVED', message: 'Your account is not approved yet. 계정이 아직 승인되지 않았습니다.' });

    if (req.query.action === 'reserve') {
      const invoiceNumber = await nextInvoiceNumber();
      return res.status(200).json({ invoiceNumber });
    }

    const {
      customerName, address, repName,
      deliveryMethod, paymentMethod, items: rawItems, invoiceNumber,
    } = req.body;

    const priced = await repriceItems(rawItems, user.tier || DEFAULT_TIER);
    if (priced.error) return res.status(400).json(priced);

    const finalInvoiceNumber = invoiceNumber || (await nextInvoiceNumber());

    const { rows } = await db.query(
      `INSERT INTO orders (user_id, phone, customer_name, address, rep_name, delivery_method, payment_method, items, total, order_text, invoice_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, invoice_number, items, total, created_at`,
      [
        user.id,
        user.phone,
        customerName || null,
        address || null,
        repName || null,
        deliveryMethod || null,
        paymentMethod || null,
        JSON.stringify(priced.items),
        priced.total,
        null,
        finalInvoiceNumber,
      ]
    );

    return res.status(201).json({ order: rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
};
