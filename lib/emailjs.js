// lib/emailjs.js
const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

async function sendEmail({ toEmail, label, message }) {
  const { EMAILJS_SERVICE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY, EMAILJS_TEMPLATE_ID } = process.env;

  if (!EMAILJS_SERVICE_ID || !EMAILJS_PUBLIC_KEY || !EMAILJS_PRIVATE_KEY || !EMAILJS_TEMPLATE_ID) {
    console.warn('[emailjs] env vars not fully set — skipping email:', label);
    return { skipped: true };
  }
  if (!toEmail) {
    console.warn('[emailjs] no recipient email — skipping email:', label);
    return { skipped: true };
  }

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
          rep_name: '시스템',
          customer_name: label,
          order_total: '0.00',
          date: new Date().toLocaleString('ko-KR'),
          message,
          to_email: toEmail,
        },
      }),
    });
    const text = await res.text();
    console.log('[emailjs] response status:', res.status, '| body:', text);
    return { ok: res.ok, status: res.status };
  } catch (e) {
    console.error('[emailjs] send failed:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { sendEmail };
