// api/auth/request-approval.js
// POST { phone } — no login required (this is called from the login screen
// itself, before the customer necessarily knows whether their account has
// been approved yet). Looks up the phone number and, if it belongs to an
// unapproved account, sends the admin an email + SMS reminder to approve it.
// Always returns a generic success-shaped message so this endpoint can't be
// used to enumerate which phone numbers are registered.

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
    if (!cleanPhone) {
      return res.status(400).json({ error: 'MISSING_PHONE', message: 'Please enter your phone number. 휴대폰 번호를 입력해주세요.' });
    }

    const { rows } = await db.query('SELECT id, phone, company_name, approved, created_at FROM users WHERE phone = $1', [cleanPhone]);
    const user = rows[0];

    if (user && !user.approved) {
      const adminEmailMsg =
        `고객이 회원가입 승인을 재요청했습니다.\n\n` +
        `휴대폰번호   : ${user.phone}\n` +
        `상호명       : ${user.company_name || '—'}\n` +
        `가입일       : ${new Date(user.created_at).toLocaleDateString('ko-KR')}\n\n` +
        `admin.html 회원목록에서 승인해주세요.`;

      await sendEmail({
        toEmail: process.env.ADMIN_NOTIFY_EMAIL || 'info@tronicholdings.com',
        label: `[승인 재요청] ${user.phone}`,
        message: adminEmailMsg,
      }).catch((e) => console.error('[request-approval] admin email failed:', e.message));

      const adminPhone = toE164US(process.env.ADMIN_PHONE_NUMBER);
      if (adminPhone) {
        await sendSms({
          to: adminPhone,
          body:
            `[Premium K] Approval requested again 승인 재요청\n` +
            `Phone 전화번호: ${user.phone}\n` +
            `Company 상호명: ${user.company_name || '—'}`,
        }).catch((e) => console.error('[request-approval] admin SMS failed:', e.message));
      }
    }
    // user가 이미 승인된 경우나, 존재하지 않는 번호인 경우에도 일부러 똑같은 메시지를
    // 돌려줍니다 (등록 여부를 외부에서 추측할 수 없게 하기 위함).

    return res.json({
      message: 'If your account is pending approval, we\'ve notified the admin to review it. This can take up to 24 hours.\n계정이 승인 대기중이라면 관리자에게 검토 요청이 전달되었습니다. 최대 24시간 정도 소요될 수 있습니다.',
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'An error occurred. 처리 중 오류가 발생했습니다.' });
  }
};
