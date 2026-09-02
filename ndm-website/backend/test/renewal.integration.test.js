'use strict';

/**
 * Subscription renewals, end to end against a real database.
 *
 * This is the bug these tests exist for: `expiry_date` was written once, at
 * checkout, and no handler ever moved it. A monthly subscriber therefore
 * validated as `expired` on day 31 while Stripe kept charging them — and the
 * desktop client DELETES a licence key it is told is expired, so the customer
 * lost their key and their plan while paying for both.
 *
 * Stripe runs in mock mode here (no STRIPE_SECRET_KEY), where `constructEvent`
 * is `JSON.parse` — so a webhook is just a POST of the event body.
 */
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const srv = require('./helpers/testServer');

const DEVICE = 'a'.repeat(64);

const seconds = (date) => Math.floor(date.getTime() / 1000);
const daysFromNow = (n) => new Date(Date.now() + n * 86400000);

function checkoutEvent({ id, email, plan = 'pro', billingCycle = 'monthly' }) {
  return {
    id, type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${id}`, customer: 'cus_renewal', subscription: 'sub_renewal',
        payment_intent: `pi_${id}`, customer_email: email, currency: 'usd',
        amount_total: billingCycle === 'yearly' ? 4500 : 500,
        metadata: { plan, billingCycle },
      },
    },
  };
}

function renewalEvent({ id, periodEnd, interval = 'month', amount = 500 }) {
  return {
    id, type: 'invoice.payment_succeeded',
    data: {
      object: {
        id: `in_${id}`, object: 'invoice', billing_reason: 'subscription_cycle',
        subscription: 'sub_renewal', customer: 'cus_renewal',
        payment_intent: `pi_${id}`, currency: 'usd', amount_paid: amount,
        lines: {
          data: [{
            period: { start: seconds(new Date()), end: seconds(periodEnd) },
            price: { recurring: { interval } },
          }],
        },
      },
    },
  };
}

/** POST a Stripe event at the raw webhook endpoint. */
function sendEvent(api, event) {
  return api.post('/api/webhooks/stripe', event, {
    headers: { 'stripe-signature': 'mock' },
  });
}

test('subscription renewals', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();
  await srv.reset();

  const api = srv.client();
  const user = await srv.makeUser(api, 'renewal');
  const licenseKey = (await api.get('/api/user/license', { token: user.token })).body.data.licenseKey;

  await t.test('checkout activates the plan with a bounded expiry', async () => {
    const res = await sendEvent(api, checkoutEvent({ id: 'evt_checkout_1', email: user.email }));
    assert.equal(res.status, 200);
    const [row] = await srv.query('SELECT plan, expiry_date FROM subscriptions WHERE license_key = ?', [licenseKey]);
    assert.equal(row.plan, 'pro');
    // A month out, not the free plan's century.
    assert.ok(new Date(row.expiry_date).getTime() < Date.now() + 60 * 86400000);
  });

  await t.test('once that period lapses the plan falls back to Free', async () => {
    // Past the grace period that absorbs a slow renewal webhook — see
    // utils/license.js#PAID_GRACE_DAYS. Free, not `expired`: the desktop client
    // deletes a key it is told is expired.
    await srv.query('UPDATE subscriptions SET expiry_date = ? WHERE license_key = ?',
      [daysFromNow(-10), licenseKey]);
    const res = await api.post('/api/license/validate',
      { license_key: licenseKey, device_fingerprint: DEVICE });
    assert.equal(res.status, 200);
    assert.equal(res.body.valid, true);
    assert.equal(res.body.plan, 'free');
  });

  await t.test('a paid renewal pushes the expiry to the period Stripe billed', async () => {
    const periodEnd = daysFromNow(30);
    const res = await sendEvent(api, renewalEvent({ id: 'evt_renewal_1', periodEnd }));
    assert.equal(res.status, 200);
    assert.equal(res.body.received, true);

    const [row] = await srv.query(
      'SELECT plan, status, expiry_date FROM subscriptions WHERE license_key = ?', [licenseKey]);
    assert.equal(row.plan, 'pro', 'the renewal restores the paid plan');
    assert.equal(row.status, 'active');
    // Stripe's own period end, to the second — not a locally recomputed guess.
    assert.equal(Math.floor(new Date(row.expiry_date).getTime() / 1000), seconds(periodEnd));
  });

  await t.test('and the licence works again', async () => {
    const res = await api.post('/api/license/validate',
      { license_key: licenseKey, device_fingerprint: DEVICE });
    assert.equal(res.body.valid, true);
    assert.equal(res.body.plan, 'pro');
    assert.ok(res.body.token);
  });

  await t.test('the renewal is recorded as a payment, exactly once', async () => {
    // Stripe retries deliveries; the event ledger must make the second a no-op.
    const again = await sendEvent(api, renewalEvent({ id: 'evt_renewal_1', periodEnd: daysFromNow(30) }));
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);

    const rows = await srv.query(
      "SELECT amount, plan, billing_cycle, status FROM payments WHERE stripe_payment_id = 'pi_evt_renewal_1'");
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].amount), 5);
    assert.equal(rows[0].plan, 'pro');
    assert.equal(rows[0].billing_cycle, 'monthly');
    assert.equal(rows[0].status, 'paid');
  });

  await t.test('a yearly renewal is read off the line item, not from metadata', async () => {
    const periodEnd = daysFromNow(365);
    await sendEvent(api, renewalEvent({
      id: 'evt_renewal_yearly', periodEnd, interval: 'year', amount: 4500,
    }));
    const [payment] = await srv.query(
      "SELECT amount, billing_cycle FROM payments WHERE stripe_payment_id = 'pi_evt_renewal_yearly'");
    assert.equal(payment.billing_cycle, 'yearly');
    assert.equal(Number(payment.amount), 45);
    const [row] = await srv.query('SELECT expiry_date FROM subscriptions WHERE license_key = ?', [licenseKey]);
    assert.equal(Math.floor(new Date(row.expiry_date).getTime() / 1000), seconds(periodEnd));
  });

  await t.test('a failed renewal is recorded without touching the subscription', async () => {
    const before = (await srv.query('SELECT status, expiry_date FROM subscriptions WHERE license_key = ?', [licenseKey]))[0];
    const res = await sendEvent(api, {
      id: 'evt_failed_1', type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_failed', object: 'invoice', subscription: 'sub_renewal',
          customer: 'cus_renewal', payment_intent: 'pi_failed', currency: 'usd',
          amount_due: 500,
          lines: { data: [{ price: { recurring: { interval: 'month' } } }] },
        },
      },
    });
    // Reading the plan from invoice.metadata used to throw here, so the handler
    // 500'd and Stripe retried the event for days while nothing was recorded.
    assert.equal(res.status, 200);

    const [payment] = await srv.query(
      "SELECT status, plan FROM payments WHERE stripe_payment_id = 'pi_failed'");
    assert.equal(payment.status, 'failed');
    assert.equal(payment.plan, 'pro');

    const after = (await srv.query('SELECT status, expiry_date FROM subscriptions WHERE license_key = ?', [licenseKey]))[0];
    assert.equal(after.status, before.status);
    assert.equal(String(after.expiry_date), String(before.expiry_date));
  });

  await srv.stop();
});
