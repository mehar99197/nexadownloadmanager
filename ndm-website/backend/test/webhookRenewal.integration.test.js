'use strict';

/**
 * H-04 — a paying customer must stay paid up.
 *
 * checkout.session.completed wrote expiry_date once, at purchase, and nothing
 * ever moved it: Stripe charged the card again on day 30, reported it, nobody
 * listened, and from day 31 /license/validate answered `expired` while the
 * card kept being charged. Latent today only because billing is disabled in
 * production — it is the first thing that breaks the day Stripe goes live.
 *
 * Driven through the real webhook route in mock billing mode (the test
 * environment has no Stripe key, so constructEvent() is JSON.parse and the
 * signature step is skipped — everything after it is production code: the
 * replay table, the handlers, the SQL). Each case ends by asking
 * /license/validate, because "the desktop app is handed a Pro token again" is
 * the only outcome that matters.
 */
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const srv = require('./helpers/testServer');
const Subscription = require('../src/models/Subscription');
const { generateLicenseKey } = require('../src/utils/license');

const DAY = 24 * 60 * 60 * 1000;
const unix = (date) => Math.floor(date.getTime() / 1000);

let eventSeq = 0;
function event(type, object) {
  eventSeq += 1;
  return { id: `evt_test_${Date.now()}_${eventSeq}`, type, data: { object } };
}

async function deliver(api, evt) {
  return api.post('/api/webhooks/stripe', evt);
}

async function validate(api, licenseKey) {
  const res = await api.post('/api/license/validate',
    { license_key: licenseKey, device_fingerprint: 'a'.repeat(64) });
  return res.body;
}

async function paymentsFor(userId) {
  return srv.query(
    'SELECT stripe_payment_id, status, plan, billing_cycle, amount FROM payments WHERE user_id = ? ORDER BY id',
    [userId]
  );
}

test('Stripe renewals and plan changes reach the subscription', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();
  await srv.reset();
  const api = srv.client();

  // A Pro subscriber whose first month has run out — exactly the day-31 state.
  const { email } = await srv.makeUser(api, 'renewal');
  const [{ id: userId }] = await srv.query('SELECT id FROM users WHERE email = ?', [email]);
  const [free] = await Subscription.findByUserId(userId);
  const licenseKey = generateLicenseKey();
  await Subscription.update(free.id, {
    plan: 'pro', status: 'active', licenseKey, seats: 1,
    startDate: new Date(Date.now() - 31 * DAY), expiryDate: new Date(Date.now() - DAY),
    stripeSubscriptionId: 'sub_renewal_1', stripeCustomerId: 'cus_renewal_1',
  });
  const subId = free.id;

  await t.test('the lapsed subscription is refused, as the audit found', async () => {
    const res = await validate(api, licenseKey);
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'expired');
  });

  const periodEnd = new Date(Date.now() + 30 * DAY);

  // What Stripe sends on the monthly charge. Shape per the current API:
  // the subscription under `parent`, the plan in the subscription metadata
  // (put there by checkout — utils/stripe.js), the service period on the line.
  const renewalInvoice = {
    id: 'in_renewal_1', object: 'invoice', billing_reason: 'subscription_cycle',
    customer: 'cus_renewal_1', customer_email: email, currency: 'usd',
    amount_paid: 500, amount_due: 500, payment_intent: 'pi_renewal_1',
    parent: { subscription_details: { subscription: 'sub_renewal_1', metadata: { plan: 'pro', billingCycle: 'monthly' } } },
    lines: { data: [{ period: { start: unix(new Date()), end: unix(periodEnd) },
      price: { recurring: { interval: 'month' } } }] },
  };

  await t.test('invoice.payment_succeeded extends the plan and records the payment', async () => {
    const res = await deliver(api, event('invoice.payment_succeeded', renewalInvoice));
    assert.equal(res.status, 200, res.text);

    const sub = await Subscription.findById(subId);
    assert.equal(sub.status, 'active');
    assert.equal(sub.plan, 'pro');
    // Paid through the period end plus the retry grace, to the second.
    const expected = periodEnd.getTime() + 3 * DAY;
    assert.ok(Math.abs(new Date(sub.expiry_date).getTime() - expected) < 2000,
      `expiry ${sub.expiry_date} is not period end + 3 days`);

    const payments = await paymentsFor(userId);
    assert.equal(payments.length, 1);
    assert.equal(payments[0].stripe_payment_id, 'pi_renewal_1');
    assert.equal(payments[0].status, 'paid');
    assert.equal(payments[0].plan, 'pro');
    assert.equal(payments[0].billing_cycle, 'monthly');
    assert.equal(Number(payments[0].amount), 5);

    const check = await validate(api, licenseKey);
    assert.equal(check.valid, true, 'the desktop app gets its Pro licence back: ' + JSON.stringify(check));
    assert.equal(check.plan, 'pro');
  });

  await t.test('a redelivery and its invoice.paid twin change nothing', async () => {
    const same = event('invoice.payment_succeeded', renewalInvoice);
    const first = await deliver(api, same);
    assert.equal(first.status, 200);
    const again = await deliver(api, same);
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true, 'the replay table catches an identical redelivery');

    // Stripe sends both event types for one payment; either alone suffices
    // and the pair must not count twice.
    const twin = await deliver(api, event('invoice.paid', renewalInvoice));
    assert.equal(twin.status, 200, twin.text);
    assert.equal((await paymentsFor(userId)).length, 1, 'one payment, however many events describe it');
  });

  await t.test('the first invoice of a subscription is left to the checkout handler', async () => {
    const before = await Subscription.findById(subId);
    const res = await deliver(api, event('invoice.payment_succeeded', {
      ...renewalInvoice, id: 'in_first', billing_reason: 'subscription_create',
      payment_intent: 'pi_first', lines: { data: [{ period: { end: unix(new Date(Date.now() + 400 * DAY)) } }] },
    }));
    assert.equal(res.status, 200);
    const after = await Subscription.findById(subId);
    assert.equal(String(after.expiry_date), String(before.expiry_date), 'not extended');
    assert.equal((await paymentsFor(userId)).length, 1, 'not recorded twice');
  });

  await t.test('an older API shape (subscription on the invoice itself) is read too', async () => {
    const legacyEnd = new Date(Date.now() + 60 * DAY);
    const res = await deliver(api, event('invoice.payment_succeeded', {
      id: 'in_renewal_2', object: 'invoice', billing_reason: 'subscription_cycle',
      customer: 'cus_renewal_1', currency: 'usd', amount_paid: 500, payment_intent: 'pi_renewal_2',
      subscription: 'sub_renewal_1',
      subscription_details: { metadata: { plan: 'pro', billingCycle: 'monthly' } },
      lines: { data: [{ period: { end: unix(legacyEnd) }, plan: { interval: 'month' } }] },
    }));
    assert.equal(res.status, 200, res.text);
    const sub = await Subscription.findById(subId);
    assert.ok(Math.abs(new Date(sub.expiry_date).getTime() - (legacyEnd.getTime() + 3 * DAY)) < 2000);
    assert.equal((await paymentsFor(userId)).length, 2);
  });

  await t.test('customer.subscription.updated mirrors a plan change made in the portal', async () => {
    const teamEnd = new Date(Date.now() + 365 * DAY);
    const res = await deliver(api, event('customer.subscription.updated', {
      id: 'sub_renewal_1', object: 'subscription', customer: 'cus_renewal_1', status: 'active',
      metadata: { userId: String(userId), plan: 'team', billingCycle: 'yearly' },
      items: { data: [{ current_period_end: unix(teamEnd), price: { recurring: { interval: 'year' } } }] },
    }));
    assert.equal(res.status, 200, res.text);
    const sub = await Subscription.findById(subId);
    assert.equal(sub.plan, 'team');
    assert.equal(Number(sub.seats), 5, 'seats follow the plan');
    assert.equal(sub.status, 'active');
    assert.ok(Math.abs(new Date(sub.expiry_date).getTime() - (teamEnd.getTime() + 3 * DAY)) < 2000);

    const check = await validate(api, licenseKey);
    assert.equal(check.valid, true);
    assert.equal(check.plan, 'team');
  });

  await t.test('an event that does not change the plan leaves admin-granted seats alone', async () => {
    await Subscription.update(subId, { seats: 12 });
    const res = await deliver(api, event('customer.subscription.updated', {
      id: 'sub_renewal_1', object: 'subscription', customer: 'cus_renewal_1', status: 'active',
      metadata: { plan: 'team' },
    }));
    assert.equal(res.status, 200, res.text);
    assert.equal(Number((await Subscription.findById(subId)).seats), 12, 'a card change is not a seat change');
  });

  await t.test('past_due keeps the plan alive while Stripe retries the card', async () => {
    const res = await deliver(api, event('customer.subscription.updated', {
      id: 'sub_renewal_1', object: 'subscription', customer: 'cus_renewal_1', status: 'past_due',
      metadata: { plan: 'team' },
    }));
    assert.equal(res.status, 200, res.text);
    const sub = await Subscription.findById(subId);
    assert.equal(sub.status, 'active');
    assert.equal((await validate(api, licenseKey)).valid, true);
  });

  await t.test('invoice.payment_failed records the failure without throwing', async () => {
    const res = await deliver(api, event('invoice.payment_failed', {
      id: 'in_failed_1', object: 'invoice', billing_reason: 'subscription_cycle',
      customer: 'cus_renewal_1', currency: 'usd', amount_due: 13500, payment_intent: 'pi_failed_1',
      parent: { subscription_details: { subscription: 'sub_renewal_1', metadata: { plan: 'team', billingCycle: 'yearly' } } },
    }));
    assert.equal(res.status, 200, 'a failure event is acknowledged, not retried for ever: ' + res.text);
    const payments = await paymentsFor(userId);
    const failed = payments.find((p) => p.stripe_payment_id === 'pi_failed_1');
    assert.ok(failed, 'the failed attempt is on the ledger');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.plan, 'team');
    assert.equal(Number(failed.amount), 135);
  });

  await t.test('unpaid ends it', async () => {
    const res = await deliver(api, event('customer.subscription.updated', {
      id: 'sub_renewal_1', object: 'subscription', customer: 'cus_renewal_1', status: 'unpaid',
    }));
    assert.equal(res.status, 200, res.text);
    const sub = await Subscription.findById(subId);
    assert.equal(sub.status, 'cancelled');
    const check = await validate(api, licenseKey);
    assert.equal(check.valid, false);
    assert.equal(check.reason, 'cancelled');
  });

  await t.test('a paid invoice after that reactivates: Stripe is the truth', async () => {
    const res = await deliver(api, event('invoice.paid', {
      ...renewalInvoice, id: 'in_renewal_3', payment_intent: 'pi_renewal_3',
      lines: { data: [{ period: { end: unix(new Date(Date.now() + 30 * DAY)) } }] },
    }));
    assert.equal(res.status, 200, res.text);
    assert.equal((await Subscription.findById(subId)).status, 'active');
    assert.equal((await validate(api, licenseKey)).valid, true);
  });

  await t.test('an invoice that names no paid plan cannot turn a free account into a lapsing one', async () => {
    // Matched only by email (no Stripe ids on the row, no metadata on the
    // invoice): applying it would set a one-month expiry on a free row, which
    // /license/validate would read as `expired` a month later.
    const other = srv.client();
    const stranger = await srv.makeUser(other, 'freerow');
    const [{ id: strangerId }] = await srv.query('SELECT id FROM users WHERE email = ?', [stranger.email]);
    const [freeRow] = await Subscription.findByUserId(strangerId);
    const res = await deliver(api, event('invoice.payment_succeeded', {
      id: 'in_orphan', object: 'invoice', billing_reason: 'subscription_cycle',
      customer: 'cus_orphan', customer_email: stranger.email, currency: 'usd', amount_paid: 500,
      payment_intent: 'pi_orphan',
      lines: { data: [{ period: { end: unix(new Date(Date.now() + 30 * DAY)) } }] },
    }));
    assert.equal(res.status, 200, res.text);
    const after = await Subscription.findById(freeRow.id);
    assert.equal(after.plan, 'free');
    assert.equal(String(after.expiry_date), String(freeRow.expiry_date), 'the free row was not touched');
    assert.equal((await validate(api, freeRow.license_key)).valid, true, 'the free licence still validates');
  });

  await t.test('an event for a subscription nobody here has is acknowledged and logged', async () => {
    // Retrying it would never help, so it must not be a 500.
    const res = await deliver(api, event('invoice.payment_succeeded', {
      id: 'in_stranger', object: 'invoice', billing_reason: 'subscription_cycle',
      customer: 'cus_stranger', currency: 'usd', amount_paid: 500,
      parent: { subscription_details: { subscription: 'sub_stranger' } },
      lines: { data: [] },
    }));
    assert.equal(res.status, 200, res.text);
  });

  await srv.stop();
});
