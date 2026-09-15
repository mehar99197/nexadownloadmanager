'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const invoice = require('../src/utils/stripeInvoice');

// Stripe sends period bounds as unix SECONDS.
const PERIOD_END = Math.floor(Date.parse('2026-10-01T00:00:00.000Z') / 1000);

/** A monthly renewal invoice in the shape the pinned API version sends. */
function renewal(overrides = {}, lineOverrides = {}) {
  return {
    id: 'in_1',
    object: 'invoice',
    billing_reason: 'subscription_cycle',
    subscription: 'sub_123',
    customer: 'cus_123',
    payment_intent: 'pi_123',
    currency: 'usd',
    amount_paid: 500,
    amount_due: 500,
    hosted_invoice_url: 'https://invoice.stripe.com/i/abc',
    lines: {
      data: [{
        period: { start: PERIOD_END - 30 * 86400, end: PERIOD_END },
        price: { recurring: { interval: 'month' } },
        ...lineOverrides,
      }],
    },
    ...overrides,
  };
}

test('reads the subscription id from every shape Stripe has used for it', () => {
  assert.equal(invoice.subscriptionId(renewal()), 'sub_123');

  // Newer API versions moved it under parent.subscription_details.
  assert.equal(invoice.subscriptionId(renewal({
    subscription: undefined,
    parent: { subscription_details: { subscription: 'sub_new' } },
  })), 'sub_new');

  // …and older ones only carried it on the line item.
  assert.equal(invoice.subscriptionId(renewal({ subscription: undefined }, { subscription: 'sub_line' })), 'sub_line');

  assert.equal(invoice.subscriptionId({}), null);
  assert.equal(invoice.subscriptionId(null), null);
});

test('reads the billing cycle from the line item, never from metadata', () => {
  assert.equal(invoice.billingCycle(renewal()), 'monthly');
  assert.equal(invoice.billingCycle(renewal({}, { price: { recurring: { interval: 'year' } } })), 'yearly');
  assert.equal(invoice.billingCycle(renewal({}, { price: undefined, plan: { interval: 'year' } })), 'yearly');
  assert.equal(
    invoice.billingCycle(renewal({}, {
      price: undefined, pricing: { price_details: { recurring: { interval: 'year' } } },
    })),
    'yearly'
  );
  // An invoice carries none of the Checkout Session's metadata; a shape we do
  // not recognise falls back rather than guessing.
  assert.equal(invoice.billingCycle({ metadata: { billingCycle: 'yearly' } }), 'monthly');
  assert.equal(invoice.billingCycle({}, 'yearly'), 'yearly');
});

test("takes Stripe's own period end so our expiry cannot drift from their clock", () => {
  assert.equal(invoice.periodEnd(renewal()).toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(invoice.periodEnd({ period_end: PERIOD_END }).toISOString(), '2026-10-01T00:00:00.000Z');
  // No usable period: the caller falls back to planExpiry(), so this must be null.
  assert.equal(invoice.periodEnd({}), null);
  assert.equal(invoice.periodEnd(renewal({}, { period: { end: null } })), null);
  assert.equal(invoice.periodEnd(renewal({}, { period: { end: 'soon' } })), null);
});

test('amount is reported in major units, preferring what was actually paid', () => {
  assert.equal(invoice.amount(renewal()), 5);
  assert.equal(invoice.amount({ amount_due: 4500 }), 45);
  assert.equal(invoice.amount({ amount: 1500 }), 15);
  assert.equal(invoice.amount({}), 0);
});

test('the payments idempotency key is the intent, falling back to the invoice id', () => {
  assert.equal(invoice.paymentId(renewal()), 'pi_123');
  assert.equal(invoice.paymentId(renewal({ payment_intent: null })), 'in_1');
  assert.equal(invoice.paymentId({}), null);
});

test('only a real cycle is a renewal, so the first invoice is not thanked twice', () => {
  assert.equal(invoice.isRenewal(renewal()), true);
  assert.equal(invoice.isRenewal(renewal({ billing_reason: 'subscription_create' })), false);
  assert.equal(invoice.isRenewal(renewal({ billing_reason: 'subscription_update' })), false);
  // An unlabelled invoice is treated as a renewal: a missing receipt is worse
  // than a duplicate one, and checkout always labels its own.
  assert.equal(invoice.isRenewal({}), true);
});

test('invoiceUrl points at the real invoice when Stripe hosts one', () => {
  assert.equal(invoice.invoiceUrl(renewal()), 'https://invoice.stripe.com/i/abc');
  assert.equal(invoice.invoiceUrl({}), null);
});

/* ------------------------------------------------ subscription objects ---- */

const { PLANS } = require('../src/config/plans');

/** A subscription object as customer.subscription.updated delivers it. */
function subscription(overrides = {}, price = { unit_amount: 500, recurring: { interval: 'month' } }) {
  return {
    id: 'sub_1', object: 'subscription', status: 'active',
    customer: 'cus_1', cancel_at_period_end: false,
    current_period_end: Math.floor(Date.parse('2026-11-01T00:00:00.000Z') / 1000),
    items: { data: [{ price }] },
    ...overrides,
  };
}

test('a subscription is matched to one of our plans by its price, or to none', () => {
  assert.equal(invoice.planFromSubscription(subscription(), PLANS), 'pro');
  assert.equal(invoice.planFromSubscription(
    subscription({}, { unit_amount: 4500, recurring: { interval: 'year' } }), PLANS), 'pro');
  assert.equal(invoice.planFromSubscription(
    subscription({}, { unit_amount: 1500, recurring: { interval: 'month' } }), PLANS), 'team');
  assert.equal(invoice.planFromSubscription(
    subscription({}, { unit_amount: 13500, recurring: { interval: 'year' } }), PLANS), 'team');

  // A price we do not recognise resolves to null so the caller LEAVES the
  // stored plan alone — guessing here would silently downgrade a customer.
  assert.equal(invoice.planFromSubscription(
    subscription({}, { unit_amount: 999, recurring: { interval: 'month' } }), PLANS), null);
  assert.equal(invoice.planFromSubscription(subscription({}, {}), PLANS), null);
  assert.equal(invoice.planFromSubscription({}, PLANS), null);

  // The legacy `plan` shape, still sent by older API versions.
  assert.equal(invoice.planFromSubscription(
    { items: { data: [{ plan: { amount: 500, interval: 'month' } }] } }, PLANS), 'pro');
});

test('subscription period end and cycle read across API shapes', () => {
  assert.equal(invoice.subscriptionPeriodEnd(subscription()).toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(invoice.subscriptionPeriodEnd(subscription({ current_period_end: undefined })), null);
  assert.equal(invoice.subscriptionCycle(subscription()), 'monthly');
  assert.equal(invoice.subscriptionCycle(
    subscription({}, { recurring: { interval: 'year' } })), 'yearly');
});

test('a retrying payment does not end access; only a real cancellation does', () => {
  assert.equal(invoice.statusFromSubscription(subscription()), 'active');
  assert.equal(invoice.statusFromSubscription(subscription({ status: 'trialing' })), 'active');
  // Stripe retries these for days — cutting somebody off on the first bounce
  // would be wrong, so they map to "leave it alone".
  assert.equal(invoice.statusFromSubscription(subscription({ status: 'past_due' })), null);
  assert.equal(invoice.statusFromSubscription(subscription({ status: 'unpaid' })), null);
  assert.equal(invoice.statusFromSubscription(subscription({ status: 'canceled' })), 'cancelled');
  assert.equal(invoice.statusFromSubscription(subscription({ status: 'incomplete_expired' })), 'cancelled');
});
