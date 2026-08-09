'use strict';

const config = require('../config/env');

// Same function names in mock + real mode so route handlers are agnostic.
let impl;

if (config.isStripeMock) {
  // ── MOCK ──────────────────────────────────────────────────
  impl = {
    mock: true,
    async createCheckoutSession({ plan, billingCycle, user, successUrl, cancelUrl }) {
      void billingCycle;
      void user;
      void cancelUrl;
      return {
        url: `${successUrl}?mock_success=1&plan=${encodeURIComponent(plan)}&billingCycle=${encodeURIComponent(billingCycle)}`,
        id: `cs_mock_${Date.now()}`,
      };
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
    async createCheckoutSession({ plan, billingCycle, user, successUrl, cancelUrl }) {
      const catalog = PLANS[plan];
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
      });
      return { url: session.url, id: session.id };
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
