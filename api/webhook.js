const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  'https://nydeaqxhaaartktfldwv.supabase.co',
  process.env.SUPABASE_SERVICE_KEY
);

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Price ID → plan name map
const PLAN_MAP = {
  'price_1TxZWw1MGxEsTGnjrka4QHeP': 'annual',
  'price_1TxZWw1MGxEsTGnjwZWRSE0I': 'monthly',
  'price_1TxaxB1MGxEsTGnjUrEkssq2': 'monthly', // test
  'price_1Txaxx1MGxEsTGnjp9llMQu9': 'annual',  // test
};

// Get card fingerprint for a Stripe customer
async function getCardFingerprint(customerId, paymentMethodId) {
  try {
    // Try subscription's default payment method first
    if (paymentMethodId) {
      const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
      if (pm.card?.fingerprint) return pm.card.fingerprint;
    }
    // Fall back to customer's default payment method
    const customer = await stripe.customers.retrieve(customerId, {
      expand: ['invoice_settings.default_payment_method']
    });
    const defaultPm = customer.invoice_settings?.default_payment_method;
    if (defaultPm?.card?.fingerprint) return defaultPm.card.fingerprint;
    // Last resort: list payment methods
    const pms = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
    return pms.data[0]?.card?.fingerprint || null;
  } catch (err) {
    console.error('Error getting fingerprint:', err.message);
    return null;
  }
}

// Find a NetWorth user by Stripe customer ID
async function findUserByCustomer(customerId) {
  const { data } = await sb
    .from('profiles')
    .select('id, subscription')
    .eq('subscription->>stripeCustomerId', customerId);
  return data?.[0] || null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  const sub = event.data.object;

  try {
    switch (event.type) {

      // ── New subscription created ──
      case 'customer.subscription.created': {
        if (sub.status !== 'trialing') break; // Only care about new trials

        const fingerprint = await getCardFingerprint(
          sub.customer,
          sub.default_payment_method
        );

        if (fingerprint) {
          // Check if this card has been used for a trial before
          const { data: existing } = await sb
            .from('trial_fingerprints')
            .select('fingerprint')
            .eq('fingerprint', fingerprint)
            .maybeSingle();

          if (existing) {
            // Card already used — cancel this trial immediately
            console.log(`Trial abuse detected: fingerprint ${fingerprint} already used`);
            await stripe.subscriptions.cancel(sub.id);

            // Mark the user's account as trial_used
            const profile = await findUserByCustomer(sub.customer);
            if (profile) {
              await sb.from('profiles').update({
                subscription: {
                  status: 'trial_used',
                  plan: null,
                  trialEnd: null,
                  stripeCustomerId: sub.customer,
                  stripeSubscriptionId: sub.id,
                }
              }).eq('id', profile.id);
            }
          } else {
            // First time — record this fingerprint
            await sb.from('trial_fingerprints').insert({
              fingerprint,
              customer_id: sub.customer,
            }).onConflict('fingerprint').ignore();
          }
        }
        break;
      }

      // ── Subscription updated (trial → active, plan change, etc.) ──
      case 'customer.subscription.updated': {
        const status = sub.status;
        const plan = sub.items.data[0]?.price?.id;
        const trialEnd = sub.trial_end
          ? new Date(sub.trial_end * 1000).toISOString()
          : null;

        const mappedStatus =
          status === 'active'   ? 'active'   :
          status === 'trialing' ? 'trial'    :
          status === 'past_due' ? 'past_due' : 'canceled';

        const planName = PLAN_MAP[plan] || 'monthly';

        const profile = await findUserByCustomer(sub.customer);
        if (profile) {
          // Don't overwrite a trial_used status with something else
          if (profile.subscription?.status === 'trial_used') break;

          await sb.from('profiles').update({
            subscription: {
              status: mappedStatus,
              plan: planName,
              trialEnd,
              stripeCustomerId: sub.customer,
              stripeSubscriptionId: sub.id,
            }
          }).eq('id', profile.id);
        }
        break;
      }

      // ── Subscription cancelled ──
      case 'customer.subscription.deleted': {
        const profile = await findUserByCustomer(sub.customer);
        if (profile && profile.subscription?.status !== 'trial_used') {
          await sb.from('profiles').update({
            subscription: {
              status: 'canceled',
              plan: null,
              trialEnd: null,
              stripeCustomerId: sub.customer,
              stripeSubscriptionId: sub.id,
            }
          }).eq('id', profile.id);
        }
        break;
      }

      // ── Payment failed ──
      case 'invoice.payment_failed': {
        const profile = await findUserByCustomer(sub.customer);
        if (profile) {
          const existing = profile.subscription || {};
          await sb.from('profiles').update({
            subscription: { ...existing, status: 'past_due' }
          }).eq('id', profile.id);
        }
        break;
      }

      default:
        console.log(`Unhandled event: ${event.type}`);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
};
