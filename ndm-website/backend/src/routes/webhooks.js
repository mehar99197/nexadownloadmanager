'use strict';

const router = require('express').Router();

const asyncHandler = require('../utils/asyncHandler');
const stripe = require('../utils/stripe');
const { sendLicenseEmail } = require('../utils/email');
const { planSeats, planExpiry } = require('../utils/license');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const Payment = require('../models/Payment');
const { generateLicenseKey } = require('../utils/license');
const { withTransaction } = require('../config/db');
const StripeEvent = require('../models/StripeEvent');
const { PLANS } = require('../config/plans');
const LicenseEmailDelivery = require('../models/LicenseEmailDelivery');

async function resolveUser(obj) {
  const meta = obj.metadata || {};
  if (meta.userId) {
    const byId = await User.findById(Number(meta.userId)).catch(() => null);
    if (byId) return byId;
  }
  const email = obj.customer_email || obj.customer_details?.email || obj.email;
  if (email) return User.findByEmail(email);
  return null;
}

function planFromObject(obj) {
  const plan = (obj.metadata || {}).plan || obj.plan;
  if (!plan || !PLANS[plan] || plan === 'free')
    throw new Error('Stripe event is missing a valid paid plan');
  return plan;
}
function cycleFromObject(obj) {
  const c = (obj.metadata || {}).billingCycle || obj.billingCycle;
  return c === 'yearly' ? 'yearly' : 'monthly';
}

async function handleCheckoutCompleted(obj, eventId) {
  const user = await resolveUser(obj);
  if (!user) throw new Error('checkout.session.completed has no matching user');

  const plan = planFromObject(obj);
  const billingCycle = cycleFromObject(obj);

  const amount = typeof obj.amount_total === 'number' ? obj.amount_total / 100
    : typeof obj.amount === 'number' ? obj.amount / 100 : 0;

  const stripePaymentId = obj.payment_intent ? String(obj.payment_intent)
    : obj.id ? String(obj.id) : null;
  const subscription = await withTransaction(async (connection) => {
    const [subs] = await connection.execute(
      'SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
      [user.id]
    );
    let current = subs[0];
    if (!current) {
      const [result] = await connection.execute(
        `INSERT INTO subscriptions
           (user_id, plan, status, license_key, seats, start_date, expiry_date,
            stripe_subscription_id, stripe_customer_id)
         VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
        [user.id, plan, generateLicenseKey(), planSeats(plan), new Date(),
         planExpiry(plan, billingCycle), obj.subscription ? String(obj.subscription) : null,
         obj.customer ? String(obj.customer) : null]
      );
      const [created] = await connection.execute('SELECT * FROM subscriptions WHERE id = ?', [result.insertId]);
      current = created[0];
    } else {
      await connection.execute(
        `UPDATE subscriptions
            SET plan = ?, status = 'active', seats = ?, expiry_date = ?, start_date = ?,
                stripe_subscription_id = ?, stripe_customer_id = ?
          WHERE id = ?`,
        [plan, planSeats(plan), planExpiry(plan, billingCycle), new Date(),
         obj.subscription ? String(obj.subscription) : current.stripe_subscription_id,
         obj.customer ? String(obj.customer) : current.stripe_customer_id, current.id]
      );
      const [updated] = await connection.execute('SELECT * FROM subscriptions WHERE id = ?', [current.id]);
      current = updated[0];
    }

    if (stripePaymentId) {
      await connection.execute(
        `INSERT INTO payments
           (user_id, amount, currency, plan, billing_cycle, stripe_payment_id, status)
         VALUES (?, ?, ?, ?, ?, ?, 'paid')
         ON DUPLICATE KEY UPDATE id = id`,
        [user.id, amount, obj.currency || 'usd', plan, billingCycle, stripePaymentId]
      );
    }
    return current;
  });

  const delivery = await LicenseEmailDelivery.claim(eventId, user.id, subscription.license_key, plan);
  if (delivery === 'sent' || delivery === 'in_progress') return;
  try {
    await sendLicenseEmail(user, subscription.license_key, plan);
    await LicenseEmailDelivery.markSent(eventId);
  } catch (err) {
    await LicenseEmailDelivery.markFailed(eventId, err).catch(() => {});
    throw err;
  }
}

async function handleSubscriptionDeleted(obj) {
  const subId = obj.id ? String(obj.id) : null;
  let subscription = subId ? await Subscription.findByStripeSubscriptionId(subId) : null;
  if (!subscription) {
    const user = await resolveUser(obj);
    if (user) subscription = (await Subscription.findByUserId(user.id))[0];
  }
  if (!subscription) { console.warn('[webhook] customer.subscription.deleted: no match'); return; }
  await withTransaction(async (connection) => {
    await connection.execute('UPDATE subscriptions SET status = ? WHERE id = ?', ['cancelled', subscription.id]);
  });
}

async function handlePaymentFailed(obj) {
  const user = await resolveUser(obj);
  if (!user) { console.warn('[webhook] invoice.payment_failed: no matching user'); return; }
  const plan = planFromObject(obj);
  const billingCycle = cycleFromObject(obj);
  const amount = typeof obj.amount_due === 'number' ? obj.amount_due / 100
    : typeof obj.amount === 'number' ? obj.amount / 100 : 0;
  const stripePaymentId = obj.payment_intent ? String(obj.payment_intent)
    : obj.id ? String(obj.id) : null;
  if (!stripePaymentId) return;
  await withTransaction(async (connection) => {
    await connection.execute(
      `INSERT INTO payments
         (user_id, amount, currency, plan, billing_cycle, stripe_payment_id, status)
       VALUES (?, ?, ?, ?, ?, ?, 'failed')
       ON DUPLICATE KEY UPDATE id = id`,
      [user.id, amount, obj.currency || 'usd', plan, billingCycle, stripePaymentId]
    );
  });
}

router.post(
  '/stripe',
  asyncHandler(async (req, res) => {
    let event;
    try { event = stripe.constructEvent(req.body, req.headers['stripe-signature']); }
    catch (err) { return res.status(400).json({ received: false, error: 'invalid_signature' }); }

    if (!event || !event.id || !event.type)
      return res.status(400).json({ received: false, error: 'invalid_event' });

    let claim;
    try { claim = await StripeEvent.claim(event, req.body); }
    catch (err) {
      console.error('[webhook] could not claim event:', err);
      return res.status(500).json({ received: false, error: 'event_claim_failed' });
    }
    if (claim === 'processed') return res.status(200).json({ received: true, duplicate: true });
    if (claim === 'in_progress') return res.status(409).json({ received: false, error: 'event_in_progress' });

    try {
      const obj = (event.data && event.data.object) || {};
      switch (event.type) {
        case 'checkout.session.completed': await handleCheckoutCompleted(obj, event.id); break;
        case 'customer.subscription.deleted': await handleSubscriptionDeleted(obj); break;
        case 'invoice.payment_failed': await handlePaymentFailed(obj); break;
      }
      await StripeEvent.markProcessed(event.id);
    } catch (err) {
      await StripeEvent.markFailed(event.id, err).catch((markErr) =>
        console.error('[webhook] could not mark event failed:', markErr));
      console.error(`[webhook] error handling ${event.type}:`, err);
      return res.status(500).json({ received: false, error: 'processing_failed' });
    }

    return res.status(200).json({ received: true });
  })
);

module.exports = router;
