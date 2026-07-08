// api/admin/products.js
const db = require('../../lib/db');
const { getUserFromToken, getBearerToken } = require('../../lib/auth');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function rowToProduct(r) {
  return {
    id: r.id, sku: r.sku, cat: r.cat, nameKo: r.name_ko, nameEn: r.name_en,
    price: Number(r.price), ctnPrice: r.ctn_price !== null ? Number(r.ctn_price) : null,
    ctnQty: r.ctn_qty, img: r.img, imgPage: r.img_page, url: r.url, spec: r.spec,
    lidOptions: r.lid_options, colorOptions: r.color_options, tbd: r.tbd,
    sortOrder: r.sort_order, updatedAt: r.updated_at,
  };
}

async function seedFromBundledFiles(res) {
  const products = require('../../data/products.json');
  const togoPageImages = require('../../data/togo_page_images.json');

  let inserted = 0, skipped = 0;
  for (const p of products) {
    const { rows } = await db.query(
      `INSERT INTO products (sku, cat, name_ko, name_en, price, ctn_price, ctn_qty, img, img_page, url, spec, lid_options, color_options, tbd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (sku) DO NOTHING RETURNING id`,
      [
        p.sku, p.cat, p.nameKo, p.nameEn || null, p.price || 0,
        p.ctnPrice ?? null, p.ctnQty ?? null, p.img || null, p.imgPage ?? null,
        p.url || null, p.spec || null,
        p.lidOptions ? JSON.stringify(p.lidOptions) : null,
        p.colorOptions ? JSON.stringify(p.colorOptions) : null,
        !!p.tbd,
      ]
    );
    if (rows[0]) inserted++; else skipped++;
  }

  let imgInserted = 0;
  for (const [pageNum, img] of Object.entries(togoPageImages)) {
    const { rows } = await db.query(
      `INSERT INTO togo_page_images (page_number, img) VALUES ($1,$2) ON CONFLICT (page_number) DO NOTHING RETURNING page_number`,
      [Number(pageNum), img]
    );
    if (rows[0]) imgInserted++;
  }

  return res.json({ message: `Seed complete. Products inserted: ${inserted}, already existed: ${skipped}. Page images inserted: ${imgInserted}.` });
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const admin = await getUserFromToken(getBearerToken(req));
  if (!admin || !admin.is_admin) return res.status(403).json({ error: 'FORBIDDEN', message: 'Admins only. 관리자만 접근할 수 있습니다.' });

  try {
    if (req.method === 'GET' && req.query.action === 'seed') {
      return await seedFromBundledFiles(res);
    }

    if (req.method === 'GET') {
      const { cat, search } = req.query;
      let sql = 'SELECT * FROM products WHERE 1=1';
      const params = [];
      if (cat) { params.push(cat); sql += ` AND cat = $${params.length}`; }
      if (search) { params.push(`%${search}%`); sql += ` AND (name_ko ILIKE $${params.length} OR name_en ILIKE $${params.length} OR sku ILIKE $${params.length})`; }
      sql += ' ORDER BY cat, sort_order, name_ko LIMIT 500';
      const [{ rows }, { rows: imgRows }] = await Promise.all([
        db.query(sql, params),
        db.query('SELECT page_number, img FROM togo_page_images'),
      ]);
      const togoPageImages = {};
      imgRows.forEach(r => { togoPageImages[r.page_number] = r.img; });
      return res.json({ products: rows.map(rowToProduct), togoPageImages });
    }

    if (req.method === 'POST') {
      const p = req.body;
      if (!p.sku || !p.cat || !p.nameKo) {
        return res.status(400).json({ error: 'MISSING_FIELDS', message: 'SKU, category, and Korean name are required. SKU, 카테고리, 한글명은 필수입니다.' });
      }
      const { rows } = await db.query(
        `INSERT INTO products (sku, cat, name_ko, name_en, price, ctn_price, ctn_qty, img, url, spec, tbd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          p.sku, p.cat, p.nameKo, p.nameEn || null, p.price || 0,
          p.ctnPrice || null, p.ctnQty || null, p.img || null, p.url || null,
          p.spec || null, !!p.tbd,
        ]
      );
      return res.status(201).json({ product: rowToProduct(rows[0]) });
    }

    if (req.method === 'PATCH') {
      const { id, sku, cat, nameKo, nameEn, price, ctnPrice, ctnQty, img, url, spec, tbd } = req.body;
      if (!id) return res.status(400).json({ error: 'MISSING_ID' });
      const { rows } = await db.query(
        `UPDATE products SET
           sku = COALESCE($1, sku), cat = COALESCE($2, cat), name_ko = COALESCE($3, name_ko),
           name_en = COALESCE($4, name_en), price = COALESCE($5, price),
           ctn_price = COALESCE($6, ctn_price), ctn_qty = COALESCE($7, ctn_qty),
           img = COALESCE($8, img), url = COALESCE($9, url), spec = COALESCE($10, spec),
           tbd = COALESCE($11, tbd), updated_at = now()
         WHERE id = $12 RETURNING *`,
        [sku, cat, nameKo, nameEn, price, ctnPrice, ctnQty, img, url, spec, tbd, id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });
      return res.json({ product: rowToProduct(rows[0]) });
    }

    if (req.method === 'DELETE') {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'MISSING_ID' });
      await db.query('DELETE FROM products WHERE id = $1', [id]);
      return res.status(204).end();
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
};
