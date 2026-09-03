'use strict';

const config = require('../config/env');

// Same function names in every mode so route handlers are agnostic.
//
// Three modes, decided in config/env.js#stripeMode:
//   live     — the real Stripe client, signatures verified.
//   mock     — LOCAL development only. constructEvent is JSON.parse, so an
//              unsigned POST is a "webhook"; that is fine on a laptop and
//              catastrophic on a public box, which is why env.js never picks
//              this mode for one.
//   disabled — a hardened deployment with no STRIPE_SECRET_KEY. Nothing is
//              pretended: every billing operation throws a 503 the routes
//              (and the error handler) turn into BILLING_UNAVAILABLE, and the
//              webhook is refused outright.
let impl;

function billingUnavailable() {
  throw Object.assign(new Error('Billing is not configured on this server'), {
    status: 503, code: 'BILLING_UNAVAILABLE',
  });
}

if (config.isBillingDisabled) {
  // ── DISABLED ──────────────────────────────────────────────
  impl = {
    mock: false,
    disabled: true,
    async createCheckoutSession() { return billingUnavailable(); },
    // "Nothing to manage" is the truthful answer; the route already handles it.
    async createPortalSession() { return { url: null }; },
    async findPromotionCode() { return null; },
    constructEvent() { return billingUnavailable(); },
    async cancelSubscription() { return billingUnavailable(); },
    async resumeSubscription() { return billingUnavailable(); },
  };
} else if (config.isStripeMock) {
  // ── MOCK (local development only) ─────────────────────────
  impl = {
    mock: true,
    disabled: false,
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
    // Mirrors the real signature: cancelling at period end leaves the
    // subscription ACTIVE and merely stops the next renewal.
    async cancelSubscription(id, { atPeriodEnd = true } = {}) {
      return atPeriodEnd
        ? { id, status: 'active', cancel_at_period_end: true }
        : { id, status: 'canceled', cancel_at_period_end: false };
    },
    async resumeSubscription(id) {
      return { id, status: 'active', cancel_at_period_end: false };
    },
  };
} else {
  // ── REAL ──────────────────────────────────────────────────
  const Stripe = require('stripe');
  const stripe = new Stripe(config.STRIPE_SECRET_KEY);
  const { PLANS } = require('../config/plans');

  impl = {
    mock: false,
    disabled: false,
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
        metadata: { userId: String(user.id), plan, billingCycle },
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
    /**
     * Stop the subscription.
     *
     * Cancelling at PERIOD END is the default and the only thing the website
     * offers: the customer has paid for the current period and keeps it. An
     * immediate cancel deletes access on the spot and is reserved for account
     * deletion, where there is no period left to honour.
     */
    async cancelSubscription(id, { atPeriodEnd = true } = {}) {
      return atPeriodEnd
        ? stripe.subscriptions.update(id, { cancel_at_period_end: true })
        : stripe.subscriptions.cancel(id);
    },

    /** Undo a pending cancellation while the period is still running. */
    async resumeSubscription(id) {
      return stripe.subscriptions.update(id, { cancel_at_period_end: false });
    },
  };
}

module.exports = impl;
