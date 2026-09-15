'use strict';

const router = require('express').Router();

const asyncHandler = require('../utils/asyncHandler');
const stripe = require('../utils/stripe');
const { sendLicenseEmail, sendReceiptEmail } = require('../utils/email');
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
      // A paid activation ends any running no-card trial (trial_ends_at = NULL).
      await connection.execute(
        `UPDATE subscriptions
            SET plan = ?, status = 'active', seats = ?, expiry_date = ?, start_date = ?,
                trial_ends_at = NULL, cancel_at_period_end = 0,
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
    // A failed receipt must not lose the license email that already went out.
    await sendReceiptEmail(user, {
      plan, billingCycle, amount, currency: obj.currency || 'usd',
      invoiceUrl: obj.invoice_url || obj.hosted_invoice_url || null,
    }).catch((err) => console.error('[webhook] receipt email failed:', err.message));
    await LicenseEmailDelivery.markSent(eventId);
  } catch (err) {
    await LicenseEmailDelivery.markFailed(eventId, err).catch(() => {});
    throw err;
  }
}

// The subscription row a Stripe object refers to: by Stripe subscription id,
// then customer id, then (metadata / email) the user's newest row.
async function resolveSubscription(obj) {
  const subId = obj.subscription ? String(typeof obj.subscription === 'object' ? obj.subscription.id : obj.subscription)
    : (obj.object === 'subscription' && obj.id ? String(obj.id) : null);
  if (subId) {
    const byStripe = await Subscription.findByStripeSubscriptionId(subId);
    if (byStripe) return byStripe;
  }
  const customer = obj.customer ? String(typeof obj.customer === 'object' ? obj.customer.id : obj.customer) : null;
  if (customer) {
    const byCustomer = await Subscription.findByStripeCustomerId(customer);
    if (byCustomer) return byCustomer;
  }
  const user = await resolveUser(obj);
  if (user) return (await Subscription.findByUserId(user.id))[0] || null;
  return null;
}

// Billing interval of an invoice line / subscription item → our billing cycle.
function cycleFromInterval(obj) {
  const line = obj.lines?.data?.[0] || obj.items?.data?.[0] || null;
  const interval = line?.price?.recurring?.interval || line?.plan?.interval || null;
  if (interval === 'year') return 'yearly';
  if (interval === 'month') return 'monthly';
  const meta = obj.subscription_details?.metadata || obj.metadata || {};
  return meta.billingCycle === 'yearly' ? 'yearly' : 'monthly';
}

// End of the period an invoice/subscription covers, as a Date, or null.
function periodEndFrom(obj) {
  const line = obj.lines?.data?.[0] || null;
  const unix = line?.period?.end || obj.current_period_end || null;
  return Number.isFinite(Number(unix)) && Number(unix) > 0 ? new Date(Number(unix) * 1000) : null;
}

/**
 * A paid invoice — above all a RENEWAL. checkout.session.completed only fires
 * for the first purchase, and expiry_date was set to "now + one period" then
 * and never touched again: every monthly Pro customer's licence read `expired`
 * from month two while Stripe went on charging them. Each paid invoice now
 * pushes expiry_date to the end of the period it covers (falling back to one
 * period from the later of now and the current expiry) and records the
 * payment. Idempotent: the first invoice of a new subscription lands on the
 * row checkout already activated and just confirms its dates.
 */
async function handleInvoicePaid(obj, eventId) {
  const subscription = await resolveSubscription(obj);
  if (!subscription) { console.warn('[webhook] invoice.paid: no matching subscription'); return; }

  const meta = obj.subscription_details?.metadata || obj.metadata || {};
  const plan = meta.plan && PLANS[meta.plan] && meta.plan !== 'free' ? meta.plan
    : (subscription.plan !== 'free' ? subscription.plan : null);
  if (!plan) throw new Error('invoice.paid: cannot determine a paid plan');
  const billingCycle = cycleFromInterval(obj);

  const currentExpiry = subscription.expiry_date ? new Date(subscription.expiry_date) : null;
  const base = currentExpiry && currentExpiry.getTime() > Date.now() ? currentExpiry : new Date();
  const fallback = new Date(base);
  if (billingCycle === 'yearly') fallback.setFullYear(fallback.getFullYear() + 1);
  else fallback.setMonth(fallback.getMonth() + 1);
  const periodEnd = periodEndFrom(obj) || fallback;
  // Never move an expiry backwards: a replayed or out-of-order invoice must
  // not shorten what a later one already granted.
  const newExpiry = currentExpiry && currentExpiry.getTime() > periodEnd.getTime() ? currentExpiry : periodEnd;

  const amount = typeof obj.amount_paid === 'number' ? obj.amount_paid / 100
    : typeof obj.amount_total === 'number' ? obj.amount_total / 100 : 0;
  const stripePaymentId = obj.payment_intent ? String(obj.payment_intent)
    : obj.id ? String(obj.id) : null;
  const stripeSubId = obj.subscription ? String(typeof obj.subscription === 'object' ? obj.subscription.id : obj.subscription) : null;
  const stripeCustomer = obj.customer ? String(typeof obj.customer === 'object' ? obj.customer.id : obj.customer) : null;

  await withTransaction(async (connection) => {
    await connection.execute(
      `UPDATE subscriptions
          SET plan = ?, status = 'active', seats = ?, expiry_date = ?, trial_ends_at = NULL,
              stripe_subscription_id = COALESCE(?, stripe_subscription_id),
              stripe_customer_id = COALESCE(?, stripe_customer_id)
        WHERE id = ?`,
      [plan, planSeats(plan), newExpiry, stripeSubId, stripeCustomer, subscription.id]
    );
    if (stripePaymentId) {
      await connection.execute(
        `INSERT INTO payments
           (user_id, amount, currency, plan, billing_cycle, stripe_payment_id, status)
         VALUES (?, ?, ?, ?, ?, ?, 'paid')
         ON DUPLICATE KEY UPDATE id = id`,
        [subscription.user_id, amount, obj.currency || 'usd', plan, billingCycle, stripePaymentId]
      );
    }
  });

  // The first invoice's receipt goes out with the licence email from
  // checkout.session.completed; a renewal gets its own, best-effort.
  if (obj.billing_reason && obj.billing_reason !== 'subscription_create') {
    const user = await User.findById(subscription.user_id);
    if (user) {
      await sendReceiptEmail(user, {
        plan, billingCycle, amount, currency: obj.currency || 'usd',
        invoiceUrl: obj.hosted_invoice_url || obj.invoice_url || null,
      }).catch((err) => console.error(`[webhook] renewal receipt failed (${eventId}):`, err.message));
    }
  }
}

/**
 * customer.subscription.updated: the customer used Stripe's portal. Two facts
 * matter here — whether the renewal is switched off (cancel_at_period_end,
 * which the billing page shows as "ends on …") and the current period end.
 */
async function handleSubscriptionUpdated(obj) {
  const subscription = await resolveSubscription(obj);
  if (!subscription) { console.warn('[webhook] customer.subscription.updated: no match'); return; }
  const fields = { cancelAtPeriodEnd: obj.cancel_at_period_end ? 1 : 0 };
  const periodEnd = periodEndFrom(obj);
  const currentExpiry = subscription.expiry_date ? new Date(subscription.expiry_date) : null;
  if (periodEnd && obj.status === 'active' && (!currentExpiry || periodEnd.getTime() > currentExpiry.getTime()))
    fields.expiryDate = periodEnd;
  await Subscription.update(subscription.id, fields);
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
        case 'invoice.paid':
        case 'invoice.payment_succeeded': await handleInvoicePaid(obj, event.id); break;
        case 'customer.subscription.updated': await handleSubscriptionUpdated(obj); break;
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
