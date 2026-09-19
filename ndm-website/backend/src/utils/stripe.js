'use strict';

const config = require('../config/env');

// Same function names in mock + real mode so route handlers are agnostic.
let impl;

if (config.isBillingDisabled) {
  // ── DISABLED ──────────────────────────────────────────────────
  // A real deployment with no Stripe account yet. Mock mode is NOT an option
  // here: its checkout grants a paid plan for free. Every entry point that
  // would move money or trust an event fails closed instead.
  const unavailable = () => {
    const err = new Error('Billing is not available on this deployment');
    err.status = 503;
    err.code = 'BILLING_UNAVAILABLE';
    throw err;
  };
  impl = {
    mock: false,
    disabled: true,
    async createCheckoutSession() { return unavailable(); },
    // Nothing to manage and no hosted portal to send anyone to; the caller
    // already treats url:null as "stay on /billing".
    async createPortalSession() { return { url: null }; },
    // Not "no such code" - the whole coupon feature is off, and reporting it
    // as an invalid code would send the user hunting for a better one.
    async findPromotionCode() { return unavailable(); },
    // No signing secret exists, so no event can be authenticated. Refusing is
    // the only safe answer: a forged event here would hand out a paid plan.
    constructEvent() { return unavailable(); },
    // Disabled implies no Stripe account at all (see config/env.js), so no
    // remote subscription can still be charging and the local status change is
    // the entire cancellation. Throwing would only trap the user on a plan.
    async cancelSubscription(id) { return { id, status: 'canceled' }; },
  };
} else if (config.isStripeMock) {
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
    async cancelSubscription(id) {
      return stripe.subscriptions.cancel(id);
    },
  };
}

module.exports = impl;
