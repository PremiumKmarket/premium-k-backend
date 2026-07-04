// lib/auth.js
const crypto = require('crypto');
const db = require('./db');

const SESSION_DAYS = 30;

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function createSession(userId) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)', [token, userId, expiresAt]);
  return token;
}

/** Returns the user row for a valid, unexpired session token, or null. */
async function getUserFromToken(token) {
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token]
  );
  return rows[0] || null;
}

function getBearerToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : (req.body && req.body.token) || (req.query && req.query.token) || null;
}

module.exports = { createSession, getUserFromToken, getBearerToken };
