const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const PRICE_IDS = {
  // Test mode prices (switch to live when done testing)
  monthly: 'price_1TxaxB1MGxEsTGnjUrEkssq2',
  annual:  'price_1Txaxx1MGxEsTGnjp9llMQu9',
  // Live mode prices (uncomment and swap sk_live_ key when ready)
  // monthly: 'price_1TxZWw1MGxEsTGnjwZWRSE0I',
  // annual:  'price_1TxZWw1MGxEsTGnjrka4QHeP',
};

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', 'https://networth.ink');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { plan, email } = req.body;

  if (!plan || !PRICE_IDS[plan]) {
    return res.status(400).json({ error: 'Invalid plan selected.' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
      subscription_data: {
        trial_period_days: 3,
        trial_settings: {
          end_behavior: { missing_payment_method: 'cancel' },
        },
      },
      customer_email: email || undefined,
      success_url: `https://networth.ink/?payment=success&plan=${plan}`,
      cancel_url:  `https://networth.ink/`,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    return res.status(500).json({ error: 'Failed to create checkout session.' });
  }
};
