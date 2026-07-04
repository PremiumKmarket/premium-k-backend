const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { amount, orderNumber, customerName, customerEmail } = req.body;

    const numericAmount = Number(amount);
    if (!numericAmount || numericAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    if (numericAmount > 20000) {
      return res.status(400).json({ error: 'Amount exceeds safety limit ($20,000). Contact admin.' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: customerEmail || undefined,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Premium K Order${orderNumber ? ' #' + orderNumber : ''}`,
              description: customerName ? `Customer: ${customerName}` : undefined,
            },
            unit_amount: Math.round(numericAmount * 100),
          },
          quantity: 1,
        },
      ],
      success_url: `https://www.premium-k.com/pages/order-paid?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://www.premium-k.com/pages/order-cancelled`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create checkout session', detail: err.message });
  }
};
