// api/auth/reset.js
// Customer taps "비밀번호를 잊으셨나요?" → enters the phone number they want
// reset → we email the ADMIN that phone number. The admin then opens
// admin.html, finds that phone number, and sets a new password directly —
// no reset link/token needed. Simpler for everyone: the customer doesn't
// need email access at all, and the admin can just call/text them the
// new password.

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
      return res.status(400).json({
        error: 'INVALID_PHONE',
        message: 'Please enter your phone number. 휴대폰 번호를 입력해주세요.',
      });
    }

    const successMsg =
      'Your request has been sent to the administrator. We will reset your password and notify you shortly.\n' +
      '요청이 관리자에게 전달되었습니다. 빠른 시일 내에 비밀번호를 재설정하고 안내드리겠습니다.';

    const { rows } = await db.query('SELECT id, email, company_name FROM users WHERE phone = $1', [cleanPhone]);
    const user = rows[0];

    // 등록되지 않은 번호여도 같은 응답을 줍니다 (등록 여부를 외부에서 추측 못 하도록).
    if (user) {
      const adminEmailMsg =
        `고객이 비밀번호 재설정을 요청했습니다.\n\n` +
        `휴대폰번호 : ${cleanPhone}\n` +
        `상호명     : ${user.company_name || '—'}\n` +
        `등록된 이메일 : ${user.email || '—'}\n\n` +
        `관리자 페이지(admin.html)에서 이 번호를 찾아 새 비밀번호를 직접 입력해서 재설정해주세요.\n` +
        `설정 후 고객에게 새 비밀번호를 전화/문자로 알려주세요.`;

      await sendEmail({
        toEmail: process.env.ADMIN_NOTIFY_EMAIL || 'info@tronicholdings.com',
        label: `[비밀번호 재설정 요청] ${cleanPhone}`,
        message: adminEmailMsg,
      }).catch((e) => console.error('[reset] admin email failed:', e.message));

      const adminPhone = toE164US(process.env.ADMIN_PHONE_NUMBER);
      if (adminPhone) {
        await sendSms({
          to: adminPhone,
          body:
            `[Premium K] Password reset requested 비밀번호 재설정 요청\n` +
            `Phone 전화번호: ${cleanPhone}\n` +
            `Company 상호명: ${user.company_name || '—'}\n` +
            `Reset at: https://premium-k-backend.vercel.app/admin.html`,
        }).catch((e) => console.error('[reset] admin SMS failed:', e.message));
      }
    }

    return res.json({ message: successMsg });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: 'SERVER_ERROR',
      message: 'An error occurred. Please try again. 처리 중 오류가 발생했습니다.',
    });
  }
};
