// lib/db.js
const { Pool } = require('pg');

// sslmode=disable가 명시된 로컬 개발 DB에서만 SSL을 끕니다. Production(Neon/Vercel)의
// POSTGRES_URL에는 그 옵션이 없으므로 기존과 동일하게 SSL을 사용합니다.
const url = process.env.POSTGRES_URL || '';
const pool = new Pool({
  connectionString: url,
  ssl: url.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
});

module.exports = { query: (text, params) => pool.query(text, params), pool };
