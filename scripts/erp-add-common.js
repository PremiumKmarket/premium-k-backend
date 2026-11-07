// scripts/erp-add-common.js — ERP 상품 추가 실행기·되돌리기가 함께 쓰는 도구 (Site Order v8.8)
const fs = require('fs');

// .env 읽기 — 이미 있는 환경변수는 덮어쓰지 않는다. 값은 화면에 찍지 않는다.
function loadEnv(file) {
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return true;
}

// 오류 문장에 비밀값이 섞여 나오지 않게 지운다
function hide(msg) {
  let s = String(msg || '');
  const secrets = [process.env.POSTGRES_URL, process.env.PREMIUM_K_SERVER_SECRET];
  try { const u = new URL(process.env.POSTGRES_URL || ''); if (u.password) secrets.push(u.password, decodeURIComponent(u.password)); } catch { /* 무시 */ }
  for (const v of secrets) if (v && v.length >= 4) s = s.split(v).join('***');
  return s.replace(/postgres(ql)?:\/\/[^\s'"]+/gi, 'postgres://***');
}

// 엑셀이 수식으로 읽지 않게(= + - @ 로 시작하는 칸 앞에 ')
const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
const writeCsv = (file, head, rows) =>
  fs.writeFileSync(file, '﻿' + [head.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n'));

const stamp = () => { const d = new Date(), z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`; };

// PC가 중간에 끊겨도(와이파이·절전) DB가 60초 뒤 이 연결의 트랜잭션을 정리하게 — 잠금이 계속 남지 않게
async function sessionGuards(client) {
  await client.query(`SET idle_in_transaction_session_timeout = '60s'`);
  await client.query(`SET lock_timeout = '10s'`);
  await client.query(`SET statement_timeout = '60s'`);
}

module.exports = { loadEnv, hide, csvCell, writeCsv, stamp, sessionGuards };
