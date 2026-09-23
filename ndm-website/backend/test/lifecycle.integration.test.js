'use strict';

/**
 * The end of a subscription's life, against a real database.
 *
 * All of these used to end with the desktop client DELETING the customer's
 * licence key, because /api/license/validate answered `expired` or `cancelled`
 * and the client treats both as "this key is no good". Cancelling, lapsing and
 * refunding should all land the same way instead: a Free account with a working
 * key and nothing deleted.
 */
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const srv = require('./helpers/testServer');

const DEVICE = 'b'.repeat(64);
const daysFromNow = (n) => new Date(Date.now() + n * 86400000);
const seconds = (date) => Math.floor(date.getTime() / 1000);

function sendEvent(api, event) {
  return api.post('/api/webhooks/stripe', event, { headers: { 'stripe-signature': 'mock' } });
}

/** Put a user on a paid plan the way checkout does. */
async function makePro(api, email, { subId = 'sub_life', customer = 'cus_life' } = {}) {
  await sendEvent(api, {
    id: `evt_${subId}_checkout`, type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${subId}`, customer, subscription: subId, payment_intent: `pi_${subId}`,
        customer_email: email, currency: 'usd', amount_total: 500,
        metadata: { plan: 'pro', billingCycle: 'monthly' },
      },
    },
  });
}

const licenseOf = async (api, token) =>
  (await api.get('/api/user/license', { token })).body.data.licenseKey;

test('ending a subscription', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();
  await srv.reset();

  await t.test('cancelling keeps the plan until the period the customer paid for ends', async () => {
    const api = srv.client();
    const user = await srv.makeUser(api, 'cancel');
    await makePro(api, user.email, { subId: 'sub_cancel', customer: 'cus_cancel' });

    const res = await api.post('/api/subscription/cancel', undefined, { token: user.token });
    assert.equal(res.status, 200);
    // The /billing dialog has always promised exactly this.
    assert.equal(res.body.data.plan, 'pro');
    assert.equal(res.body.data.status, 'active');
    assert.equal(res.body.data.cancelAtPeriodEnd, true);

    const key = await licenseOf(api, user.token);
    const check = await api.post('/api/license/validate',
      { license_key: key, device_fingerprint: DEVICE });
    assert.equal(check.body.valid, true);
    assert.equal(check.body.plan, 'pro');
  });

  await t.test('and can be resumed before it runs out', async () => {
    const api = srv.client();
    const user = await srv.makeUser(api, 'resume');
    await makePro(api, user.email, { subId: 'sub_resume', customer: 'cus_resume' });
    await api.post('/api/subscription/cancel', undefined, { token: user.token });

    const res = await api.post('/api/subscription/resume', undefined, { token: user.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.cancelAtPeriodEnd, false);
    assert.equal(res.body.data.plan, 'pro');

    // Resuming twice is a clear error, not a silent no-op.
    const again = await api.post('/api/subscription/resume', undefined, { token: user.token });
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code, 'NOT_CANCELLING');
  });

  await t.test('when the period finally ends the account becomes Free, key intact', async () => {
    const api = srv.client();
    const user = await srv.makeUser(api, 'ended');
    await makePro(api, user.email, { subId: 'sub_ended', customer: 'cus_ended' });
    const key = await licenseOf(api, user.token);

    await sendEvent(api, {
      id: 'evt_sub_ended_deleted', type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_ended', customer: 'cus_ended', status: 'canceled' } },
    });

    // Not `cancelled`: that reason makes the desktop client delete the key.
    const check = await api.post('/api/license/validate',
      { license_key: key, device_fingerprint: DEVICE });
    assert.equal(check.body.valid, true);
    assert.equal(check.body.plan, 'free');
    assert.equal(check.body.features.maxConcurrentDownloads, 3);
    assert.equal(await licenseOf(api, user.token), key);
  });

  await t.test('a paid plan that simply lapses falls back to Free after the grace period', async () => {
    const api = srv.client();
    const user = await srv.makeUser(api, 'lapsed');
    await makePro(api, user.email, { subId: 'sub_lapsed', customer: 'cus_lapsed' });
    const key = await licenseOf(api, user.token);

    // Inside the grace window a slow renewal webhook must change nothing.
    await srv.query('UPDATE subscriptions SET expiry_date = ? WHERE license_key = ?',
      [daysFromNow(-1), key]);
    let check = await api.post('/api/license/validate',
      { license_key: key, device_fingerprint: DEVICE });
    assert.equal(check.body.valid, true);
    assert.equal(check.body.plan, 'pro');

    // Well past it, this is a real lapse.
    await srv.query('UPDATE subscriptions SET expiry_date = ? WHERE license_key = ?',
      [daysFromNow(-10), key]);
    check = await api.post('/api/license/validate',
      { license_key: key, device_fingerprint: DEVICE });
    assert.equal(check.body.valid, true);
    assert.equal(check.body.plan, 'free');
  });

  await t.test('a plan switched in Stripe\'s own portal reaches us', async () => {
    const api = srv.client();
    const user = await srv.makeUser(api, 'portal');
    await makePro(api, user.email, { subId: 'sub_portal', customer: 'cus_portal' });
    const periodEnd = daysFromNow(28);

    await sendEvent(api, {
      id: 'evt_sub_portal_updated', type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_portal', customer: 'cus_portal', status: 'active',
          cancel_at_period_end: true,
          current_period_end: seconds(periodEnd),
          // Upgraded to Team monthly over there.
          items: { data: [{ price: { unit_amount: 1500, recurring: { interval: 'month' } } }] },
        },
      },
    });

    const status = await api.get('/api/subscription/status', { token: user.token });
    assert.equal(status.body.data.plan, 'team');
    assert.equal(status.body.data.seats, 5);
    assert.equal(status.body.data.cancelAtPeriodEnd, true);
    assert.equal(Math.floor(new Date(status.body.data.expiryDate).getTime() / 1000), seconds(periodEnd));
  });

  await t.test('a subscription created in Stripe\'s dashboard reaches us too', async () => {
    // Not every paid subscription comes from our checkout: one started in the
    // Stripe dashboard, or by any flow that never fires
    // checkout.session.completed, only ever announces itself as
    // customer.subscription.created. That event used to be ignored, so the
    // customer stayed on Free until something else about the subscription
    // happened to change.
    const api = srv.client();
    const user = await srv.makeUser(api, 'dashboard');
    const [row] = await srv.query('SELECT id FROM users WHERE email = ?', [user.email]);
    // The row has no Stripe ids yet — the match falls back to the customer,
    // then to the email on the object.
    await srv.query(
      'UPDATE subscriptions SET stripe_customer_id = ? WHERE user_id = ?',
      ['cus_dashboard', row.id]
    );
    const periodEnd = daysFromNow(30);

    await sendEvent(api, {
      id: 'evt_sub_dashboard_created', type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_dashboard', customer: 'cus_dashboard', status: 'active',
          cancel_at_period_end: false,
          current_period_end: seconds(periodEnd),
          items: { data: [{ price: { unit_amount: 500, recurring: { interval: 'month' } } }] },
        },
      },
    });

    const status = await api.get('/api/subscription/status', { token: user.token });
    assert.equal(status.body.data.plan, 'pro');
    assert.equal(Math.floor(new Date(status.body.data.expiryDate).getTime() / 1000), seconds(periodEnd));
    // And the desktop app sees it on its next check.
    const key = await licenseOf(api, user.token);
    const check = await api.post('/api/license/validate',
      { license_key: key, device_fingerprint: DEVICE });
    assert.equal(check.body.valid, true);
    assert.equal(check.body.plan, 'pro');
  });

  await t.test('an unrecognised price leaves the stored plan alone', async () => {
    const api = srv.client();
    const user = await srv.makeUser(api, 'oddprice');
    await makePro(api, user.email, { subId: 'sub_odd', customer: 'cus_odd' });

    await sendEvent(api, {
      id: 'evt_sub_odd_updated', type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_odd', customer: 'cus_odd', status: 'active', cancel_at_period_end: false,
          items: { data: [{ price: { unit_amount: 777, recurring: { interval: 'month' } } }] },
        },
      },
    });

    const status = await api.get('/api/subscription/status', { token: user.token });
    // Guessing here would silently downgrade a paying customer.
    assert.equal(status.body.data.plan, 'pro');
  });

  await t.test('a full refund stops the revenue count and returns the account to Free', async () => {
    const api = srv.client();
    const user = await srv.makeUser(api, 'refund');
    await makePro(api, user.email, { subId: 'sub_refund', customer: 'cus_refund' });
    const key = await licenseOf(api, user.token);

    await sendEvent(api, {
      id: 'evt_refund_full', type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_refund', object: 'charge', customer: 'cus_refund',
          payment_intent: 'pi_sub_refund', amount: 500, amount_refunded: 500, refunded: true,
        },
      },
    });

    // `payments.status` had a 'refunded' value nothing ever wrote, so refunded
    // months kept counting toward the revenue chart and the MRR tile.
    const [payment] = await srv.query(
      "SELECT status FROM payments WHERE stripe_payment_id = 'pi_sub_refund'");
    assert.equal(payment.status, 'refunded');

    const check = await api.post('/api/license/validate',
      { license_key: key, device_fingerprint: DEVICE });
    assert.equal(check.body.valid, true);
    assert.equal(check.body.plan, 'free');
  });

  await srv.stop();
});
