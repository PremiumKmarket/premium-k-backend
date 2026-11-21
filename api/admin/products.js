// api/admin/products.js
// v8.11 — ERP "Site Order 관리"에서도 상품을 볼·추가·수정·삭제할 수 있게 함 (lib/adminAuth.js: 서버 간 비밀키 + ERP 사용자 역할).
//   보기 = Site Order 관리자 · ERP C-Level·Director·Sales·Accountant
//   추가·수정·삭제 = Site Order 관리자 · ERP C-Level·Director
//   기본 상품 다시 넣기(seed)는 Site Order 관리자 화면에서만.
//   ERP 경로로 들어온 추가·수정은 값 검사를 더 엄격하게 한다(SKU·이름 길이, 가격 0 이상, 그림은 data:image 또는 https 주소, 600KB 이하).
const db = require('../../lib/db');
const { resolveAdmin } = require('../../lib/adminAuth');

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

// v8.11 — ERP 경로 값 검사. 문제가 있으면 한국어 문장, 없으면 null.
//   isNew=true(추가)면 sku·cat·nameKo 가 있어야 하고, 수정(PATCH)은 보낸 칸만 검사한다.
const IMG_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
function checkErpProduct(p, isNew) {
  if (!p || typeof p !== 'object') return '내용이 없습니다.';
  const text = (v, max) => v === undefined || v === null || (typeof v === 'string' && v.trim().length > 0 && v.length <= max);
  if (isNew && !/^[A-Za-z0-9][A-Za-z0-9 ._\-/]{0,59}$/.test(String(p.sku || '').trim())) return 'SKU 형식이 올바르지 않습니다.';
  if (!isNew && p.sku !== undefined && p.sku !== null && !/^[A-Za-z0-9][A-Za-z0-9 ._\-/]{0,59}$/.test(String(p.sku).trim())) return 'SKU 형식이 올바르지 않습니다.';
  if (!text(p.cat, 60)) return '카테고리는 60자 이내여야 합니다.';
  if (!text(p.nameKo, 300) || !text(p.nameEn, 300)) return '상품명은 300자 이내여야 합니다.';
  if (p.spec !== undefined && p.spec !== null && String(p.spec).length > 120) return '규격은 120자 이내여야 합니다.';
  for (const [k, label] of [['price', '낱개 가격'], ['ctnPrice', '박스 가격']]) {
    if (p[k] === undefined || p[k] === null) continue;
    const n = Number(p[k]);
    if (!Number.isFinite(n) || n < 0 || n > 100000) return `${label}이 올바르지 않습니다.`;
  }
  if (p.ctnQty !== undefined && p.ctnQty !== null && !(Number.isInteger(Number(p.ctnQty)) && Number(p.ctnQty) > 0 && Number(p.ctnQty) <= 10000)) return '박스 입수가 올바르지 않습니다.';
  if (p.img !== undefined && p.img !== null) {
    const img = String(p.img);
    if (img.length > 600 * 1024) return '그림이 너무 큽니다 (600KB 이하).';
    if (!IMG_RE.test(img) && !/^https:\/\/[^\s<>"']+$/.test(img)) return '그림은 data:image(jpeg·png·webp) 또는 https 주소여야 합니다.';
  }
  if (p.url !== undefined && p.url !== null && p.url !== '' && !/^https:\/\/[^\s<>"']+$/.test(String(p.url))) return '링크는 https 주소여야 합니다.';
  if (p.tbd !== undefined && p.tbd !== null && typeof p.tbd !== 'boolean') return '가격 문의(tbd) 값이 올바르지 않습니다.';
  return null;
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const admin = await resolveAdmin(req);
  if (!admin) return res.status(403).json({ error: 'FORBIDDEN', message: 'Admins only. 관리자만 접근할 수 있습니다.' });
  if (req.method !== 'GET' && req.method !== 'OPTIONS' && !admin.canManage) {
    return res.status(403).json({ error: 'FORBIDDEN', message: '상품을 바꿀 권한이 없습니다 (C-Level·Director만).' });
  }

  try {
    if (req.method === 'GET' && req.query.action === 'seed') {
      if (admin.via !== 'site') return res.status(403).json({ error: 'FORBIDDEN', message: 'Site Order 관리자 화면에서만 할 수 있습니다.' });
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
      const p = req.body || {};
      if (!p.sku || !p.cat || !p.nameKo) {
        return res.status(400).json({ error: 'MISSING_FIELDS', message: 'SKU, category, and Korean name are required. SKU, 카테고리, 한글명은 필수입니다.' });
      }
      if (admin.via === 'erp') {
        const bad = checkErpProduct(p, true);
        if (bad) return res.status(400).json({ error: 'INVALID_FIELDS', message: bad });
      }
      const dup = await db.query('SELECT id FROM products WHERE sku = $1 LIMIT 1', [String(p.sku).trim()]);
      if (dup.rows[0]) return res.status(409).json({ error: 'DUPLICATE_SKU', message: `이미 사이트에 있는 SKU입니다: ${p.sku}`, id: dup.rows[0].id });
      const { rows } = await db.query(
        `INSERT INTO products (sku, cat, name_ko, name_en, price, ctn_price, ctn_qty, img, url, spec, tbd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          String(p.sku).trim(), p.cat, p.nameKo, p.nameEn || null, p.price || 0,
          p.ctnPrice || null, p.ctnQty || null, p.img || null, p.url || null,
          p.spec || null, !!p.tbd,
        ]
      );
      console.log(`[admin products] add ${rows[0].sku} #${rows[0].id} via ${admin.via}${admin.erpUserId ? ' erp user ' + admin.erpUserId : ''}`);
      return res.status(201).json({ product: rowToProduct(rows[0]) });
    }

    if (req.method === 'PATCH') {
      const { id, sku, cat, nameKo, nameEn, price, ctnPrice, ctnQty, img, url, spec, tbd } = req.body || {};
      if (!id) return res.status(400).json({ error: 'MISSING_ID' });
      if (admin.via === 'erp') {
        const bad = checkErpProduct(req.body, false);
        if (bad) return res.status(400).json({ error: 'INVALID_FIELDS', message: bad });
      }
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
      console.log(`[admin products] edit ${rows[0].sku} #${rows[0].id} via ${admin.via}${admin.erpUserId ? ' erp user ' + admin.erpUserId : ''}`);
      return res.json({ product: rowToProduct(rows[0]) });
    }

    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'MISSING_ID' });
      const del = await db.query('DELETE FROM products WHERE id = $1 RETURNING sku', [id]);
      if (del.rows[0]) console.log(`[admin products] delete ${del.rows[0].sku} #${id} via ${admin.via}${admin.erpUserId ? ' erp user ' + admin.erpUserId : ''}`);
      return res.status(204).end();
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    if (err && err.code === '23505') return res.status(409).json({ error: 'DUPLICATE_SKU', message: '이미 사이트에 있는 SKU입니다.' });
    console.error(err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
};
