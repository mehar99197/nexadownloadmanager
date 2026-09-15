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

function statusSummary(sub) {
  return {
    plan: sub.plan, status: sub.status, expiryDate: sub.expiry_date, seats: sub.seats,
    trial: isTrialActive(sub), trialEndsAt: toIso(sub.trial_ends_at),
    cancelAtPeriodEnd: Boolean(Number(sub.cancel_at_period_end)),
  };
}

router.get(
  '/plans',
  asyncHandler(async (req, res) => ok(res, PLANS))
);

router.post(
  '/checkout', requireAuth, validate(checkoutSchema),
  asyncHandler(async (req, res) => {
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
    if (!config.isStripeMock || config.isProd)
      return fail(res, 'NOT_AVAILABLE', 'Mock billing is only available in development', 404);
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

router.post(
  '/cancel', requireAuth,
  asyncHandler(async (req, res) => {
    const subs = await Subscription.findByUserId(req.user.id);
    const subscription = subs[0];
    if (!subscription) return fail(res, 'NOT_FOUND', 'No subscription found', 404);
    // The free plan never renews; marking it cancelled would only make the
    // desktop app treat the user's (free) licence key as invalid.
    if (subscription.plan === 'free')
      return fail(res, 'NOT_A_PAID_PLAN', 'The free plan has nothing to cancel', 400);
    if (subscription.status !== 'active')
      return fail(res, 'ALREADY_INACTIVE', 'This subscription is not active', 400);
    if (Number(subscription.cancel_at_period_end))
      return fail(res, 'ALREADY_CANCELLED', 'This subscription is already set to end at the period close', 400);

    // The billing page promises "your plan stays active until the end of the
    // period you already paid for". Marking the row cancelled here broke that
    // promise twice over: the desktop app's next licence check answered
    // `cancelled` and dropped the user to Free the same minute, and the paid
    // weeks that remained were simply lost. Stop the renewal instead; the row
    // stays active until expiry_date, and Stripe's customer.subscription.deleted
    // (sent at the period end) is what finally marks it cancelled.
    if (subscription.stripe_subscription_id)
      await stripe.cancelAtPeriodEnd(subscription.stripe_subscription_id);

    await Subscription.update(subscription.id, { cancelAtPeriodEnd: 1 });
    const sub = await Subscription.findById(subscription.id);
    return ok(res, statusSummary(sub));
  })
);

// 7-day Pro trial, no card. One per account (users.trial_used); never
// offered to an active paid plan. Everything is applied in one transaction.
router.post(
  '/start-trial', requireAuth,
  asyncHandler(async (req, res) => {
    const result = await Subscription.startTrial(req.user.id);
    if (!result.ok) {
      if (result.reason === 'not_found') return fail(res, 'NOT_FOUND', 'Account not found', 404);
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
    let sub = await Subscription.findActiveByUserId(req.user.id) ||
              (await Subscription.findByUserId(req.user.id))[0];
    if (!sub) return fail(res, 'NOT_FOUND', 'No subscription found', 404);
    sub = await Subscription.expireTrialIfNeeded(sub);
    return ok(res, statusSummary(sub));
  })
);

module.exports = router;
