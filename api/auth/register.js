// api/auth/register.js
const bcrypt = require('bcryptjs');
const db = require('../../lib/db');
const { sendSms, toE164US } = require('../../lib/sms');
const { signupDecision, cleanRestaurantName, isCompleteAddress } = require('../../lib/signupRules');
const crypto = require('crypto');
const { checkRestaurant, searchRestaurants, signPlace, verifyPlaceToken } = require('../../lib/restaurantCheck');

const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

const TIER_LABEL = { tier1: '플래티늄 Platinum', tier2: '골드 Gold', tier3: '실버 Silver' };
const ERP_PATH = 'ERP → 📄 인보이스 → 🛒 Site Order 회원·매출 관리';

function signupHeadline(d) {
  return d.approved ? `신규 회원가입 · 자동 승인 (${TIER_LABEL[d.tier]})` : '신규 회원가입 승인 요청';
}
function tierReason(d) {
  switch (d.reason) {
    case 'restaurant_selected': return ' (가입 즉시 자동 승인 — 고객이 구글 지도 검색에서 식당을 고름)';
    case 'restaurant_verified': return ' (가입 즉시 자동 승인 — 구글 지도에서 실제 식당 확인됨)';
    case 'restaurant_unverified': return ' (가입 즉시 자동 승인 — 레스토랑이 확인되지 않아 골드. 확인되면 플래티늄으로 올려주세요)';
    case 'address': return ' (가입 즉시 자동 승인 — 주소 입력)';
    case 'restaurant_no_address': return ' (승인 대기 — 레스토랑 이름은 있으나 주소가 없어 확인 못 함)';
    case 'incomplete_address': return ' (승인 대기 — 주소가 불완전함)';
    default: return ' (승인 대기 — 레스토랑 이름·주소 없음)';
  }
}
// 관리자 알림용 구글 확인 결과 한 줄
function checkLine(c) {
  if (!c) return '';
  const dup = c.dup ? ' · ⚠️ 같은 식당으로 가입한 다른 계정이 있음' : '';
  if (c.status === 'selected') return `✅ 구글 지도 검색에서 고른 식당 — ${c.match.name} (${c.match.type}) · ${c.match.address}${dup}`;
  if (c.status === 'verified') return `✅ 실제 식당 확인됨 — ${c.match.name} (${c.match.type}) · ${c.match.address}${dup}`;
  if (c.status === 'not_found') {
    const why = { not_food: '식당이 아님', not_operational: '영업 중 아님', address_differs: '주소 다름', name_differs: '이름 다름', already_used: '이미 다른 계정이 이 식당으로 가입함' };
    return c.nearest ? `❌ 확인 안 됨 — 가장 가까운 결과: ${c.nearest.name} · ${c.nearest.address} (${why[c.nearest.why] || c.nearest.why})` : '❌ 확인 안 됨 — 구글 지도에 맞는 식당 없음';
  }
  if (c.status === 'error') return `⚠️ 확인 실패 — 구글 응답 문제 (${c.error})`;
  if (c.status === 'no_address') return '— 주소가 없어 확인 못 함';
  if (c.status === 'limit') return '⚠️ 오늘 구글 확인 한도(비용 안전장치)를 넘어 확인하지 않음 — 담당자가 확인해 주세요';
  return '— 구글 확인 꺼짐 (키 없음)';
}

async function notifyAdminOfNewRegistration({ phone, email, companyName, address, repName, decision, check }) {
  const { EMAILJS_SERVICE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY, EMAILJS_TEMPLATE_ID, ADMIN_NOTIFY_EMAIL } = process.env;

  if (!EMAILJS_SERVICE_ID || !EMAILJS_PUBLIC_KEY || !EMAILJS_PRIVATE_KEY || !EMAILJS_TEMPLATE_ID) {
    console.warn('[notifyAdmin] EmailJS env vars not fully set — skipping registration notification email.');
    return;
  }

  const d = decision;
  const message =
    `===== ${signupHeadline(d)} =====\n\n` +
    `휴대폰번호 : ${phone}\n` +
    `이메일     : ${email || '—'}\n` +
    `상호명     : ${companyName || '—'}\n` +
    `레스토랑 이름 : ${d.restaurantName || '—'}\n` +
    (d.restaurantName ? `구글 확인   : ${checkLine(check)}\n` : '') +
    `배송주소   : ${address || '—'}\n` +
    `담당 영업사원 : ${repName || '—'}\n` +
    `등급       : ${TIER_LABEL[d.tier]}${tierReason(d)}\n\n` +
    (d.approved
      ? `등급이 맞지 않으면 ${ERP_PATH}에서 바꿔주세요.`
      : `${ERP_PATH}에서 승인해주세요.`);

  try {
    const res = await fetchFn('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        accessToken: EMAILJS_PRIVATE_KEY,
        template_params: {
          rep_name: repName || '시스템',
          customer_name: `[${d.approved ? '회원가입 자동승인 ' + TIER_LABEL[d.tier] : '회원가입 승인요청'}] ${phone}${repName ? ' · 담당: ' + repName : ''}`,
          order_total: '0.00',
          date: new Date().toLocaleString('ko-KR'),
          message,
          to_email: ADMIN_NOTIFY_EMAIL || 'info@tronicholdings.com',
        },
      }),
    });
    const text = await res.text();
    console.log('[notifyAdmin] EmailJS response status:', res.status, '| body:', text);
  } catch (e) {
    console.error('[notifyAdmin] Failed to send registration notification email:', e.message, e.stack);
  }
}

async function notifySmsOfNewRegistration({ phone, companyName, repName, decision, check }) {
  const adminPhone = toE164US(process.env.ADMIN_PHONE_NUMBER);
  if (!adminPhone) {
    console.warn('[notifySms] ADMIN_PHONE_NUMBER not set — skipping SMS.');
    return;
  }
  const d = decision;
  const body =
    (d.approved
      ? `[Premium K] New registration auto-approved 신규 가입 자동승인: ${TIER_LABEL[d.tier]}\n`
      : `[Premium K] New registration awaiting approval 신규 회원가입 승인요청\n`) +
    `Phone 전화번호: ${phone}\n` +
    `Company 상호명: ${companyName || '—'}\n` +
    `Restaurant 레스토랑: ${d.restaurantName || '—'}\n` +
    (d.restaurantName ? `구글 확인: ${checkLine(check).slice(0, 120)}\n` : '') +
    `Sales Rep 담당영업사원: ${repName || '—'}\n` +
    (d.approved ? `등급 변경: ${ERP_PATH}` : `승인: ${ERP_PATH}`);
  await sendSms({ to: adminPhone, body });
}

// 구글 호출 하루 한도 (기본 150건 → 한 달 최대 약 4,500건, 무료 5,000건 안쪽). 레스토랑 검색 + 가입 때 자동 확인을 합쳐서 센다.
// 넘으면 그날은 검색을 막고(이름·주소로 가입 → 골드, 담당자 확인) 자동 확인도 하지 않는다.
function dailyLimit() {
  const n = parseInt(process.env.GOOGLE_PLACES_DAILY_LIMIT || '150', 10);
  return Number.isFinite(n) && n >= 0 ? n : 150;
}
async function googleChecksToday() {
  try {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM behavior_events
        WHERE created_at > now() - interval '24 hours'
          AND ((event_type = 'register' AND detail::text ~ '"restaurantCheck": ?\\{[^}]*"status": ?"(verified|not_found|error)"')
            OR (event_type = 'restaurant_search' AND detail::text ~ '"called": ?true'))`);
    return rows[0] ? rows[0].n : 0;
  } catch (e) {
    console.error('[register] googleChecksToday failed:', e.message);
    return Number.MAX_SAFE_INTEGER;   // 셀 수 없으면 안전하게 구글을 부르지 않음
  }
}
const SEARCH_PER_IP_HOUR = 20;
function ipHash(req) {
  const ip = String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || '').split(',')[0].trim();
  return ip ? crypto.createHash('sha256').update('pk-ip|' + ip).digest('hex').slice(0, 16) : 'unknown';
}

// 가입 화면 "레스토랑 검색" — POST /api/auth/register { action: 'searchRestaurant', query }
async function handleSearch(req, res, body) {
  const query = String(body.query || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const letters = (query.match(/[A-Za-z가-힣\u3040-\u30ff\u4e00-\u9fff]/g) || []).length;
  if (letters < 2) return res.status(400).json({ error: 'INVALID_QUERY', message: 'Please enter your restaurant name. 레스토랑 이름을 넣어주세요.' });
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return res.status(503).json({ error: 'SEARCH_OFF', message: 'Search is not available right now. 지금은 검색을 쓸 수 없습니다.' });
  }
  const ih = ipHash(req);
  const recent = await db.query(
    `SELECT count(*)::int AS n FROM behavior_events WHERE event_type = 'restaurant_search' AND created_at > now() - interval '1 hour' AND detail::text ~ $1`,
    ['"ip": ?"' + ih + '"']);
  if ((recent.rows[0] ? recent.rows[0].n : 0) >= SEARCH_PER_IP_HOUR || await googleChecksToday() >= dailyLimit()) {
    await db.query(`INSERT INTO behavior_events (event_type, detail) VALUES ('restaurant_search', $1)`, [JSON.stringify({ ip: ih, called: false, status: 'limit' })]);
    return res.status(429).json({ error: 'SEARCH_LIMIT', message: 'Search is busy — please try again later, or sign up with your restaurant name and address. 지금은 검색을 쓸 수 없습니다.' });
  }
  const r = await searchRestaurants(query);
  await db.query(`INSERT INTO behavior_events (event_type, detail) VALUES ('restaurant_search', $1)`,
    [JSON.stringify({ ip: ih, called: r.status !== 'off', status: r.status, n: r.results ? r.results.length : 0, error: r.error || null })]);
  if (r.status !== 'ok') return res.status(502).json({ error: 'SEARCH_FAILED', message: 'Search failed — please try again. 검색에 실패했습니다. 다시 시도해주세요.' });
  return res.json({ results: r.results.map((x) => ({ name: x.name, address: x.address, type: x.type, token: signPlace(x) })) });
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    if (body.action === 'searchRestaurant') return await handleSearch(req, res, body);
    const phone = typeof body.phone === 'string' || typeof body.phone === 'number' ? String(body.phone) : '';
    const password = typeof body.password === 'string' || typeof body.password === 'number' ? String(body.password) : '';
    const repName = typeof body.repName === 'string' ? body.repName.trim().slice(0, 60) : '';
    const email = body.email ? String(body.email).trim().slice(0, 200) : '';
    const companyName = body.companyName ? String(body.companyName).trim().slice(0, 120) : '';
    let address = body.address ? String(body.address).trim().slice(0, 300) : '';

    if (!phone || !/^[0-9]{9,15}$/.test(phone.replace(/[^0-9]/g, ''))) {
      return res.status(400).json({ error: 'INVALID_PHONE', message: 'Please enter a valid phone number. 휴대폰 번호를 정확히 입력해주세요.' });
    }
    if (!password || !/^[0-9]{6}$/.test(password)) {
      return res.status(400).json({ error: 'INVALID_PASSWORD', message: 'Password must be 6 digits. 비밀번호는 숫자 6자리로 입력해주세요.' });
    }

    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const existing = await db.query('SELECT id FROM users WHERE phone = $1', [cleanPhone]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'PHONE_EXISTS', message: 'This phone number is already registered. Please log in. 이미 등록된 휴대폰 번호입니다.' });
    }

    // 2026-10-16 — 레스토랑 이름 + 주소 → 구글 지도로 실제 식당 확인 → 플래티늄 / 주소 → 골드 (lib/signupRules.js · lib/restaurantCheck.js)
    // 검색에서 고른 식당이면 (서버가 서명한 표 확인) → 이름·주소는 구글 값으로 채우고 무조건 플래티늄
    const picked = body.restaurantToken ? verifyPlaceToken(body.restaurantToken) : null;
    const rn = cleanRestaurantName(body.restaurantName) || (picked ? cleanRestaurantName(picked.name) : '');
    if (picked && !isCompleteAddress(address)) address = picked.address.slice(0, 300);
    let check = null;
    if (picked) check = { status: 'selected', match: { placeId: picked.placeId, name: picked.name, address: picked.address, type: picked.type } };
    if (rn && !check) {
      if (!process.env.GOOGLE_PLACES_API_KEY) check = { status: 'off' };
      else if (!isCompleteAddress(address)) check = { status: 'no_address' };
      else if (await googleChecksToday() >= dailyLimit()) check = { status: 'limit' };   // 구글 비용 안전장치
      else check = await checkRestaurant(rn, address);
    }
    // 같은 식당(placeId)으로 이미 가입한 계정이 있으면 — 등급은 그대로(플래티늄), 관리자 알림·ERP에 "같은 식당 다른 계정 있음" 표시만
    if (check && (check.status === 'verified' || check.status === 'selected') && check.match && check.match.placeId) {
      const pat = '"placeId": ?"' + String(check.match.placeId).replace(/[^A-Za-z0-9_-]/g, (c) => '\\' + c) + '"';
      const used = await db.query(
        `SELECT 1 FROM behavior_events WHERE event_type = 'register' AND detail::text ~ $1 LIMIT 1`, [pat]);
      if (used.rows.length) check.dup = true;
    }
    const decision = signupDecision({ address, restaurantName: rn, check });
    const storedCompany = companyName || decision.restaurantName;   // 상호명을 비워 두면 레스토랑 이름을 상호명으로

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO users (phone, password_hash, email, company_name, address, rep_name, approved, approved_at, tier)
       VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $7 THEN now() ELSE NULL END, $8) RETURNING id, phone, approved, tier`,
      [cleanPhone, passwordHash, email || null, storedCompany || null, address || null, repName || null, decision.approved, decision.tier]
    );

    await db.query(
      `INSERT INTO behavior_events (user_id, phone, event_type, detail) VALUES ($1,$2,'register',$3)`,
      [rows[0].id, cleanPhone, JSON.stringify({
        email, address, restaurantName: decision.restaurantName || null,
        autoApproved: decision.approved, tier: decision.tier, reason: decision.reason,
        restaurantCheck: check ? {
          status: check.status,
          name: check.match ? check.match.name : (check.nearest ? check.nearest.name : null),
          address: check.match ? check.match.address : (check.nearest ? check.nearest.address : null),
          type: check.match ? check.match.type : (check.nearest ? check.nearest.type : null),
          placeId: check.match ? check.match.placeId : null,
          why: check.nearest ? check.nearest.why : null,
          error: check.error || null,
          dup: !!check.dup,
        } : null,
      })]
    );

    await notifyAdminOfNewRegistration({ phone: cleanPhone, email, companyName: storedCompany, address, repName, decision, check }).catch((e) => {
      console.error('[register] notifyAdminOfNewRegistration threw:', e.message);
    });
    await notifySmsOfNewRegistration({ phone: cleanPhone, companyName: storedCompany, repName, decision, check }).catch((e) => {
      console.error('[register] notifySmsOfNewRegistration threw:', e.message);
    });

    if (decision.approved) {
      const en = decision.tier === 'tier1' ? 'Platinum' : 'Gold';
      const ko = decision.tier === 'tier1' ? '플래티늄' : '골드';
      return res.status(201).json({
        message: `Welcome! Your account is approved as ${en}. Log in to see wholesale prices. 가입이 완료되어 ${ko} 등급으로 바로 승인되었습니다.`,
        approved: true,
        tier: decision.tier,
        restaurantCheck: check ? check.status : null,
      });
    }
    return res.status(201).json({
      message: 'Registration received. Prices will be visible once an admin approves your account. 가입 신청이 접수되었습니다.',
      approved: false,
      tier: decision.tier,
      restaurantCheck: check ? check.status : null,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'An error occurred during registration. 가입 처리 중 오류가 발생했습니다.' });
  }
};
