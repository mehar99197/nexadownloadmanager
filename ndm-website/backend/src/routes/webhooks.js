'use strict';

const router = require('express').Router();

const asyncHandler = require('../utils/asyncHandler');
const config = require('../config/env');
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
                trial_ends_at = NULL, stripe_subscription_id = ?, stripe_customer_id = ?
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

// ── Renewals and plan changes ───────────────────────────────────────────────
//
// checkout.session.completed writes expiry_date exactly once, from
// planExpiry() at the moment of purchase. Nothing used to move it afterwards,
// so a monthly subscriber was charged on day 30, Stripe reported the payment,
// nobody listened, and from day 31 the desktop app was refused its licence —
// while the card kept being charged every month (AUDIT.md H-04). The two
// handlers below are what keep a paying customer paid up:
//
//   invoice.paid / invoice.payment_succeeded → the period the invoice covers
//       becomes the new expiry, and the payment is recorded.
//   customer.subscription.created / .updated → plan, status and the current
//       period are mirrored, so a change made in Stripe's billing portal (an
//       upgrade, a downgrade, a pause, a cancellation at period end) shows up
//       here without a purchase having happened.
//
// Both are idempotent and order-independent: each finds the row by the
// Stripe subscription id, then the customer id, then the account, and writes
// the state Stripe reports, so replays and out-of-order deliveries converge.

// Stripe bills at the period end and reports the payment some time later —
// seconds normally, up to a few days when a card needs retrying. Without
// headroom every customer would be refused between the two, on every
// renewal, so the stored expiry is the paid-through date plus this. It is
// the grace Stripe's own retry schedule needs, not a free extension: a
// customer whose renewal keeps failing ends up 'unpaid' or 'canceled', and
// those events cancel the plan here regardless of the date.
const RENEWAL_GRACE_DAYS = 3;

function paidThrough(periodEnd) {
  return new Date(periodEnd.getTime() + RENEWAL_GRACE_DAYS * 24 * 60 * 60 * 1000);
}

function stripeId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return value.id ? String(value.id) : null;
}

function unixDate(seconds) {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
}

// Stripe moved these between API versions; read both shapes so the handler
// does not depend on which version the account is pinned to.
//   Invoice.subscription           → Invoice.parent.subscription_details.subscription
//   Invoice.subscription_details   → Invoice.parent.subscription_details
//   Subscription.current_period_end → Subscription.items.data[].current_period_end
function invoiceSubscriptionId(invoice) {
  return stripeId(invoice.subscription)
    || stripeId(invoice.parent && invoice.parent.subscription_details
      && invoice.parent.subscription_details.subscription);
}

function invoiceSubscriptionMetadata(invoice) {
  const details = (invoice.parent && invoice.parent.subscription_details)
    || invoice.subscription_details || {};
  return details.metadata || {};
}

// The service period an invoice pays for is on its lines, not on the invoice
// (Invoice.period_end is the billing period, which for a subscription is the
// one just finished). The latest line wins.
function invoicePeriodEnd(invoice) {
  const lines = (invoice.lines && invoice.lines.data) || [];
  let end = null;
  for (const line of lines) {
    const at = unixDate(line.period && line.period.end);
    if (at && (!end || at > end)) end = at;
  }
  return end;
}

function subscriptionPeriodEnd(sub) {
  let end = unixDate(sub.current_period_end);
  const items = (sub.items && sub.items.data) || [];
  for (const item of items) {
    const at = unixDate(item.current_period_end);
    if (at && (!end || at > end)) end = at;
  }
  return end;
}

function planIfKnown(value) {
  return value && PLANS[value] && value !== 'free' ? value : null;
}

function cycleFromInterval(interval) {
  return interval === 'year' ? 'yearly' : interval === 'month' ? 'monthly' : null;
}

// Our row for a Stripe subscription: by its id, then by the customer, then
// by the account the metadata or email names (its newest row). Null when
// nothing matches — the caller decides whether that is worth a warning.
async function findOurSubscription({ subscriptionId, customerId, obj }) {
  let row = subscriptionId ? await Subscription.findByStripeSubscriptionId(subscriptionId) : null;
  if (!row && customerId) row = await Subscription.findByStripeCustomerId(customerId);
  if (!row) {
    const user = await resolveUser(obj);
    if (user) row = (await Subscription.findByUserId(user.id))[0] || null;
  }
  return row;
}

async function handleInvoicePaid(obj, eventType) {
  // The first invoice of a subscription is the purchase itself:
  // checkout.session.completed activates the plan, records the payment and
  // sends the licence — and the two events race, so acting on this one too
  // would either double-record the payment or activate a row the checkout
  // handler is about to overwrite. It is left to the handler that owns it.
  if (obj.billing_reason === 'subscription_create') return;

  const subscriptionId = invoiceSubscriptionId(obj);
  const customerId = stripeId(obj.customer);
  const row = await findOurSubscription({ subscriptionId, customerId, obj });
  if (!row) {
    console.warn(`[webhook] ${eventType}: no subscription matches ${subscriptionId || customerId || 'the invoice'}`);
    return;
  }

  const metadata = invoiceSubscriptionMetadata(obj);
  // Which paid plan this pays for: the subscription's metadata, else the plan
  // the row already has. A free row with no metadata means the purchase this
  // renews was never recorded here, and activating it blind — with no plan and
  // a one-month expiry on a free row that /license/validate would then read as
  // expired — helps nobody. Log it; the operator has the Stripe dashboard.
  const plan = planIfKnown(metadata.plan) || planIfKnown(row.plan);
  if (!plan) {
    console.warn(`[webhook] ${eventType}: subscription #${row.id} is on the free plan and the invoice names none; not applied`);
    return;
  }
  const firstLine = ((obj.lines && obj.lines.data) || [])[0] || {};
  const billingCycle = metadata.billingCycle === 'yearly' || metadata.billingCycle === 'monthly'
    ? metadata.billingCycle
    : cycleFromInterval(firstLine.price && firstLine.price.recurring && firstLine.price.recurring.interval)
      || cycleFromInterval(firstLine.plan && firstLine.plan.interval)
      || 'monthly';
  // Paid through the end of what the invoice covers; if Stripe sent no line
  // periods at all, a plan-length extension from now is the honest fallback.
  const periodEnd = invoicePeriodEnd(obj);
  const expiry = periodEnd ? paidThrough(periodEnd) : planExpiry(plan, billingCycle);
  const amount = typeof obj.amount_paid === 'number' ? obj.amount_paid / 100
    : typeof obj.amount_due === 'number' ? obj.amount_due / 100 : 0;
  const stripePaymentId = stripeId(obj.payment_intent) || stripeId(obj.id);

  await withTransaction(async (connection) => {
    // A paid renewal is the strongest possible statement that the plan is
    // live: whatever the row said (an 'expired' set by a late webhook, a
    // trial flag) gives way to it.
    await connection.execute(
      `UPDATE subscriptions
          SET status = 'active', expiry_date = ?, trial_ends_at = NULL,
              stripe_subscription_id = COALESCE(?, stripe_subscription_id),
              stripe_customer_id = COALESCE(?, stripe_customer_id)
        WHERE id = ?`,
      [expiry, subscriptionId, customerId, row.id]
    );
    if (stripePaymentId) {
      await connection.execute(
        `INSERT INTO payments
           (user_id, amount, currency, plan, billing_cycle, stripe_payment_id, status)
         VALUES (?, ?, ?, ?, ?, ?, 'paid')
         ON DUPLICATE KEY UPDATE id = id`,
        [row.user_id, amount, obj.currency || 'usd', plan, billingCycle, stripePaymentId]
      );
    }
  });
}

// Stripe's subscription statuses, in terms of the three this schema has.
// past_due stays active on purpose: Stripe is still retrying the card, the
// renewal grace covers exactly this window, and the customer is told by
// Stripe, not cut off by us. The failures that end the retries arrive as
// 'unpaid' or 'canceled'. 'incomplete' (first payment never went through)
// is not mirrored at all: there is nothing to activate yet.
const STRIPE_STATUS = Object.freeze({
  trialing: 'active',
  active: 'active',
  past_due: 'active',
  unpaid: 'cancelled',
  canceled: 'cancelled',
  incomplete_expired: 'cancelled',
  paused: 'expired',
});

async function handleSubscriptionMirrored(obj, eventType) {
  const subscriptionId = stripeId(obj.id);
  const customerId = stripeId(obj.customer);
  const row = await findOurSubscription({ subscriptionId, customerId, obj });
  if (!row) {
    // A brand-new customer whose checkout handler has not run yet and who
    // has no row at all: checkout.session.completed creates it, with these
    // ids on it, and the next event about the subscription matches.
    console.warn(`[webhook] ${eventType}: no subscription matches ${subscriptionId || customerId || 'the event'}`);
    return;
  }

  const status = STRIPE_STATUS[obj.status];
  if (!status) return;
  const plan = planIfKnown(obj.metadata && obj.metadata.plan) || planIfKnown(row.plan);
  if (!plan) {
    // Same reasoning as handleInvoicePaid: nothing says which paid plan this
    // is, and a free row has no Stripe state to mirror.
    console.warn(`[webhook] ${eventType}: subscription #${row.id} is on the free plan and the event names none; not applied`);
    return;
  }
  // Seats follow the plan only when the plan actually changes. An admin can
  // grant a Team licence more seats than the catalogue's five, and a portal
  // event about something else (a card change, a pause) must not take them
  // back.
  const seats = plan === row.plan ? row.seats : planSeats(plan);
  const periodEnd = subscriptionPeriodEnd(obj);

  await withTransaction(async (connection) => {
    await connection.execute(
      `UPDATE subscriptions
          SET plan = ?, seats = ?, status = ?,
              expiry_date = COALESCE(?, expiry_date), trial_ends_at = NULL,
              stripe_subscription_id = COALESCE(?, stripe_subscription_id),
              stripe_customer_id = COALESCE(?, stripe_customer_id)
        WHERE id = ?`,
      [plan, seats, status, periodEnd ? paidThrough(periodEnd) : null,
        subscriptionId, customerId, row.id]
    );
  });
}

async function handlePaymentFailed(obj) {
  // An Invoice carries the plan only under its subscription details (see
  // invoiceSubscriptionMetadata), never in its own metadata — reading
  // planFromObject(obj) here threw on every real failure event and had Stripe
  // retrying it for days. The row's own plan is the fallback.
  const row = await findOurSubscription({
    subscriptionId: invoiceSubscriptionId(obj), customerId: stripeId(obj.customer), obj,
  });
  if (!row) { console.warn('[webhook] invoice.payment_failed: no matching subscription'); return; }
  const metadata = invoiceSubscriptionMetadata(obj);
  const plan = planIfKnown(metadata.plan) || row.plan;
  const billingCycle = metadata.billingCycle === 'yearly' ? 'yearly' : 'monthly';
  const amount = typeof obj.amount_due === 'number' ? obj.amount_due / 100
    : typeof obj.amount === 'number' ? obj.amount / 100 : 0;
  const stripePaymentId = stripeId(obj.payment_intent) || stripeId(obj.id);
  if (!stripePaymentId) return;
  await withTransaction(async (connection) => {
    await connection.execute(
      `INSERT INTO payments
         (user_id, amount, currency, plan, billing_cycle, stripe_payment_id, status)
       VALUES (?, ?, ?, ?, ?, ?, 'failed')
       ON DUPLICATE KEY UPDATE id = id`,
      [row.user_id, amount, obj.currency || 'usd', plan, billingCycle, stripePaymentId]
    );
  });
}

router.post(
  '/stripe',
  asyncHandler(async (req, res) => {
    // Billing disabled means no signing secret exists, so nothing reaching this
    // route can be authenticated. Refuse before parsing: an accepted event here
    // would grant a paid plan. The edge .htaccess blocks this path too - this
    // is the half that survives a webserver config being rebuilt.
    if (config.isBillingDisabled)
      return res.status(503).json({ received: false, error: 'billing_unavailable' });

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
        case 'customer.subscription.created':
        case 'customer.subscription.updated': await handleSubscriptionMirrored(obj, event.type); break;
        case 'customer.subscription.deleted': await handleSubscriptionDeleted(obj); break;
        // Both are sent for a successful payment; either alone is enough and
        // the handler is idempotent, so subscribing to one or both is fine.
        case 'invoice.paid':
        case 'invoice.payment_succeeded': await handleInvoicePaid(obj, event.type); break;
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
