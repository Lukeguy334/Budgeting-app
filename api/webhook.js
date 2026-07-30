const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  'https://nydeaqxhaaartktfldwv.supabase.co',
  process.env.SUPABASE_SERVICE_KEY // service role key — bypasses RLS for server-side writes
);

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  const sub = event.data.object;

  try {
    switch (event.type) {

      case 'customer.subscription.updated': {
        // Trial converted to active, plan changed, etc.
        const status = sub.status; // 'active', 'trialing', 'past_due', 'canceled'
        const plan = sub.items.data[0]?.price?.id;
        const trialEnd = sub.trial_end
          ? new Date(sub.trial_end * 1000).toISOString()
          : null;

        const mappedStatus =
          status === 'active' ? 'active' :
          status === 'trialing' ? 'trial' :
          status === 'past_due' ? 'past_due' : 'canceled';

        const planName =
          plan === 'price_1TxZWw1MGxEsTGnjrka4QHeP' ? 'annual' :
          plan === 'price_1TxZWw1MGxEsTGnjwZWRSE0I' ? 'monthly' :
          plan === 'price_1TxaxB1MGxEsTGnjUrEkssq2' ? 'monthly' : // test
          plan === 'price_1Txaxx1MGxEsTGnjp9llMQu9' ? 'annual' : 'monthly'; // test

        // Find user by Stripe customer ID
        const { data: profiles } = await sb
          .from('profiles')
          .select('id')
          .eq('subscription->>stripeCustomerId', sub.customer);

        if (profiles && profiles.length > 0) {
          await sb.from('profiles').update({
            subscription: {
              status: mappedStatus,
              plan: planName,
              trialEnd,
              stripeCustomerId: sub.customer,
              stripeSubscriptionId: sub.id,
            }
          }).eq('id', profiles[0].id);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        // User canceled — subscription ends
        const { data: profiles } = await sb
          .from('profiles')
          .select('id')
          .eq('subscription->>stripeCustomerId', sub.customer);

        if (profiles && profiles.length > 0) {
          await sb.from('profiles').update({
            subscription: {
              status: 'canceled',
              plan: null,
              trialEnd: null,
              stripeCustomerId: sub.customer,
              stripeSubscriptionId: sub.id,
            }
          }).eq('id', profiles[0].id);
        }
        break;
      }

      case 'invoice.payment_failed': {
        // Payment failed — mark as past_due
        const customerId = sub.customer;
        const { data: profiles } = await sb
          .from('profiles')
          .select('id, subscription')
          .eq('subscription->>stripeCustomerId', customerId);

        if (profiles && profiles.length > 0) {
          const existing = profiles[0].subscription || {};
          await sb.from('profiles').update({
            subscription: { ...existing, status: 'past_due' }
          }).eq('id', profiles[0].id);
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
};
