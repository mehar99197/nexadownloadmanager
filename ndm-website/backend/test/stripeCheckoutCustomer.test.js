'use strict';

/**
 * The live Checkout Session must reuse the customer's existing Stripe Customer.
 *
 * It used to be created with `customer_email` only, and Stripe answers that by
 * making a brand-new Customer every time. A returning (or upgrading) customer
 * therefore ended up with two Customers and — before /checkout refused a billed
 * account — two subscriptions charging in parallel, the second one invisible to
 * the billing portal opened for the first.
 *
 * This loads utils/stripe.js in LIVE mode against a fake `stripe` package (node
 * --test runs each file in its own process, so the env and the require-cache
 * swap cannot leak into another suite) and records what would be sent.
 */
process.env.NODE_ENV = 'test';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key_for_unit_tests';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake';

const test = require('node:test');
const assert = require('node:assert/strict');

const created = [];
function FakeStripe() {
  return {
    checkout: { sessions: { create: async (params) => { created.push(params); return { id: 'cs_fake', url: 'https://checkout.stripe.test/cs_fake' }; } } },
    promotionCodes: { list: async () => ({ data: [] }) },
    billingPortal: { sessions: { create: async () => ({ url: null }) } },
    subscriptions: { update: async () => ({}), cancel: async () => ({}) },
    webhooks: { constructEvent: () => ({}) },
  };
}
require.cache[require.resolve('stripe')] = {
  id: require.resolve('stripe'), filename: require.resolve('stripe'), loaded: true, exports: FakeStripe,
};

const stripe = require('../src/utils/stripe');

const user = { id: 7, email: 'buyer@example.test' };
const base = { plan: 'pro', billingCycle: 'monthly', user, successUrl: 'https://s', cancelUrl: 'https://c' };

test('the live client is the one under test', () => {
  assert.equal(stripe.mock, false);
  assert.equal(stripe.disabled, false);
});

test('a known Stripe customer is reused, not recreated from the email', async () => {
  created.length = 0;
  await stripe.createCheckoutSession({ ...base, customerId: 'cus_existing' });
  assert.equal(created.length, 1);
  assert.equal(created[0].customer, 'cus_existing');
  // Stripe rejects a session that names both.
  assert.equal('customer_email' in created[0], false);
  assert.equal(created[0].mode, 'subscription');
  assert.equal(created[0].metadata.userId, '7');
});

test('a first-time buyer is still identified by email', async () => {
  created.length = 0;
  await stripe.createCheckoutSession({ ...base });
  assert.equal(created[0].customer_email, 'buyer@example.test');
  assert.equal('customer' in created[0], false);
});
