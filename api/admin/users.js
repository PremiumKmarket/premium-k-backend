// api/admin/users.js
// GET    -> list all users (pending first) — requires an admin session
// POST   -> { userId, approved: true|false } — approve or revoke a user
//        -> { userId, newPassword: '123456' } — admin directly sets a new
//           password for that user (used for the "forgot password" flow —
//           see api/auth/reset.js, which just emails the admin the phone
//           number; the admin resets it here and tells the customer)
//        -> { action:'createStaff', name, phone } — 직원 계정 새로 만들기
//        -> { userId, makeStaff: true|false } — 기존 계정 직원 지정/해제
//        -> { action:'erpStaffSync', expected, includeDeactivate } — ERP 직원 명단 반영
// GET ?action=erpStaffPreview — ERP 직원 명단과 맞춰 본 미리보기 (변경 없음)
// DELETE -> { userId } — permanently delete a user account
//
// v2.5 — ERP "Site Order 관리" 메뉴에서도 같은 API를 쓴다 (lib/adminAuth.js: 서버 간 비밀키 + ERP 사용자 역할).
// ERP 역할: 보기 = C-Level·Director·Sales·Accountant / 바꾸기 = C-Level·Director / 관리자 지정 = C-Level

const bcrypt = require('bcryptjs');
const db = require('../../lib/db');
const { resolveAdmin } = require('../../lib/adminAuth');
const { sendSms, toE164US } = require('../../lib/sms');
const { normalizeTier, DEFAULT_TIER } = require('../../lib/pricing');
const { fetchRoster, computePlan, loadUsersForPlan, normPhone, savePhoneToErp } = require('../../lib/erpStaff');
const { computeSyncPlan, syncBatch, brief } = require('../../lib/erpOrders');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

const NO_MANAGE = { error: 'FORBIDDEN_ROLE', message: '회원 승인·등급·직원 변경은 C-Level·Director만 할 수 있습니다.' };

module.exports = async (req, res) => {
  try {
    return await handler(req, res);
  } catch (e) {
    console.error('[admin/users]', e.message);
    if (!res.headersSent) return res.status(500).json({ error: 'SERVER_ERROR', message: '처리 중 오류가 발생했습니다.' });
  }
};

async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const admin = await resolveAdmin(req);
  if (!admin) return res.status(403).json({ error: 'FORBIDDEN', message: '관리자만 접근할 수 있습니다.' });
  // 바꾸는 요청(POST·DELETE)과 ERP 직원 명단(이름·번호)은 C-Level·Director(또는 Site Order 관리자)만
  if ((req.method === 'POST' || req.method === 'DELETE' || req.query.action === 'erpStaffPreview' || req.query.action === 'erpOrderSyncPreview') && !admin.canManage) {
    return res.status(403).json(NO_MANAGE);
  }
  // Site Order 관리자 계정(is_admin)은 관리자 지정 권한이 있는 사람(Site Order 관리자·ERP C-Level)만 바꿀 수 있다.
  // (Director가 관리자 비밀번호를 바꿔 그 계정으로 로그인하는 식의 권한 상승을 막음)
  if ((req.method === 'POST' || req.method === 'DELETE') && !admin.canGrantAdmin && req.body && req.body.userId !== undefined && req.body.userId !== null) {
    const { rows: t } = await db.query('SELECT is_admin FROM users WHERE id = $1', [req.body.userId]);
    if (t[0] && t[0].is_admin) {
      return res.status(403).json({ error: 'FORBIDDEN_ADMIN_TARGET', message: 'Site Order 관리자 계정은 C-Level만 바꿀 수 있습니다.' });
    }
  }
  if (admin.via === 'erp' && req.method !== 'GET') {
    const b = req.body || {};
    const what = b.action || (b.newPassword !== undefined ? 'newPassword' : b.isAdmin !== undefined ? 'isAdmin' : b.makeStaff !== undefined ? 'makeStaff'
      : b.approved !== undefined ? 'approved' : b.tier !== undefined ? 'tier' : req.method);
    console.log('[erp-admin]', JSON.stringify({ erpUserId: admin.erpUserId, erpRole: admin.erpRole, what, userId: b.userId || null }));
  }

  // ERP 직원 명단 미리보기 (아무것도 바꾸지 않음)
  if (req.method === 'GET' && req.query.action === 'erpStaffPreview') {
    try {
      const roster = await fetchRoster();
      const result = computePlan(roster.staff, await loadUsersForPlan(db.query));
      return res.json({ ...result, rosterCount: roster.staff.length });
    } catch (e) {
      return res.status(502).json({ error: e.code || 'ERP_ERROR', message: e.message });
    }
  }

  // Site Order 주문 → ERP 신규주문알림: ERP에 아직 없는 주문 미리보기 (아무것도 바꾸지 않음)
  if (req.method === 'GET' && req.query.action === 'erpOrderSyncPreview') {
    try {
      const plan = await computeSyncPlan(db.query);
      return res.json({ liveFrom: plan.liveFrom, erpReady: plan.erpReady, counts: plan.counts, missing: plan.missing.slice(0, 100).map(brief) });
    } catch (e) {
      return res.status(502).json({ error: e.code || 'ERP_ERROR', message: e.message });
    }
  }

  if (req.method === 'GET') {
    const { rows } = await db.query(
      `SELECT u.id, u.phone, u.email, u.company_name, u.address, u.rep_name, u.tier, u.approved, u.is_admin, u.created_at, u.approved_at,
              u.is_staff, u.must_change_password,
              la.last_seen, rg.reg_detail
       FROM users u
       LEFT JOIN (
         SELECT phone, max(created_at) AS last_seen FROM behavior_events GROUP BY phone
       ) la ON la.phone = u.phone
       LEFT JOIN (
         SELECT DISTINCT ON (user_id) user_id, detail::text AS reg_detail
         FROM behavior_events WHERE event_type = 'register' AND user_id IS NOT NULL
         ORDER BY user_id, created_at
       ) rg ON rg.user_id::text = u.id::text
       ORDER BY u.approved ASC, u.created_at DESC`
    );
    // 2026-10-16 가입 자동 승인 표시용 — 가입 기록(behavior_events 'register')에서 레스토랑 이름·자동 승인 여부만 꺼냄
    const users = rows.map(({ reg_detail, ...u }) => {
      let d = null;
      try { d = reg_detail ? JSON.parse(reg_detail) : null; } catch { d = null; }
      return {
        ...u,
        signup_restaurant_name: d && typeof d.restaurantName === 'string' && d.restaurantName ? d.restaurantName.slice(0, 120) : null,
        signup_restaurant_check: d && d.restaurantCheck && typeof d.restaurantCheck === 'object' && typeof d.restaurantCheck.status === 'string'
          ? { status: d.restaurantCheck.status, name: d.restaurantCheck.name || null, address: d.restaurantCheck.address || null, why: d.restaurantCheck.why || null, dup: !!d.restaurantCheck.dup }
          : null,
        signup_auto_tier: d && d.autoApproved && ['tier1', 'tier2'].includes(d.tier) ? d.tier : null,
      };
    });
    return res.json({ users });
  }

  if (req.method === 'POST') {
    const { userId, approved, newPassword, tier, isAdmin, action, makeStaff } = req.body;

    // Site Order 주문 → ERP 보내기 (ERP에 없는 것만, 한 번에 최대 10건, 오래된 것부터). 같은 주문은 ERP가 중복 저장하지 않음.
    if (action === 'erpOrderSync') {
      try {
        const r = await syncBatch(db.query, 10, req.body.skip);
        return res.json({ ok: true, ...r });
      } catch (e) {
        return res.status(502).json({ error: e.code || 'ERP_ERROR', message: e.message });
      }
    }

    // 이미 연결된 직원 중 ERP에 번호가 없거나 다른 사람: Site Order 계정 번호를 ERP 직원 정보에 저장 (Site Order 쪽은 바꾸지 않음)
    if (action === 'erpStaffBackfillPhones') {
      let roster;
      try { roster = await fetchRoster(); }
      catch (e) { return res.status(502).json({ error: e.code || 'ERP_ERROR', message: e.message }); }
      const { plan } = computePlan(roster.staff, await loadUsersForPlan(db.query));
      const targets = plan.filter((p) => p.action === 'OK' && p.erpPhoneMissing);
      const results = [];
      for (const t of targets) {
        const r = await savePhoneToErp(t.erpStaffId, t.accountPhone);
        results.push({ name: t.name, ok: r.ok, reason: r.reason || null });
      }
      return res.json({ total: targets.length, saved: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok) });
    }

    // ERP에 휴대폰 번호가 없거나(형식 오류·직원끼리 중복) 건너뛴 직원 1명을, 관리자가 번호를 직접 넣어 처리.
    // ERP 직원 번호로 연결해 두므로 다음 불러오기부터는 "이미 연결됨"으로 나온다. 처리 후 ERP 직원 정보에도 번호를 저장한다.
    if (action === 'erpStaffSetPhone') {
      const erpStaffId = String(req.body.erpStaffId || '');
      let phone = String(req.body.phone || '').replace(/[^0-9]/g, '');
      if (phone.length === 11 && phone[0] === '1') phone = phone.slice(1);
      if (!/^[0-9]{10}$/.test(phone)) return res.status(400).json({ error: 'INVALID_PHONE', message: '휴대폰 번호 10자리를 넣어주세요.' });
      let roster;
      try { roster = await fetchRoster(); }
      catch (e) { return res.status(502).json({ error: e.code || 'ERP_ERROR', message: e.message }); }
      const st = roster.staff.find((x) => String(x.erpStaffId) === erpStaffId);
      if (!st) return res.status(404).json({ error: 'NOT_IN_ROSTER', message: 'ERP 재직 직원 명단에 없는 직원입니다.' });
      const other = roster.staff.find((x) => String(x.erpStaffId) !== erpStaffId && normPhone(x.phone) === phone);
      if (other) return res.status(409).json({ error: 'PHONE_OF_OTHER_STAFF', message: `ERP에서 다른 직원(${String(other.name || '').trim()})의 번호와 같습니다.` });
      const name = String(st.name || '').trim();
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        const linked = await client.query('SELECT id FROM users WHERE erp_staff_id = $1 FOR UPDATE', [erpStaffId]);
        if (linked.rows[0]) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'ALREADY_LINKED', message: '이미 이 ERP 직원과 연결된 계정이 있습니다.' }); }
        const ex = await client.query('SELECT id, is_admin, is_staff, erp_staff_id FROM users WHERE phone = $1 FOR UPDATE', [phone]);
        const u = ex.rows[0];
        let result;
        if (!u) {
          const hash = await bcrypt.hash('000000', 10);
          await client.query(
            `INSERT INTO users (phone, password_hash, company_name, rep_name, approved, approved_at, tier, is_staff, must_change_password, erp_staff_id)
             VALUES ($1, $2, $3, $4, TRUE, now(), 'tier1', TRUE, TRUE, $5)`,
            [phone, hash, 'Premium K Staff · ' + name, name, erpStaffId]);
          result = 'CREATE';
        } else if (u.is_admin) {
          await client.query('ROLLBACK'); return res.status(409).json({ error: 'ADMIN_ACCOUNT', message: '관리자 계정 번호입니다. 회원 상세에서 직접 직원으로 지정해주세요.' });
        } else if (u.erp_staff_id) {
          await client.query('ROLLBACK'); return res.status(409).json({ error: 'OTHER_ERP', message: '다른 ERP 직원과 연결된 번호입니다.' });
        } else {
          await client.query(
            `UPDATE users SET is_staff = TRUE, erp_staff_id = $2, tier = 'tier1', approved = TRUE, approved_at = COALESCE(approved_at, now()),
                    company_name = COALESCE(NULLIF(btrim(company_name), ''), $3), rep_name = COALESCE(NULLIF(btrim(rep_name), ''), $4)
             WHERE id = $1`, [u.id, erpStaffId, 'Premium K Staff · ' + name, name]);
          result = u.is_staff ? 'LINK' : 'CONVERT';
        }
        await client.query('COMMIT');
        // Site Order 계정 처리가 끝난 뒤 ERP 직원 정보에도 같은 번호 저장 (실패해도 계정은 그대로, 안내만)
        const erp = await savePhoneToErp(erpStaffId, phone);
        return res.json({ ok: true, result, phone, erpSaved: erp.ok, erpReason: erp.reason || null });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[erpStaffSetPhone]', e.message);
        return res.status(500).json({ error: 'SERVER_ERROR', message: '처리 중 오류가 나서 취소했습니다.' });
      } finally { client.release(); }
    }

    // ERP 직원 명단 반영. 미리보기에서 본 건수(expected)와 지금 다시 계산한 건수가 하나라도 다르면
    // 아무것도 바꾸지 않고 멈춤 (그 사이 ERP나 회원 정보가 바뀐 경우). 한 트랜잭션으로 전부 반영 또는 전부 취소.
    if (action === 'erpStaffSync') {
      const expected = req.body.expected || {};
      const includeDeactivate = !!req.body.includeDeactivate;
      let roster;
      try { roster = await fetchRoster(); }
      catch (e) { return res.status(502).json({ error: e.code || 'ERP_ERROR', message: e.message }); }
      if (!roster.staff.length) return res.status(409).json({ error: 'EMPTY_ROSTER', message: 'ERP 재직 직원 명단이 비어 있어 반영하지 않았습니다.' });
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
        const { plan, deactivate, counts } = computePlan(roster.staff, await loadUsersForPlan((t, p) => client.query(t, p)));
        const want = { CREATE: counts.CREATE || 0, CONVERT: counts.CONVERT || 0, LINK: counts.LINK || 0, DEACTIVATE: includeDeactivate ? (counts.DEACTIVATE || 0) : 0 };
        for (const k of Object.keys(want)) {
          if (Number(expected[k] || 0) !== want[k]) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'PLAN_CHANGED', message: '미리보기 이후 ERP나 회원 정보가 바뀌었습니다. 다시 불러온 뒤 반영해주세요.', counts });
          }
        }
        const hash000000 = await bcrypt.hash('000000', 10);
        const done = { CREATE: 0, CONVERT: 0, LINK: 0, DEACTIVATE: 0 };
        for (const r of plan) {
          if (r.action === 'CREATE') {
            await client.query(
              `INSERT INTO users (phone, password_hash, company_name, rep_name, approved, approved_at, tier, is_staff, must_change_password, erp_staff_id)
               VALUES ($1, $2, $3, $4, TRUE, now(), 'tier1', TRUE, TRUE, $5)`,
              [r.phone, hash000000, 'Premium K Staff · ' + r.name, r.name, r.erpStaffId]);
            done.CREATE++;
          } else if (r.action === 'CONVERT') {
            const u = await client.query(
              `UPDATE users SET is_staff = TRUE, erp_staff_id = $2, tier = 'tier1', approved = TRUE, approved_at = COALESCE(approved_at, now()),
                      company_name = COALESCE(NULLIF(btrim(company_name), ''), $3), rep_name = COALESCE(NULLIF(btrim(rep_name), ''), $4)
               WHERE id = $1 AND NOT is_admin AND NOT is_staff AND erp_staff_id IS NULL`,
              [r.userId, r.erpStaffId, 'Premium K Staff · ' + r.name, r.name]);
            done.CONVERT += u.rowCount;
          } else if (r.action === 'LINK') {
            const u = await client.query(
              `UPDATE users SET erp_staff_id = $2, tier = 'tier1', approved = TRUE WHERE id = $1 AND is_staff AND erp_staff_id IS NULL`,
              [r.userId, r.erpStaffId]);
            done.LINK += u.rowCount;
          }
        }
        if (includeDeactivate) {
          for (const d of deactivate) {
            const u = await client.query(`UPDATE users SET is_staff = FALSE, must_change_password = FALSE WHERE id = $1 AND is_staff`, [d.userId]);
            done.DEACTIVATE += u.rowCount;
          }
        }
        for (const k of Object.keys(want)) {
          if (done[k] !== want[k]) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'APPLY_MISMATCH', message: '반영 건수가 미리보기와 달라 전부 취소했습니다.', done, want });
          }
        }
        await client.query('COMMIT');
        return res.json({ ok: true, done });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[erpStaffSync]', e.message);
        return res.status(500).json({ error: 'SERVER_ERROR', message: '반영 중 오류가 나서 전부 취소했습니다.' });
      } finally {
        client.release();
      }
    }

    // 직원 계정 새로 만들기 (관리자 화면 "직원 추가") — 휴대폰 번호 로그인, 처음 비밀번호 000000,
    // 첫 로그인 때 본인 비밀번호로 변경 필수, 승인됨·플래티늄·직원 표시. 이미 있는 번호면 만들지 않고 알려줌.
    if (action === 'createStaff') {
      const name = String(req.body.name || '').trim().slice(0, 60);
      let phone = String(req.body.phone || '').replace(/[^0-9]/g, '');
      if (phone.length === 11 && phone[0] === '1') phone = phone.slice(1);
      if (!name) return res.status(400).json({ error: 'MISSING_NAME', message: '직원 이름을 넣어주세요.' });
      if (!/^[0-9]{10}$/.test(phone)) return res.status(400).json({ error: 'INVALID_PHONE', message: '휴대폰 번호 10자리를 넣어주세요.' });
      const { rows: ex } = await db.query('SELECT id, is_staff FROM users WHERE phone = $1', [phone]);
      if (ex[0]) {
        return res.status(409).json({ error: 'PHONE_EXISTS', userId: ex[0].id, isStaff: !!ex[0].is_staff,
          message: ex[0].is_staff ? '이미 직원 계정이 있는 번호입니다.' : '이미 가입된 번호입니다.' });
      }
      const passwordHash = await bcrypt.hash('000000', 10);
      const { rows } = await db.query(
        `INSERT INTO users (phone, password_hash, company_name, rep_name, approved, approved_at, tier, is_staff, must_change_password)
         VALUES ($1, $2, $3, $4, TRUE, now(), 'tier1', TRUE, TRUE)
         RETURNING id, phone, company_name, tier, approved, is_staff, must_change_password`,
        [phone, passwordHash, 'Premium K Staff · ' + name, name]
      );
      return res.status(201).json({ user: rows[0] });
    }

    // 기존 계정을 직원으로 지정/해제. 지정: 직원 표시 + 승인 + 플래티늄 (비밀번호·주문 내역은 그대로).
    // 해제: 직원 표시만 끔 (등급·승인은 그대로 — 필요하면 관리자가 따로 바꿈).
    if (makeStaff !== undefined) {
      const { rows } = makeStaff
        ? await db.query(
            `UPDATE users SET is_staff = TRUE, tier = 'tier1', approved = TRUE, approved_at = COALESCE(approved_at, now()),
                    company_name = COALESCE(NULLIF(btrim(company_name), ''), 'Premium K Staff')
             WHERE id = $1 RETURNING id, phone, is_staff, tier, approved`, [userId])
        : await db.query(
            `UPDATE users SET is_staff = FALSE, must_change_password = FALSE
             WHERE id = $1 RETURNING id, phone, is_staff, tier, approved`, [userId]);
      if (!rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });
      return res.json({ user: rows[0] });
    }

    if (newPassword !== undefined) {
      if (!/^[0-9]{6}$/.test(newPassword)) {
        return res.status(400).json({ error: 'INVALID_PASSWORD', message: '비밀번호는 숫자 6자리여야 합니다.' });
      }
      const passwordHash = await bcrypt.hash(newPassword, 10);
      const { rows } = await db.query(
        // 관리자가 직원 비밀번호를 재설정하면, 그 직원은 다음 로그인 때 다시 본인 비밀번호로 바꾸게 함
        'UPDATE users SET password_hash = $1, must_change_password = (must_change_password OR is_staff) WHERE id = $2 RETURNING id, phone',
        [passwordHash, userId]
      );
      if (!rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });
      // 비밀번호가 바뀌면 기존 로그인 세션은 전부 무효화 (보안)
      await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
      return res.json({ user: rows[0], message: '비밀번호가 재설정되었습니다.' });
    }

    // 관리자 권한 부여/해제. 본인 권한은 실수로 해제해서 잠기는 걸 막기 위해 막아둡니다.
    if (isAdmin !== undefined) {
      if (!admin.canGrantAdmin) return res.status(403).json({ error: 'FORBIDDEN_ROLE', message: 'Site Order 관리자 지정·해제는 C-Level만 할 수 있습니다.' });
      if (admin.id && String(userId) === String(admin.id) && isAdmin === false) {
        return res.status(400).json({ error: 'CANNOT_DEMOTE_SELF', message: '본인의 관리자 권한은 스스로 해제할 수 없습니다.' });
      }
      const { rows } = await db.query(
        'UPDATE users SET is_admin = $1 WHERE id = $2 RETURNING id, phone, is_admin',
        [!!isAdmin, userId]
      );
      if (!rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });
      return res.json({ user: rows[0] });
    }

    // 승인 상태는 그대로 두고 등급(tier)만 바꾸는 경우 (기존 고객 등급 변경)
    if (approved === undefined && tier !== undefined) {
      const t = normalizeTier(tier);
      const { rows } = await db.query(
        'UPDATE users SET tier = $1 WHERE id = $2 RETURNING id, phone, tier',
        [t, userId]
      );
      if (!rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });
      return res.json({ user: rows[0] });
    }

    // 승인 처리. 승인 시 등급을 함께 지정할 수 있으며(기본값 Tier 3),
    // 승인취소(approved:false) 시에는 등급을 건드리지 않습니다.
    const { rows } = approved
      ? await db.query(
          `UPDATE users SET approved = true, approved_at = now(), tier = $1
           WHERE id = $2 RETURNING id, phone, approved, tier`,
          [normalizeTier(tier || DEFAULT_TIER), userId]
        )
      : await db.query(
          `UPDATE users SET approved = false, approved_at = NULL
           WHERE id = $1 RETURNING id, phone, approved, tier`,
          [userId]
        );
    if (!rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });

    if (approved) {
      const customerPhone = toE164US(rows[0].phone);
      const body =
        `[Premium K] Your account has been approved! You can now log in and see wholesale prices.\n` +
        `계정이 승인되었습니다! 이제 로그인하시면 도매가를 확인하실 수 있습니다.`;
      sendSms({ to: customerPhone, body }).catch((e) => console.error('[approve] SMS failed:', e.message));
    }

    return res.json({ user: rows[0] });
  }

  if (req.method === 'DELETE') {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'MISSING_ID' });
    if (admin.id && String(userId) === String(admin.id)) {
      return res.status(400).json({ error: 'CANNOT_DELETE_SELF', message: '본인 계정은 삭제할 수 없습니다.' });
    }
    const { rows } = await db.query('DELETE FROM users WHERE id = $1 RETURNING id', [userId]);
    if (!rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });
    return res.status(204).end();
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
