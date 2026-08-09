'use strict';

const router = require('express').Router();

const config = require('../config/env');
const { PLANS } = require('../config/plans');
const asyncHandler = require('../utils/asyncHandler');
const { ok, fail } = require('../utils/respond');
const stripe = require('../utils/stripe');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { checkoutSchema, mockCompleteSchema } = require('../schemas/subscription.schema');
const Subscription = require('../models/Subscription');
const Payment = require('../models/Payment');
const { generateLicenseKey, planSeats, planExpiry } = require('../utils/license');

router.get(
  '/plans',
  asyncHandler(async (req, res) => ok(res, PLANS))
);

router.post(
  '/checkout', requireAuth, validate(checkoutSchema),
  asyncHandler(async (req, res) => {
    const { plan, billingCycle } = req.body;
    const session = await stripe.createCheckoutSession({
      plan, billingCycle, user: req.user,
      successUrl: `${config.FRONTEND_URL}/billing`,
      cancelUrl: `${config.FRONTEND_URL}/pricing`,
    });
    return ok(res, { url: session.url });
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

    if (subscription.stripe_subscription_id)
      await stripe.cancelSubscription(subscription.stripe_subscription_id);

    await Subscription.update(subscription.id, { status: 'cancelled' });
    const sub = await Subscription.findById(subscription.id);
    return ok(res, { plan: sub.plan, status: sub.status, expiryDate: sub.expiry_date, seats: sub.seats });
  })
);

router.get(
  '/status', requireAuth,
  asyncHandler(async (req, res) => {
    const sub = await Subscription.findActiveByUserId(req.user.id) ||
                (await Subscription.findByUserId(req.user.id))[0];
    if (!sub) return fail(res, 'NOT_FOUND', 'No subscription found', 404);
    return ok(res, { plan: sub.plan, status: sub.status, expiryDate: sub.expiry_date, seats: sub.seats });
  })
);

module.exports = router;
