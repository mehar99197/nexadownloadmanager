'use strict';

const config = require('../config/env');

// The Stripe API version this codebase is written against. It is what the
// SDK 16 default was, so pinning it changed nothing at the time it was added —
// the point is that it cannot change by accident afterwards.
const STRIPE_API_VERSION = '2024-06-20';

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
  // The API version is PINNED, not left to the SDK's default.
  //
  // Without this, `npm update stripe` silently changes the version header, and
  // with it the shape of every object Stripe sends us. That is not a
  // hypothetical: 2025-03-31.basil moved `invoice.subscription` into
  // `invoice.parent.subscription_details.subscription` and the line item's
  // price into `pricing.price_details`. utils/stripeInvoice.js reads both
  // shapes, so it would survive — but nothing else should have to be written
  // that defensively because a dependency bump moved the goalposts.
  //
  // Upgrading the API version is a deliberate change that needs testing against
  // Stripe itself, in test mode, with the webhook suite. Upgrading the SDK — for
  // its security fixes and Node support — should not drag that along with it.
  const stripe = new Stripe(config.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
  const { PLANS } = require('../config/plans');

  impl = {
    mock: false,
    disabled: false,
    async createCheckoutSession({ plan, billingCycle, user, successUrl, cancelUrl, couponCode, customerId }) {
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
        // An existing Stripe Customer is reused; `customer_email` alone makes
        // Stripe create a new Customer on every checkout. Stripe refuses a
        // session that names both, so it is one or the other.
        ...(customerId ? { customer: customerId } : { customer_email: user.email }),
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

// Exported so a test can assert the pin is still there and still what the
// webhook handlers were written against. An accidental `npm update stripe` that
// unpinned it would otherwise change every payload shape with nothing to notice
// it by until a renewal was mishandled.
impl.apiVersion = STRIPE_API_VERSION;

module.exports = impl;
