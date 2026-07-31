const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  'https://nydeaqxhaaartktfldwv.supabase.co',
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { userId, subscriptionId, customerId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    let subId = subscriptionId;

    // If we don't have the subscription ID directly, look it up via customer
    if (!subId && customerId) {
      const subs = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 5
      });
      // Find the most recent active or trialing subscription
      const active = subs.data.find(s => s.status === 'active' || s.status === 'trialing');
      if (active) subId = active.id;
    }

    if (!subId) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    // Cancel at period end — user keeps access, won't be charged again
    // For trials this means the trial ends without charging
    const cancelled = await stripe.subscriptions.update(subId, {
      cancel_at_period_end: true
    });

    const cancelAt = cancelled.cancel_at
      ? new Date(cancelled.cancel_at * 1000).toISOString()
      : new Date(cancelled.current_period_end * 1000).toISOString();

    // Update Supabase
    const { data: prof } = await sb
      .from('profiles')
      .select('subscription')
      .eq('id', userId)
      .single();

    const existing = prof?.subscription || {};
    await sb.from('profiles').update({
      subscription: {
        ...existing,
        status: 'canceling',
        cancelAt,
        stripeSubscriptionId: subId
      }
    }).eq('id', userId);

    res.status(200).json({ success: true, cancelAt });

  } catch (err) {
    console.error('Cancel subscription error:', err);
    res.status(500).json({ error: err.message });
  }
};
