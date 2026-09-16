'use strict';

const router = require('express').Router();

const config = require('../config/env');
const { PLANS } = require('../config/plans');
const asyncHandler = require('../utils/asyncHandler');
const { ok, fail } = require('../utils/respond');
const stripe = require('../utils/stripe');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { checkoutSchema, mockCompleteSchema, couponSchema } = require('../schemas/subscription.schema');
const Subscription = require('../models/Subscription');
const { effectivePlanFor } = require('../utils/accountPlan');
const Payment = require('../models/Payment');
const AuditLog = require('../models/AuditLog');
const {
  generateLicenseKey, planSeats, planExpiry, TRIAL_DAYS, TRIAL_PLAN, isTrialActive,
} = require('../utils/license');

function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function statusSummary(sub, { viaTeam = false, teamOwner = null } = {}) {
  return {
    plan: sub.plan, status: sub.status, expiryDate: sub.expiry_date, seats: sub.seats,
    trial: viaTeam ? false : isTrialActive(sub),
    trialEndsAt: viaTeam ? null : toIso(sub.trial_ends_at),
    // "Active, but it ends on the 3rd" is a state the site has to be able to
    // show — otherwise a cancellation looks like it did nothing. A member is
    // never shown the owner's cancellation state: it is not theirs to act on.
    cancelAtPeriodEnd: viaTeam ? false : Boolean(Number(sub.cancel_at_period_end)),
    // Billing hides "cancel" and "manage billing" on a plan the account is a
    // guest on — a member can neither pay for nor stop the owner's plan.
    viaTeam, teamOwner,
  };
}

// `billing` rides along so the pricing page can say "coming soon" up front
// instead of letting a visitor click through to a 503 from /checkout.
router.get(
  '/plans',
  asyncHandler(async (req, res) => ok(res, { ...PLANS, billing: config.stripeMode }))
);

// A hardened deployment without Stripe keys runs with billing DISABLED (see
// config/env.js#stripeMode). The site keeps working — accounts, trials, the
// free licence, admin-granted plans — but nothing can be bought until live keys
// are configured, and this says so instead of pretending.
function billingUnavailable(res) {
  return fail(res, 'BILLING_UNAVAILABLE',
    'Payments are not available on this site yet. Please check back soon.', 503);
}

router.post(
  '/checkout', requireAuth, validate(checkoutSchema),
  asyncHandler(async (req, res) => {
    if (config.isBillingDisabled) return billingUnavailable(res);
    const { plan, billingCycle, couponCode } = req.body;
    // Reject a bad code here rather than silently charging full price.
    if (couponCode) {
      const promo = await stripe.findPromotionCode(couponCode);
      if (!promo) return fail(res, 'INVALID_COUPON', 'That code is not valid', 400);
    }
    const session = await stripe.createCheckoutSession({
      plan, billingCycle, user: req.user, couponCode,
      successUrl: `${config.FRONTEND_URL}/billing`,
      cancelUrl: `${config.FRONTEND_URL}/pricing`,
    });
    return ok(res, { url: session.url });
  })
);

// Check a promotion code before checkout so the price shown is the price paid.
router.post(
  '/coupon', requireAuth, validate(couponSchema),
  asyncHandler(async (req, res) => {
    if (config.isBillingDisabled) return billingUnavailable(res);
    const promo = await stripe.findPromotionCode(req.body.couponCode);
    if (!promo) return fail(res, 'INVALID_COUPON', 'That code is not valid', 400);
    return ok(res, { code: promo.code, percentOff: promo.percentOff ?? null,
                     amountOff: promo.amountOff ?? null });
  })
);

// Stripe's hosted billing portal (cards, invoices, cancellation). Returns
// url:null when there is nothing to manage, so the UI can stay on /billing.
router.post(
  '/portal', requireAuth,
  asyncHandler(async (req, res) => {
    if (config.isBillingDisabled) return billingUnavailable(res);
    const sub = (await Subscription.findByUserId(req.user.id))[0] || null;
    if (!sub || !sub.stripe_customer_id)
      return ok(res, { url: null, reason: 'no_stripe_customer' });
    const session = await stripe.createPortalSession({
      customerId: sub.stripe_customer_id,
      returnUrl: `${config.FRONTEND_URL}/billing`,
    });
    return ok(res, { url: session.url || null });
  })
);

router.post(
  '/mock-complete', requireAuth, validate(mockCompleteSchema),
  asyncHandler(async (req, res) => {
    // isStripeMock is only ever true for a LOCAL, non-production deployment —
    // config/env.js picks 'disabled', not 'mock', for a public box without
    // keys — so this single check is the whole gate.
    if (!config.isStripeMock)
      return fail(res, 'NOT_AVAILABLE', 'Mock billing is only available in local development', 404);
    const { plan, billingCycle } = req.body;
    const existing = (await Subscription.findByUserId(req.user.id))[0] || null;
    const mockPaymentId = `mock_${req.user.id}_${plan}_${billingCycle}`;
    let subscription;
    if (existing) {
      await Subscription.update(existing.id, {
        plan, status: 'active', seats: planSeats(plan),
        expiryDate: planExpiry(plan, billingCycle), startDate: new Date(),
        trialEndsAt: null,
      });
      subscription = await Subscription.findById(existing.id);
    } else {
      subscription = await Subscription.create({
        userId: req.user.id, plan, status: 'active',
        licenseKey: generateLicenseKey(), seats: planSeats(plan),
        startDate: new Date(), expiryDate: planExpiry(plan, billingCycle),
      });
    }
    await Payment.create({
      userId: req.user.id, amount: plan === 'team' ? (billingCycle === 'yearly' ? 135 : 15)
        : (billingCycle === 'yearly' ? 45 : 5),
      currency: 'usd', plan, billingCycle, stripePaymentId: mockPaymentId, status: 'paid',
    });
    return ok(res, { plan: subscription.plan, status: subscription.status });
  })
);

/**
 * Cancel — at the END of the period the customer already paid for.
 *
 * This used to cancel on the spot: `stripe.subscriptions.cancel()` plus
 * `status='cancelled'`, so somebody who cancelled on day 2 of a paid month lost
 * Pro that second, and the desktop app DELETED their key on the `cancelled`
 * reason. The confirmation dialog on /billing has always promised the
 * opposite ("your plan stays active until the end of the period you already
 * paid for"), which is the behaviour implemented here.
 *
 * The row therefore stays `active` with its expiry intact and only carries
 * `cancel_at_period_end`. What ends it is either Stripe's
 * customer.subscription.deleted at the period boundary, or — for a plan with no
 * Stripe subscription behind it — the lazy fallback in
 * Subscription.expireIfLapsed. Either way the customer lands on Free with a
 * working key, never on a deleted one.
 */
router.post(
  '/cancel', requireAuth,
  asyncHandler(async (req, res) => {
    const subs = await Subscription.findByUserId(req.user.id);
    const subscription = await Subscription.current(subs[0] || null);
    if (!subscription) return fail(res, 'NOT_FOUND', 'No subscription found', 404);
    // The free plan never renews; marking it cancelled would only make the
    // desktop app treat the user's (free) licence key as invalid.
    if (subscription.plan === 'free')
      return fail(res, 'NOT_A_PAID_PLAN', 'The free plan has nothing to cancel', 400);
    if (subscription.status !== 'active')
      return fail(res, 'ALREADY_INACTIVE', 'This subscription is not active', 400);
    // A trial has no renewal to stop: scheduling a cancellation for the end of
    // a period that ends by itself is a button that does nothing, and it left
    // the billing page announcing "Ending" as if something had happened.
    if (isTrialActive(subscription))
      return fail(res, 'TRIAL_NOT_CANCELLABLE',
        'A trial is never billed and ends by itself — use "End trial now" to stop it early', 400);
    if (subscription.cancel_at_period_end)
      return fail(res, 'ALREADY_CANCELLING', 'This subscription is already set to end', 400);

    // The billing page promises "your plan stays active until the end of the
    // period you already paid for". Marking the row cancelled here broke that
    // promise twice over: the desktop app's next licence check answered
    // `cancelled` and dropped the user to Free the same minute, and the paid
    // weeks that remained were simply lost. Stop the renewal instead; the row
    // stays active until expiry_date, and Stripe's customer.subscription.deleted
    // (sent at the period end) is what finally marks it cancelled.
    if (subscription.stripe_subscription_id)
      await stripe.cancelSubscription(subscription.stripe_subscription_id, { atPeriodEnd: true });

    await Subscription.update(subscription.id, { cancelAtPeriodEnd: 1 });
    const sub = await Subscription.findById(subscription.id);
    await AuditLog.create({
      adminUserId: null, action: 'subscription.cancel_scheduled', entityType: 'subscription',
      entityId: sub.id, summary: `${req.user.email} cancelled their ${sub.plan} plan`,
      metadata: { endsAt: toIso(sub.expiry_date) },
    });
    return ok(res, statusSummary(sub));
  })
);

// Undo a pending cancellation while the period is still running. Without this
// the only way back was Stripe's hosted portal, which a trial or an
// admin-granted plan does not even have.
router.post(
  '/resume', requireAuth,
  asyncHandler(async (req, res) => {
    const subs = await Subscription.findByUserId(req.user.id);
    const subscription = await Subscription.current(subs[0] || null);
    if (!subscription) return fail(res, 'NOT_FOUND', 'No subscription found', 404);
    if (!subscription.cancel_at_period_end)
      return fail(res, 'NOT_CANCELLING', 'This subscription is not scheduled to end', 400);
    if (subscription.status !== 'active' || subscription.plan === 'free')
      return fail(res, 'ALREADY_INACTIVE', 'This plan has already ended — subscribe again to restart it', 400);

    if (subscription.stripe_subscription_id)
      await stripe.resumeSubscription(subscription.stripe_subscription_id);

    await Subscription.update(subscription.id, { cancelAtPeriodEnd: 0 });
    const sub = await Subscription.findById(subscription.id);
    await AuditLog.create({
      adminUserId: null, action: 'subscription.cancel_revoked', entityType: 'subscription',
      entityId: sub.id, summary: `${req.user.email} resumed their ${sub.plan} plan`,
    });
    return ok(res, statusSummary(sub));
  })
);

/**
 * End a running trial on the spot.
 *
 * "Cancel" can only mean "stop it now" here: nothing is billed and nothing
 * renews, so there is no future charge to call off. The account drops to Free
 * immediately — keeping its licence key, since Free is a working plan — and
 * the trial cannot be started again (users.trial_used stays set), which is the
 * one consequence worth warning about before the click.
 *
 * Deliberately NOT `cancelled`/`expired` on the row: the desktop client deletes
 * a key it is told is cancelled, and somebody ending a trial early has not had
 * their licence stopped.
 */
router.post(
  '/trial/cancel', requireAuth,
  asyncHandler(async (req, res) => {
    const subs = await Subscription.findByUserId(req.user.id);
    const subscription = await Subscription.current(subs[0] || null);
    if (!subscription) return fail(res, 'NOT_FOUND', 'No subscription found', 404);
    if (!isTrialActive(subscription))
      return fail(res, 'NO_TRIAL', 'There is no trial running on this account', 400);

    const sub = await Subscription.endTrial(subscription);
    await AuditLog.create({
      adminUserId: null, action: 'subscription.trial_cancelled', entityType: 'subscription',
      entityId: sub.id, summary: `${req.user.email} ended their ${TRIAL_PLAN} trial early`,
      metadata: { endedAt: toIso(new Date()), wouldHaveEndedAt: toIso(subscription.trial_ends_at) },
    });
    return ok(res, statusSummary(sub));
  })
);

// 7-day Pro trial, no card. One per account (users.trial_used); never
// offered to an active paid plan. Everything is applied in one transaction.
router.post(
  '/start-trial', requireAuth,
  asyncHandler(async (req, res) => {
    // Somebody on a Team plan already has everything the trial grants, and
    // starting one would burn the account's single trial on nothing: their own
    // row would go Pro-for-7-days behind a Team plan that already outranks it.
    const { viaTeam, teamOwner } = await effectivePlanFor(req.user.id);
    if (viaTeam)
      return fail(res, 'TRIAL_UNAVAILABLE',
        `You are already on ${teamOwner || 'a'}'s Team plan — a trial would add nothing`, 400);
    const result = await Subscription.startTrial(req.user.id);
    if (!result.ok) {
      if (result.reason === 'not_found') return fail(res, 'NOT_FOUND', 'Account not found', 404);
      // Distinct from "you already used your trial": this licence was stopped
      // by a person, and a trial must not quietly undo that. Saying so sends
      // the customer to support instead of leaving them retrying a button.
      if (result.reason === 'subscription_stopped')
        return fail(res, 'SUBSCRIPTION_STOPPED',
          'This account\u2019s licence was stopped. Please contact support.', 403);
      return fail(res, 'TRIAL_UNAVAILABLE', 'A free trial is not available for this account', 400);
    }
    const trialEndsAt = toIso(result.subscription.trial_ends_at);
    await AuditLog.create({
      adminUserId: null,
      action: 'subscription.trial_started',
      entityType: 'subscription',
      entityId: result.subscription.id,
      summary: `Started ${TRIAL_DAYS}-day ${TRIAL_PLAN} trial for ${req.user.email}`,
      metadata: { userId: req.user.id, plan: TRIAL_PLAN, trialEndsAt },
    });
    return ok(res, { plan: TRIAL_PLAN, trial: true, trialEndsAt });
  })
);

router.get(
  '/status', requireAuth,
  asyncHandler(async (req, res) => {
    // Team first: a member's own row stays Free, and reporting that as their
    // plan is what made Billing say "Free — nothing to cancel" to somebody
    // sitting on a live Team plan.
    const { subscription, viaTeam, teamOwner } = await effectivePlanFor(req.user.id);
    if (!subscription) return fail(res, 'NOT_FOUND', 'No subscription found', 404);
    return ok(res, statusSummary(subscription, { viaTeam, teamOwner }));
  })
);

module.exports = router;
