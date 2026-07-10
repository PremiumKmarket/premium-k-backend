// lib/sms.js
const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

async function sendSms({ to, body }) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = process.env;

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    console.warn('[sms] Twilio env vars not fully set — skipping SMS to', to);
    return { skipped: true };
  }
  if (!to) {
    console.warn('[sms] no recipient phone — skipping SMS');
    return { skipped: true };
  }

  try {
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const params = new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER, Body: body });

    const res = await fetchFn(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      }
    );
    const text = await res.text();
    console.log('[sms] response status:', res.status, '| body:', text);
    return { ok: res.ok, status: res.status };
  } catch (e) {
    console.error('[sms] send failed:', e.message);
    return { ok: false, error: e.message };
  }
}

function toE164US(phone) {
  const digits = (phone || '').replace(/[^0-9]/g, '');
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

module.exports = { sendSms, toE164US };
