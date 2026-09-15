'use strict';

const config = require('../config/env');

// Same function names in mock + real mode so route handlers are agnostic.
let impl;

if (config.isStripeMock) {
  // ── MOCK ──────────────────────────────────────────────────
  impl = {
    mock: true,
    async createCheckoutSession({ plan, billingCycle, user, successUrl, cancelUrl, couponCode }) {
      void user;
      void cancelUrl;
      const coupon = couponCode ? `&coupon=${encodeURIComponent(couponCode)}` : '';
      return {
        url: `${successUrl}?mock_success=1&plan=${encodeURIComponent(plan)}&billingCycle=${encodeURIComponent(billingCycle)}${coupon}`,
        id: `cs_mock_${Date.now()}`,
      };
    },
    // Mock mode has no hosted portal; the caller falls back to /billing.
    async createPortalSession() {
      return { url: null };
    },
    async findPromotionCode(code) {
      // Accept a single obvious test code so the flow can be exercised offline.
      return code && code.toUpperCase() === 'NEXA10'
        ? { id: 'promo_mock', code: code.toUpperCase(), percentOff: 10 }
        : null;
    },
    constructEvent(raw, sig) {
      void sig;
      const body = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
      return JSON.parse(body);
    },
    async cancelSubscription(id) {
      return { id, status: 'canceled' };
    },
    async cancelAtPeriodEnd(id) {
      return { id, status: 'active', cancel_at_period_end: true };
    },
  };
} else {
  // ── REAL ──────────────────────────────────────────────────
  const Stripe = require('stripe');
  const stripe = new Stripe(config.STRIPE_SECRET_KEY);
  const { PLANS } = require('../config/plans');

  impl = {
    mock: false,
    async createCheckoutSession({ plan, billingCycle, user, successUrl, cancelUrl, couponCode }) {
      const catalog = PLANS[plan];
      // A bad code must not silently become "no discount": the route validates
      // it first and reports INVALID_COUPON, so by here it either resolves or
      // was never supplied.
      let promotionCodeId = null;
      if (couponCode) {
        const promo = await impl.findPromotionCode(couponCode);
        promotionCodeId = promo ? promo.id : null;
      }
      const unitAmount =
        (billingCycle === 'yearly' ? catalog.yearly : catalog.monthly) * 100;
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer_email: user.email,
        line_items: [
          {
            price_data: {
              currency: 'usd',
              recurring: { interval: billingCycle === 'yearly' ? 'year' : 'month' },
              product_data: { name: `NexaDownloadManager ${catalog.name}` },
              unit_amount: unitAmount,
            },
            quantity: 1,
          },
        ],
        metadata: { userId: String(user._id || user.id), plan, billingCycle },
        // Copied onto the Stripe subscription itself, so every later invoice
        // (renewals arrive as invoice.paid, not as a checkout session) still
        // says which plan and cycle it is for.
        subscription_data: { metadata: { userId: String(user._id || user.id), plan, billingCycle } },
        success_url: successUrl,
        cancel_url: cancelUrl,
        // Let Stripe apply a promotion code: either the one the user typed
        // (validated first) or its own "have a code?" field on the page.
        ...(promotionCodeId
          ? { discounts: [{ promotion_code: promotionCodeId }] }
          : { allow_promotion_codes: true }),
      });
      return { url: session.url, id: session.id };
    },

    // Stripe's hosted billing portal: card changes, invoices, cancellation.
    async createPortalSession({ customerId, returnUrl }) {
      if (!customerId) return { url: null };
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId, return_url: returnUrl,
      });
      return { url: session.url };
    },

    // Resolve a user-typed code to an active promotion code, or null.
    async findPromotionCode(code) {
      if (!code) return null;
      const found = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
      const promo = found.data[0];
      if (!promo) return null;
      return {
        id: promo.id,
        code: promo.code,
        percentOff: promo.coupon?.percent_off || null,
        amountOff: promo.coupon?.amount_off ? promo.coupon.amount_off / 100 : null,
      };
    },
    constructEvent(raw, sig) {
      return stripe.webhooks.constructEvent(raw, sig, config.STRIPE_WEBHOOK_SECRET);
    },
    // Immediate: used when the account itself is deleted.
    async cancelSubscription(id) {
      return stripe.subscriptions.cancel(id);
    },
    // What "Cancel subscription" on the billing page means: no further renewal,
    // access until the end of the period already paid for. Stripe then emits
    // customer.subscription.deleted at that point, which marks the row cancelled.
    async cancelAtPeriodEnd(id) {
      return stripe.subscriptions.update(id, { cancel_at_period_end: true });
    },
  };
}

module.exports = impl;
