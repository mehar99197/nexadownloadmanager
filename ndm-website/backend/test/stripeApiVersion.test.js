'use strict';

/**
 * The Stripe API version must stay pinned, and stay the one this codebase was
 * written against.
 *
 * Stripe's SDK carries its own default version, so upgrading the package
 * changes the shape of every object the webhooks receive. Between the SDK we
 * were on and the one we are on now that default moved by more than two years:
 * 2025-03-31.basil alone relocated `invoice.subscription` into
 * `invoice.parent.subscription_details.subscription` and the line item's price
 * into `pricing.price_details`. A silent move like that does not throw — it
 * reads `undefined`, stores a null, and a renewal is mishandled weeks later.
 *
 * Upgrading the API version is fine; doing it by accident is not.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const stripe = require('../src/utils/stripe');

// The version the webhook handlers and utils/stripeInvoice.js were written for.
// Changing this line means going through those readers deliberately.
const EXPECTED = '2024-06-20';

test('the Stripe API version is pinned to the one the handlers expect', () => {
  assert.equal(stripe.apiVersion, EXPECTED);
});

test('the SDK honours the pin rather than its own newer default', () => {
  const Stripe = require('stripe');
  // Read the SDK's own default through the public API rather than reaching
  // into the package's internals, which its exports map does not allow.
  const sdkDefault = new Stripe('sk_test_not_a_real_key').getApiField('version');
  const client = new Stripe('sk_test_not_a_real_key', { apiVersion: stripe.apiVersion });

  assert.equal(client.getApiField('version'), EXPECTED);
  // If these ever match, the pin has stopped doing anything and this test is
  // no longer proving what it claims to.
  assert.notEqual(
    sdkDefault, EXPECTED,
    'the SDK default now equals the pin — re-check that the pin is still load-bearing'
  );
});

test('every Stripe call the app makes still exists on this SDK', () => {
  const Stripe = require('stripe');
  const client = new Stripe('sk_test_not_a_real_key', { apiVersion: stripe.apiVersion });
  // Named individually rather than looped over a list built from the SDK: the
  // point is to fail when the SDK drops one of OURS, not to describe the SDK.
  assert.equal(typeof client.webhooks.constructEvent, 'function');
  assert.equal(typeof client.checkout.sessions.create, 'function');
  assert.equal(typeof client.billingPortal.sessions.create, 'function');
  assert.equal(typeof client.subscriptions.update, 'function');
  assert.equal(typeof client.subscriptions.cancel, 'function');
  assert.equal(typeof client.promotionCodes.list, 'function');
});
