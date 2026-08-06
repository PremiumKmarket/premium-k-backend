// api/auth/reset.js
// POST { phone, action: 'request' } — customer forgot their password.
//   We email + text the ADMIN that phone number. Admin opens admin.html,
//   finds that phone number, and sets a new password directly there.
// POST { phone, action: 'request-approval' } — customer's account isn't
//   approved yet (or they think it might not be). We email + text the
//   ADMIN a reminder to review/approve that account.
// Both actions return the same generic message shape regardless of whether
// the phone number is actually registered, so this endpoint can't be used
// to check which numbers are registered.
//
// NOTE: these two actions live in one file (instead of two separate API
// routes) to stay under Vercel's 12-function cap on the Hobby plan — see
// api/account.js for the same pattern.

const db = require('../../lib/db');
const { sendEmail } = require('../../lib/emailjs');
const { sendSms, toE164US } = require('../../lib/sms');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const cleanPhone = (req.body.phone || '').replace(/[^0-9]/g, '');
    const action = req.body.action === 'request-approval' ? 'request-approval' : 'request';

    if (!cleanPhone) {
      return res.status(400).json({
        error: 'INVALID_PHONE',
        message: '휴대폰 번호를 입력해주세요. Please enter your phone number.',
      });
    }

    const adminEmail = process.env.ADMIN_NOTIFY_EMAIL || 'info@tronicholdings.com';
    const adminPhone = toE164US(process.env.ADMIN_PHONE_NUMBER);

    const { rows } = await db.query(
      'SELECT id, email, company_name, approved, created_at FROM users WHERE phone = $1',
      [cleanPhone]
    );
    const user = rows[0];

    if (action === 'request-approval') {
      // 계정이 존재하고 아직 승인 전일 때만 관리자에게 알립니다.
      if (user && !user.approved) {
        await sendEmail({
          toEmail: adminEmail,
          label: `[승인 재요청] ${cleanPhone}`,
          message:
            `고객이 회원가입 승인을 재요청했습니다.\n\n` +
            `휴대폰번호   : ${cleanPhone}\n` +
            `상호명       : ${user.company_name || '—'}\n` +
            `가입일       : ${new Date(user.created_at).toLocaleDateString('ko-KR')}\n\n` +
            `admin.html 회원목록에서 승인해주세요.`,
        }).catch((e) => console.error('[reset:request-approval] admin email failed:', e.message));

        if (adminPhone) {
          await sendSms({
            to: adminPhone,
            body:
              `[Premium K] Approval requested again 승인 재요청\n` +
              `Phone 전화번호: ${cleanPhone}\n` +
              `Company 상호명: ${user.company_name || '—'}`,
          }).catch((e) => console.error('[reset:request-approval] admin SMS failed:', e.message));
        }
      }

      return res.json({
        message:
          '계정이 승인 대기중이라면 관리자에게 검토 요청이 전달되었습니다. 최대 24시간 정도 소요될 수 있습니다.\n' +
          'If your account is pending approval, we\'ve notified the admin to review it. This can take up to 24 hours.',
      });
    }

    // action === 'request' (비밀번호 재설정 요청) — 관리자에게 알림 (고객 본인 이메일이 아님)
    if (user) {
      await sendEmail({
        toEmail: adminEmail,
        label: `[비밀번호 재설정 요청] ${cleanPhone}`,
        message:
          `고객이 비밀번호 재설정을 요청했습니다.\n\n` +
          `휴대폰번호 : ${cleanPhone}\n` +
          `상호명     : ${user.company_name || '—'}\n` +
          `등록된 이메일 : ${user.email || '—'}\n\n` +
          `관리자 페이지(admin.html)에서 이 번호를 찾아 새 비밀번호를 직접 입력해서 재설정해주세요.\n` +
          `설정 후 고객에게 새 비밀번호를 전화/문자로 알려주세요.`,
      }).catch((e) => console.error('[reset:request] admin email failed:', e.message));

      if (adminPhone) {
        await sendSms({
          to: adminPhone,
          body:
            `[Premium K] Password reset requested 비밀번호 재설정 요청\n` +
            `Phone 전화번호: ${cleanPhone}\n` +
            `Company 상호명: ${user.company_name || '—'}`,
        }).catch((e) => console.error('[reset:request] admin SMS failed:', e.message));
      }
    }

    return res.json({
      message:
        '요청이 관리자에게 전달되었습니다. 빠른 시일 내에 비밀번호를 재설정하고 안내드리겠습니다.\n' +
        'Your request has been sent to the administrator. We will reset your password and notify you shortly.',
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: 'SERVER_ERROR',
      message: '처리 중 오류가 발생했습니다. An error occurred. Please try again.',
    });
  }
};
