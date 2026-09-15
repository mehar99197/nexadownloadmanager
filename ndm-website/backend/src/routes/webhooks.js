'use strict';

const router = require('express').Router();

const config = require('../config/env');
const asyncHandler = require('../utils/asyncHandler');
const stripe = require('../utils/stripe');
const { sendLicenseEmail, sendReceiptEmail } = require('../utils/email');
const { planSeats, planExpiry } = require('../utils/license');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const Payment = require('../models/Payment');
const { generateLicenseKey } = require('../utils/license');
const { withTransaction } = require('../config/db');
const AuditLog = require('../models/AuditLog');
const StripeEvent = require('../models/StripeEvent');
const { PLANS } = require('../config/plans');
const LicenseEmailDelivery = require('../models/LicenseEmailDelivery');
// Reading an invoice's shape is pure and API-version-sensitive, so it lives in
// utils/stripeInvoice.js where it can be tested against captured payloads.
const invoice = require('../utils/stripeInvoice');

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

/* --------------------------------------------------------------- invoices */

/**
 * The subscription an invoice belongs to: by Stripe subscription id first (the
 * only unambiguous link), then by customer id, then by the billing email.
 */
async function subscriptionForInvoice(obj) {
  const stripeSubId = invoice.subscriptionId(obj);
  if (stripeSubId) {
    const found = await Subscription.findByStripeSubscriptionId(stripeSubId);
    if (found) return found;
  }
  if (obj.customer) {
    const found = await Subscription.findByStripeCustomerId(String(obj.customer));
    if (found) return found;
  }
  const user = await resolveUser(obj);
  if (user) return (await Subscription.findByUserId(user.id))[0] || null;
  return null;
}

/**
 * A subscription renewal was paid.
 *
 * Without this the expiry_date written at checkout is never extended: a monthly
 * subscriber's licence read as `expired` on day 31 while Stripe kept charging
 * them, and the desktop app deletes a key it is told is expired. The renewal
 * therefore has to push expiry_date forward — preferably to the exact period end
 * Stripe just billed for, so our clock never drifts from theirs.
 *
 * The FIRST invoice of a subscription also arrives here (billing_reason
 * 'subscription_create'), right beside checkout.session.completed. Everything
 * below is idempotent — the payment insert dedupes on stripe_payment_id and the
 * expiry write is absolute, not relative — and the receipt email is limited to
 * genuine renewals so nobody is thanked twice for the same purchase.
 */
async function handleInvoicePaid(obj) {
  const subscription = await subscriptionForInvoice(obj);
  if (!subscription) { console.warn('[webhook] invoice paid: no matching subscription'); return; }

  // Normally our own row names the plan. When it says 'free' the subscription
  // has lapsed — a card that kept failing, say — and this renewal is the
  // payment that finally landed, so the plan has to be restored FROM the
  // invoice. Without that fallback a recovered payment left the customer on
  // Free while Stripe happily charged them again.
  const stored = PLANS[subscription.plan] && subscription.plan !== 'free' ? subscription.plan : null;
  const plan = stored || invoice.planFromInvoice(obj, PLANS);
  if (!plan || plan === 'free') {
    console.warn(`[webhook] invoice paid but no paid plan could be resolved (stored '${subscription.plan}')`);
    return;
  }

  const billingCycle = invoice.billingCycle(obj);
  // A Free row's expiry_date is a far-future sentinel, not a paid period, so
  // it only counts as "the current period" while the row is on a paid plan.
  const currentExpiry = stored && subscription.expiry_date ? new Date(subscription.expiry_date) : null;
  // Without a period on the invoice, extend from the later of now and the
  // current expiry: a renewal paid before the old period ran out must add a
  // full cycle, not restart the clock from today.
  const base = currentExpiry && currentExpiry.getTime() > Date.now() ? currentExpiry : new Date();
  const extended = new Date(base);
  if (billingCycle === 'yearly') extended.setFullYear(extended.getFullYear() + 1);
  else extended.setMonth(extended.getMonth() + 1);
  const granted = invoice.periodEnd(obj) || extended;
  // Never move an expiry backwards. Stripe retries and re-delivers events out
  // of order, and an older invoice landing after a newer one must not take
  // back weeks the newer one already granted.
  const expiry = currentExpiry && currentExpiry.getTime() > granted.getTime() ? currentExpiry : granted;
  const stripeSubId = invoice.subscriptionId(obj);

  await withTransaction(async (connection) => {
    await connection.execute(
      `UPDATE subscriptions
          SET plan = ?, seats = ?, status = 'active', expiry_date = ?, trial_ends_at = NULL,
              cancel_at_period_end = 0,
              stripe_subscription_id = COALESCE(?, stripe_subscription_id),
              stripe_customer_id = COALESCE(?, stripe_customer_id)
        WHERE id = ?`,
      [plan, planSeats(plan), expiry, stripeSubId,
       obj.customer ? String(obj.customer) : null, subscription.id]
    );
    const stripePaymentId = invoice.paymentId(obj);
    if (stripePaymentId) {
      await connection.execute(
        `INSERT INTO payments
           (user_id, amount, currency, plan, billing_cycle, stripe_payment_id, status)
         VALUES (?, ?, ?, ?, ?, ?, 'paid')
         ON DUPLICATE KEY UPDATE id = id`,
        [subscription.user_id, invoice.amount(obj), obj.currency || 'usd', plan, billingCycle, stripePaymentId]
      );
    }
  });

  // Only a real renewal gets a receipt; the first invoice is already covered by
  // the licence + receipt pair that checkout.session.completed sends.
  if (!invoice.isRenewal(obj)) return;
  const user = await User.findById(subscription.user_id);
  if (!user) return;
  await sendReceiptEmail(user, {
    plan, billingCycle, amount: invoice.amount(obj), currency: obj.currency || 'usd',
    invoiceUrl: invoice.invoiceUrl(obj),
  }).catch((err) => console.error('[webhook] renewal receipt email failed:', err.message));
}

// `checkout.session.completed` fires when the customer finishes the flow, NOT
// when the money arrives. With a delayed payment method enabled in the Stripe
// dashboard — ACH direct debit, SEPA, BACS, some bank redirects — the session
// completes with `payment_status: 'unpaid'` and settles (or fails) days later.
// Granting on completion alone hands out a paid licence for a debit that may
// never clear, and Stripe's own guidance is to wait for
// checkout.session.async_payment_succeeded. `no_payment_required` is the
// zero-amount case (a 100% coupon), which is genuinely paid up.
const SETTLED_PAYMENT_STATUS = new Set(['paid', 'no_payment_required']);

function isSettled(obj) {
  // Older API versions and our own mock events omit the field entirely; a
  // session that never mentions a payment status is the classic card flow,
  // which only completes once the charge succeeded.
  const status = obj && obj.payment_status;
  return status === undefined || status === null || SETTLED_PAYMENT_STATUS.has(String(status));
}

async function handleCheckoutCompleted(obj, eventId) {
  if (!isSettled(obj)) {
    console.warn(
      `[webhook] checkout session ${obj && obj.id} completed but payment_status=${obj.payment_status};`
      + ' waiting for checkout.session.async_payment_succeeded'
    );
    return;
  }
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

/** Locate our row for a Stripe subscription object. */
async function subscriptionForStripeObject(obj) {
  const subId = obj.id ? String(obj.id) : null;
  if (subId) {
    const found = await Subscription.findByStripeSubscriptionId(subId);
    if (found) return found;
  }
  if (obj.customer) {
    const found = await Subscription.findByStripeCustomerId(String(obj.customer));
    if (found) return found;
  }
  const user = await resolveUser(obj);
  if (user) return (await Subscription.findByUserId(user.id))[0] || null;
  return null;
}

/**
 * The subscription ended for good — cancelled at period end, or Stripe gave up
 * after retrying a failed charge.
 *
 * The customer becomes a FREE user, which is what they now are: they keep their
 * licence key and the app keeps working, just without the paid entitlements.
 * Marking the row `cancelled` instead made /api/license/validate answer
 * `reason:"cancelled"`, and the desktop client DELETES the key on that — so
 * ending a subscription also destroyed the free licence underneath it.
 *
 * The audit row is what preserves the churn event now that the plan itself no
 * longer records it.
 */
async function handleSubscriptionDeleted(obj) {
  const subscription = await subscriptionForStripeObject(obj);
  if (!subscription) { console.warn('[webhook] customer.subscription.deleted: no match'); return; }
  if (subscription.plan === 'free') return;

  await withTransaction(async (connection) => {
    await connection.execute(
      `UPDATE subscriptions
          SET plan = 'free', status = 'active', seats = ?, expiry_date = ?,
              trial_ends_at = NULL, cancel_at_period_end = 0, stripe_subscription_id = NULL
        WHERE id = ?`,
      [planSeats('free'), planExpiry('free'), subscription.id]
    );
  });
  await AuditLog.create({
    adminUserId: null, action: 'subscription.ended', entityType: 'subscription',
    entityId: subscription.id,
    summary: `${subscription.plan} subscription ended; account returned to Free`,
    metadata: { previousPlan: subscription.plan, stripeSubscriptionId: obj.id || null },
  });
}

/**
 * The subscription changed somewhere other than our checkout — almost always
 * Stripe's hosted billing portal, which /billing links to. Nothing used to
 * handle this at all, so a plan switched or cancelled over there never reached
 * our database and the site kept showing the old one.
 *
 * Only facts Stripe is authoritative about are copied: the period end, whether
 * a cancellation is pending, and the plan when its price identifies one of ours.
 * An unrecognised price leaves the stored plan untouched — see
 * stripeInvoice.planFromSubscription.
 */
async function handleSubscriptionUpdated(obj) {
  const subscription = await subscriptionForStripeObject(obj);
  if (!subscription) { console.warn('[webhook] customer.subscription.updated: no match'); return; }

  const updates = {};
  const plan = invoice.planFromSubscription(obj, PLANS);
  if (plan && plan !== 'free' && plan !== subscription.plan) {
    updates.plan = plan;
    updates.seats = planSeats(plan);
    updates.trial_ends_at = null;
  }
  const periodEnd = invoice.subscriptionPeriodEnd(obj);
  if (periodEnd) updates.expiry_date = periodEnd;

  const status = invoice.statusFromSubscription(obj);
  // 'cancelled' arrives through customer.subscription.deleted, which downgrades
  // to Free properly; applying it here as well would race with that.
  if (status === 'active' && subscription.status !== 'active') updates.status = 'active';

  const cancelling = obj.cancel_at_period_end === true || obj.cancel_at_period_end === 1;
  if (cancelling !== Boolean(Number(subscription.cancel_at_period_end)))
    updates.cancel_at_period_end = cancelling ? 1 : 0;

  const columns = Object.keys(updates);
  if (!columns.length) return;
  await withTransaction(async (connection) => {
    await connection.execute(
      `UPDATE subscriptions SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...columns.map((c) => updates[c]), subscription.id]
    );
  });
  await AuditLog.create({
    adminUserId: null, action: 'subscription.synced', entityType: 'subscription',
    entityId: subscription.id,
    summary: `Synced subscription ${subscription.id} from Stripe`,
    metadata: { changed: columns, stripeStatus: obj.status || null },
  });
}

/**
 * A charge was refunded.
 *
 * `payments.status` has always had a `refunded` value that nothing ever wrote,
 * so a refunded month still counted toward the revenue chart and the MRR tile.
 * A FULL refund also ends the plan — you cannot both hand the money back and
 * keep charging for the entitlements — while a partial one only corrects the
 * record.
 */
async function handleChargeRefunded(obj) {
  const paymentId = obj.payment_intent ? String(obj.payment_intent) : (obj.id ? String(obj.id) : null);
  if (!paymentId) return;
  const fullyRefunded = obj.amount_refunded != null && obj.amount != null
    ? Number(obj.amount_refunded) >= Number(obj.amount)
    : Boolean(obj.refunded);

  const result = await Payment.markRefunded(paymentId);
  if (!result) console.warn(`[webhook] charge.refunded: no payment row for ${paymentId}`);
  if (!fullyRefunded) return;

  const subscription = obj.customer
    ? await Subscription.findByStripeCustomerId(String(obj.customer))
    : null;
  if (!subscription || subscription.plan === 'free') return;

  if (subscription.stripe_subscription_id) {
    // Stop the billing too, or the next period charges a refunded customer.
    await stripe.cancelSubscription(subscription.stripe_subscription_id, { atPeriodEnd: false })
      .catch((err) => console.error('[webhook] cancel after refund failed:', err.message));
  }
  await Subscription.update(subscription.id, {
    plan: 'free', status: 'active', seats: planSeats('free'),
    expiryDate: planExpiry('free'), trialEndsAt: null, cancelAtPeriodEnd: 0,
    stripeSubscriptionId: null,
  });
  await AuditLog.create({
    adminUserId: null, action: 'subscription.refunded', entityType: 'subscription',
    entityId: subscription.id,
    summary: `${subscription.plan} refunded in full; account returned to Free`,
    metadata: { paymentId, previousPlan: subscription.plan },
  });
}

/**
 * A renewal charge failed. Recorded as a `failed` payment so the customer and
 * the admin panel can both see it; the subscription is left alone, because
 * Stripe retries for days before it gives up and sends
 * customer.subscription.deleted, which is what actually ends access.
 *
 * The plan comes from our subscription row, NOT from obj.metadata: an invoice
 * carries none of the Checkout Session's metadata, so reading it there threw on
 * every real failure — the handler 500'd, the event was marked failed and
 * Stripe retried it until it expired, and nothing was ever recorded.
 */
async function handlePaymentFailed(obj) {
  const subscription = await subscriptionForInvoice(obj);
  const user = subscription
    ? await User.findById(subscription.user_id)
    : await resolveUser(obj);
  if (!user) { console.warn('[webhook] invoice.payment_failed: no matching user'); return; }

  const plan = subscription && PLANS[subscription.plan] && subscription.plan !== 'free'
    ? subscription.plan : null;
  if (!plan) { console.warn('[webhook] invoice.payment_failed: no paid plan to attribute'); return; }

  const stripePaymentId = invoice.paymentId(obj);
  if (!stripePaymentId) return;
  await withTransaction(async (connection) => {
    await connection.execute(
      `INSERT INTO payments
         (user_id, amount, currency, plan, billing_cycle, stripe_payment_id, status)
       VALUES (?, ?, ?, ?, ?, ?, 'failed')
       ON DUPLICATE KEY UPDATE id = id`,
      [user.id, invoice.amount(obj), obj.currency || 'usd', plan, invoice.billingCycle(obj), stripePaymentId]
    );
  });
}

router.post(
  '/stripe',
  asyncHandler(async (req, res) => {
    // No Stripe key means no webhook secret means nothing here can be
    // verified. Refuse before touching the body: the alternative, "mock" mode,
    // would grant a paid plan to anybody who POSTs a JSON event, and used to
    // be exactly what a public box without live keys ran. env.js now never
    // selects mock mode for a public deployment; this is the belt to that
    // pair of braces.
    if (config.isBillingDisabled)
      return res.status(503).json({ received: false, error: 'billing_disabled' });

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
        // The delayed-payment settlement of the session above. Same handler:
        // by this point payment_status is 'paid', so isSettled() lets it
        // through and the grant happens exactly once, on the money arriving.
        case 'checkout.session.async_payment_succeeded':
          await handleCheckoutCompleted(obj, event.id); break;
        // The debit bounced. Nothing was ever granted (completed returned
        // early), so there is nothing to undo — record it and move on.
        case 'checkout.session.async_payment_failed':
          console.warn(`[webhook] delayed payment failed for checkout session ${obj && obj.id}`);
          break;
        case 'customer.subscription.deleted': await handleSubscriptionDeleted(obj); break;
        // Plan switches and cancellations made in Stripe's own billing portal,
        // which /billing links to — they reach us nowhere else.
        case 'customer.subscription.updated': await handleSubscriptionUpdated(obj); break;
        case 'charge.refunded': await handleChargeRefunded(obj); break;
        // Renewals. Older Stripe API versions name this invoice.payment_succeeded,
        // newer ones invoice.paid; both are accepted and the handler is idempotent,
        // so a deployment that has both enabled processes the second as a no-op.
        case 'invoice.payment_succeeded':
        case 'invoice.paid': await handleInvoicePaid(obj); break;
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
