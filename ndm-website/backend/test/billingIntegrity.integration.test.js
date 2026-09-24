'use strict';

/**
 * One subscription, one charge, and billing that outlives nothing it should.
 *
 * Each block here is a billing defect that was latent while the site ran with
 * payments disabled, and would have cost a real customer money (or cost the
 * business its records) the day Stripe was switched on:
 *
 *  1. A billed Pro customer could open a second Checkout for Team. Stripe made
 *     a new Customer, both subscriptions kept charging, and the old one's
 *     invoices later matched the row by customer/email and wrote its id back.
 *  2. The first payment of a subscription was recorded twice — once by
 *     checkout.session.completed under the cs_ session id, once by invoice.paid
 *     under the pi_ intent.
 *  3. Deleting an account went ahead when Stripe refused to cancel (self
 *     delete), or never asked Stripe at all (admin and creator deletes).
 *  4. Deleting an account cascaded into `payments`, rewriting revenue history
 *     and leaving a later refund nothing to mark.
 *  5. LicenseEmailDelivery.claim never saw a duplicate, so a redelivered event
 *     mailed the licence again (and re-ran the grant, resetting the expiry).
 *
 * Stripe runs in mock mode (constructEvent is JSON.parse). Where a test needs
 * Stripe to fail, it swaps a method on the shared utils/stripe object — the
 * routes call it through that object, so the swap is what they see.
 */
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const srv = require('./helpers/testServer');
const stripe = require('../src/utils/stripe');
const LicenseEmailDelivery = require('../src/models/LicenseEmailDelivery');
const { initSchema } = require('../src/config/schema');

const seconds = (date) => Math.floor(date.getTime() / 1000);
const daysFromNow = (n) => new Date(Date.now() + n * 86400000);

function sendEvent(api, event) {
  return api.post('/api/webhooks/stripe', event, { headers: { 'stripe-signature': 'mock' } });
}

/** Run fn with console.log captured; returns everything it printed. */
async function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  try { await fn(); } finally { console.log = original; }
  return lines.join('\n');
}

/** Swap a method on the shared Stripe client for the duration of fn. */
async function withStripe(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) { saved[key] = stripe[key]; stripe[key] = overrides[key]; }
  try { return await fn(); } finally { Object.assign(stripe, saved); }
}

async function insertAdmin(email, role = 'admin', password = 'admin-password-123') {
  const hash = await bcrypt.hash(password, 12);
  await srv.query(
    'INSERT INTO users (name, email, password_hash, role, email_verified) VALUES (?, ?, ?, ?, 1)',
    [role === 'root' ? 'Creator' : 'Staff', email, hash, role]
  );
  return { email, password };
}

async function userRow(email) {
  return (await srv.query('SELECT * FROM users WHERE email = ?', [email]))[0] || null;
}

async function subRow(userId) {
  return (await srv.query('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]))[0];
}

/** Put a user's row on a Stripe-billed paid plan. */
async function makeBilled(userId, { plan = 'pro', sub = 'sub_billed', cus = 'cus_billed' } = {}) {
  await srv.query(
    `UPDATE subscriptions SET plan = ?, status = 'active', seats = ?, expiry_date = ?,
            stripe_subscription_id = ?, stripe_customer_id = ?, trial_ends_at = NULL
      WHERE user_id = ?`,
    [plan, plan === 'team' ? 5 : 1, daysFromNow(30), sub, cus, userId]
  );
}

function invoiceEvent(id, { type = 'invoice.paid', sub, cus, email, reason = 'subscription_cycle',
  amount = 500, interval = 'month', periodEnd = daysFromNow(30), intent = `pi_${id}` } = {}) {
  return {
    id, type,
    data: {
      object: {
        id: `in_${id}`, object: 'invoice', billing_reason: reason,
        subscription: sub, customer: cus, customer_email: email,
        payment_intent: intent, currency: 'usd', amount_paid: amount, amount_due: amount,
        lines: { data: [{ period: { start: seconds(new Date()), end: seconds(periodEnd) },
          price: { unit_amount: amount, recurring: { interval } } }] },
      },
    },
  };
}

function subscriptionEvent(id, type, { sub, cus, email, cancelAtPeriodEnd = false, status = 'active' }) {
  return {
    id, type,
    data: { object: { id: sub, object: 'subscription', customer: cus, customer_email: email,
      status, cancel_at_period_end: cancelAtPeriodEnd } },
  };
}

/** DELETE with a JSON body (the test client's del() sends none). */
function deleteWithBody(path, token, body) {
  return fetch(`${srv.baseUrl()}${path}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function failingCancel(calls) {
  return async (id, opts) => {
    calls.push({ id, opts });
    throw Object.assign(new Error('Stripe is having a bad day'), { type: 'StripeAPIError' });
  };
}

function recordingCancel(calls) {
  return async (id, opts) => { calls.push({ id, opts }); return { id, status: 'canceled' }; };
}

test('billing integrity', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();

  /* ------------------------------------------------------------- bug 1 */
  await t.test('a billed customer cannot open a second checkout', async (t2) => {
    await srv.reset();
    const api = srv.client();
    const u = await srv.makeUser(api, 'billedpro');
    const row = await userRow(u.email);

    await t2.test('a free account still reaches checkout', async () => {
      const res = await api.post('/api/subscription/checkout',
        { plan: 'pro', billingCycle: 'monthly' }, { token: u.token });
      assert.equal(res.status, 200, res.text);
      assert.ok(res.body.data.url);
    });

    await t2.test('a billed Pro customer buying Team gets 409 ALREADY_SUBSCRIBED', async () => {
      await makeBilled(row.id, { plan: 'pro', sub: 'sub_pro_1', cus: 'cus_pro_1' });
      let created = 0;
      const res = await withStripe({
        createCheckoutSession: async () => { created += 1; return { url: 'https://checkout.example/x' }; },
      }, () => api.post('/api/subscription/checkout',
        { plan: 'team', billingCycle: 'monthly' }, { token: u.token }));
      assert.equal(res.status, 409, res.text);
      assert.equal(res.body.error.code, 'ALREADY_SUBSCRIBED');
      assert.match(res.body.error.message, /billing/i);
      assert.equal(created, 0, 'no Checkout Session may be created for a billed account');
    });

    await t2.test('a returning customer is checked out as the SAME Stripe customer', async () => {
      // Lapsed back to Free, but the Stripe customer id is still on the row.
      await srv.query(
        `UPDATE subscriptions SET plan = 'free', stripe_subscription_id = NULL,
                stripe_customer_id = 'cus_returning' WHERE user_id = ?`, [row.id]);
      let args = null;
      const res = await withStripe({
        createCheckoutSession: async (a) => { args = a; return { url: 'https://checkout.example/y' }; },
      }, () => api.post('/api/subscription/checkout',
        { plan: 'pro', billingCycle: 'monthly' }, { token: u.token }));
      assert.equal(res.status, 200, res.text);
      assert.equal(args.customerId, 'cus_returning');
    });
  });

  await t.test('events for a subscription the row no longer holds are ignored', async (t2) => {
    await srv.reset();
    const api = srv.client();
    const u = await srv.makeUser(api, 'switcher');
    const row = await userRow(u.email);
    // The customer is on Team now; sub_old_pro is a stale Pro subscription on
    // the same Stripe customer that was never stopped.
    await makeBilled(row.id, { plan: 'team', sub: 'sub_team', cus: 'cus_shared' });
    const before = await subRow(row.id);

    await t2.test('invoice.paid for the old subscription changes nothing and records nothing', async () => {
      const res = await sendEvent(api, invoiceEvent('evt_old_paid',
        { sub: 'sub_old_pro', cus: 'cus_shared', email: u.email, periodEnd: daysFromNow(90) }));
      assert.equal(res.status, 200, res.text);
      const after = await subRow(row.id);
      assert.equal(after.stripe_subscription_id, 'sub_team');
      assert.equal(after.plan, 'team');
      assert.equal(new Date(after.expiry_date).getTime(), new Date(before.expiry_date).getTime());
      const paid = await srv.query("SELECT * FROM payments WHERE stripe_payment_id = 'pi_evt_old_paid'");
      assert.equal(paid.length, 0);
    });

    await t2.test('invoice.payment_failed for the old subscription records nothing', async () => {
      const res = await sendEvent(api, invoiceEvent('evt_old_failed',
        { type: 'invoice.payment_failed', sub: 'sub_old_pro', cus: 'cus_shared', email: u.email }));
      assert.equal(res.status, 200, res.text);
      assert.equal((await srv.query('SELECT COUNT(*) AS n FROM payments'))[0].n, 0);
    });

    await t2.test('customer.subscription.updated for the old one leaves the row alone', async () => {
      const res = await sendEvent(api, subscriptionEvent('evt_old_updated', 'customer.subscription.updated',
        { sub: 'sub_old_pro', cus: 'cus_shared', email: u.email, cancelAtPeriodEnd: true }));
      assert.equal(res.status, 200, res.text);
      assert.equal(Number((await subRow(row.id)).cancel_at_period_end), 0);
    });

    await t2.test('customer.subscription.deleted for the old one does not downgrade Team', async () => {
      const res = await sendEvent(api, subscriptionEvent('evt_old_deleted', 'customer.subscription.deleted',
        { sub: 'sub_old_pro', cus: 'cus_shared', email: u.email, status: 'canceled' }));
      assert.equal(res.status, 200, res.text);
      const after = await subRow(row.id);
      assert.equal(after.plan, 'team');
      assert.equal(after.stripe_subscription_id, 'sub_team');
    });

    await t2.test('events for the CURRENT subscription still apply', async () => {
      const res = await sendEvent(api, invoiceEvent('evt_team_paid',
        { sub: 'sub_team', cus: 'cus_shared', email: u.email, amount: 1500 }));
      assert.equal(res.status, 200, res.text);
      const paid = await srv.query("SELECT * FROM payments WHERE stripe_payment_id = 'pi_evt_team_paid'");
      assert.equal(paid.length, 1);
    });
  });

  /* ------------------------------------------------------------- bug 2 */
  await t.test('a subscription checkout records its first payment exactly once', async () => {
    await srv.reset();
    const api = srv.client();
    const u = await srv.makeUser(api, 'firstcharge');
    const row = await userRow(u.email);

    // What Stripe really sends in subscription mode: no payment_intent on the
    // session, and the charge itself on the first invoice.
    const completed = await sendEvent(api, {
      id: 'evt_cs_first', type: 'checkout.session.completed',
      data: { object: {
        id: 'cs_first', object: 'checkout.session', mode: 'subscription', payment_status: 'paid',
        payment_intent: null, subscription: 'sub_first', customer: 'cus_first',
        customer_email: u.email, currency: 'usd', amount_total: 500,
        metadata: { userId: String(row.id), plan: 'pro', billingCycle: 'monthly' },
      } },
    });
    assert.equal(completed.status, 200, completed.text);
    const firstInvoice = await sendEvent(api, invoiceEvent('evt_first_invoice',
      { sub: 'sub_first', cus: 'cus_first', email: u.email, reason: 'subscription_create', intent: 'pi_first' }));
    assert.equal(firstInvoice.status, 200, firstInvoice.text);

    const payments = await srv.query('SELECT stripe_payment_id, amount FROM payments WHERE user_id = ?', [row.id]);
    assert.deepEqual(payments.map((p) => p.stripe_payment_id), ['pi_first'],
      'one charge, one row — keyed on the payment intent a refund will name');
    assert.equal((await subRow(row.id)).plan, 'pro');
  });

  /* ------------------------------------------------------------- bug 3 */
  await t.test('an account is never deleted while Stripe is still billing it', async (t2) => {
    await srv.reset();
    const api = srv.client();
    await insertAdmin('creator@example.test', 'root', 'creator-password-123');
    await insertAdmin('staff-del@example.test');
    const rootLogin = await api.post('/api/root/login', { email: 'creator@example.test', password: 'creator-password-123' });
    const rootToken = rootLogin.body.data.token;
    const staffLogin = await srv.client().post('/api/admin/login', { email: 'staff-del@example.test', password: 'admin-password-123' });
    const staffToken = staffLogin.body.data.token;

    await t2.test('self-delete: a failed Stripe cancel answers 502 and keeps the account', async () => {
      const u = await srv.makeUser(srv.client(), 'selfdel');
      const row = await userRow(u.email);
      await makeBilled(row.id, { sub: 'sub_self', cus: 'cus_self' });
      const calls = [];
      const res = await withStripe({ cancelSubscription: failingCancel(calls) },
        () => deleteWithBody('/api/user/account', u.token, { password: u.password, confirm: 'DELETE' }));
      assert.equal(res.status, 502, await res.text());
      assert.equal(calls.length, 1);
      assert.ok(await userRow(u.email), 'the account must still exist');

      const ok = [];
      const done = await withStripe({ cancelSubscription: recordingCancel(ok) },
        () => deleteWithBody('/api/user/account', u.token, { password: u.password, confirm: 'DELETE' }));
      assert.equal(done.status, 200, await done.text());
      assert.deepEqual(ok, [{ id: 'sub_self', opts: { atPeriodEnd: false } }]);
      assert.equal(await userRow(u.email), null);
    });

    await t2.test('admin delete cancels the Stripe subscription, and refuses when it cannot', async () => {
      const u = await srv.makeUser(srv.client(), 'admindel');
      const row = await userRow(u.email);
      await makeBilled(row.id, { sub: 'sub_admin', cus: 'cus_admin' });
      const failed = [];
      const res = await withStripe({ cancelSubscription: failingCancel(failed) },
        () => deleteWithBody(`/api/admin/users/${row.id}`, staffToken, { confirmEmail: u.email }));
      assert.equal(res.status, 502, await res.text());
      assert.ok(await userRow(u.email));

      const ok = [];
      const done = await withStripe({ cancelSubscription: recordingCancel(ok) },
        () => deleteWithBody(`/api/admin/users/${row.id}`, staffToken, { confirmEmail: u.email }));
      assert.equal(done.status, 200, await done.text());
      assert.deepEqual(ok, [{ id: 'sub_admin', opts: { atPeriodEnd: false } }]);
      assert.equal(await userRow(u.email), null);
    });

    await t2.test('creator delete cancels the Stripe subscription, and refuses when it cannot', async () => {
      const u = await srv.makeUser(srv.client(), 'rootdel');
      const row = await userRow(u.email);
      await makeBilled(row.id, { sub: 'sub_root', cus: 'cus_root' });
      const res = await withStripe({ cancelSubscription: failingCancel([]) },
        () => deleteWithBody(`/api/root/users/${row.id}`, rootToken, { confirmEmail: u.email }));
      assert.equal(res.status, 502, await res.text());
      assert.ok(await userRow(u.email));

      const ok = [];
      const done = await withStripe({ cancelSubscription: recordingCancel(ok) },
        () => deleteWithBody(`/api/root/users/${row.id}`, rootToken, { confirmEmail: u.email }));
      assert.equal(done.status, 200, await done.text());
      assert.deepEqual(ok, [{ id: 'sub_root', opts: { atPeriodEnd: false } }]);
    });

    await t2.test('an account that is not billed is deleted without asking Stripe', async () => {
      const u = await srv.makeUser(srv.client(), 'freedel');
      const calls = [];
      const done = await withStripe({ cancelSubscription: failingCancel(calls) },
        () => deleteWithBody('/api/user/account', u.token, { password: u.password, confirm: 'DELETE' }));
      assert.equal(done.status, 200, await done.text());
      assert.equal(calls.length, 0);
    });

    await t2.test('with billing disabled, deletion still goes through', async () => {
      const u = await srv.makeUser(srv.client(), 'disableddel');
      const row = await userRow(u.email);
      await makeBilled(row.id, { sub: 'sub_disabled', cus: 'cus_disabled' });
      const done = await withStripe({
        disabled: true,
        cancelSubscription: async () => {
          throw Object.assign(new Error('Billing is not configured on this server'),
            { status: 503, code: 'BILLING_UNAVAILABLE' });
        },
      }, () => deleteWithBody('/api/user/account', u.token, { password: u.password, confirm: 'DELETE' }));
      assert.equal(done.status, 200, await done.text());
      assert.equal(await userRow(u.email), null);
    });
  });

  /* ------------------------------------------------------------- bug 4 */
  await t.test('payment history outlives the account it belonged to', async (t2) => {
    await srv.reset();
    const api = srv.client();
    await insertAdmin('ledger@example.test');
    const adminToken = (await srv.client().post('/api/admin/login',
      { email: 'ledger@example.test', password: 'admin-password-123' })).body.data.token;
    const u = await srv.makeUser(api, 'leaver');
    const row = await userRow(u.email);
    await makeBilled(row.id, { sub: 'sub_leaver', cus: 'cus_leaver' });
    const paid = await sendEvent(api, invoiceEvent('evt_leaver_paid',
      { sub: 'sub_leaver', cus: 'cus_leaver', email: u.email, intent: 'pi_leaver' }));
    assert.equal(paid.status, 200, paid.text);

    await t2.test('deleting the account keeps its payments, detached', async () => {
      const done = await withStripe({ cancelSubscription: recordingCancel([]) },
        () => deleteWithBody('/api/user/account', u.token, { password: u.password, confirm: 'DELETE' }));
      assert.equal(done.status, 200, await done.text());
      const rows = await srv.query("SELECT user_id, status FROM payments WHERE stripe_payment_id = 'pi_leaver'");
      assert.equal(rows.length, 1, 'the payment row survives');
      assert.equal(rows[0].user_id, null);
    });

    await t2.test('the admin dashboard still lists and counts it', async () => {
      const stats = await srv.client().get('/api/admin/stats', { token: adminToken });
      assert.equal(stats.status, 200, stats.text);
      const recent = stats.body.data.recentPayments;
      assert.equal(recent.length, 1);
      assert.equal(recent[0].userEmail, null);
      assert.equal(recent[0].userName, 'Deleted account');
      const revenue = stats.body.data.revenueSeries.reduce((s, m) => s + Number(m.revenue), 0);
      assert.equal(revenue, 5);
    });

    await t2.test('a later refund still finds the row', async () => {
      const res = await sendEvent(api, {
        id: 'evt_leaver_refund', type: 'charge.refunded',
        data: { object: { id: 'ch_leaver', payment_intent: 'pi_leaver', customer: 'cus_leaver',
          amount: 500, amount_refunded: 500, refunded: true } },
      });
      assert.equal(res.status, 200, res.text);
      const rows = await srv.query("SELECT status FROM payments WHERE stripe_payment_id = 'pi_leaver'");
      assert.equal(rows[0].status, 'refunded');
    });
  });

  await t.test('the payments foreign key is migrated in place, idempotently', async () => {
    await srv.reset();
    const api = srv.client();
    const u = await srv.makeUser(api, 'legacyfk');
    const row = await userRow(u.email);

    // Rebuild the pre-fix shape: NOT NULL user_id with a CASCADE key named the
    // way MySQL auto-named it in the original CREATE TABLE.
    const fks = await srv.query(
      `SELECT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments'
          AND COLUMN_NAME = 'user_id' AND REFERENCED_TABLE_NAME = 'users'`);
    for (const fk of fks) await srv.query(`ALTER TABLE payments DROP FOREIGN KEY \`${fk.name}\``);
    await srv.query('ALTER TABLE payments MODIFY COLUMN user_id INT UNSIGNED NOT NULL');
    await srv.query(`ALTER TABLE payments ADD CONSTRAINT payments_ibfk_1
                     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`);
    await srv.query(`INSERT INTO payments (user_id, amount, plan, billing_cycle, stripe_payment_id)
                     VALUES (?, 5, 'pro', 'monthly', 'pi_legacy')`, [row.id]);

    const shape = async () => {
      const [col] = await srv.query(
        `SELECT IS_NULLABLE FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'payments' AND column_name = 'user_id'`);
      const rules = await srv.query(
        `SELECT rc.CONSTRAINT_NAME AS name, rc.DELETE_RULE AS rule
           FROM information_schema.REFERENTIAL_CONSTRAINTS rc
           JOIN information_schema.KEY_COLUMN_USAGE k
             ON k.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
            AND k.TABLE_NAME = rc.TABLE_NAME
          WHERE rc.CONSTRAINT_SCHEMA = DATABASE() AND rc.TABLE_NAME = 'payments' AND k.COLUMN_NAME = 'user_id'`);
      return { nullable: col.IS_NULLABLE, rules: rules.map((r) => r.rule) };
    };

    await initSchema();
    assert.deepEqual(await shape(), { nullable: 'YES', rules: ['SET NULL'] });
    // And a second boot changes nothing and does not fail.
    await initSchema();
    assert.deepEqual(await shape(), { nullable: 'YES', rules: ['SET NULL'] });
    assert.equal((await srv.query("SELECT COUNT(*) AS n FROM payments WHERE stripe_payment_id = 'pi_legacy'"))[0].n, 1,
      'existing payment rows survive the migration');

    await srv.query('DELETE FROM users WHERE id = ?', [row.id]);
    const [kept] = await srv.query("SELECT user_id FROM payments WHERE stripe_payment_id = 'pi_legacy'");
    assert.equal(kept.user_id, null);
  });

  /* ------------------------------------------------------------- bug 5 */
  await t.test('the licence email is claimed once per event', async (t2) => {
    await srv.reset();
    const api = srv.client();
    const u = await srv.makeUser(api, 'mailonce');
    const row = await userRow(u.email);

    await t2.test('claim sees a duplicate for what it is', async () => {
      assert.equal(await LicenseEmailDelivery.claim('evt_claim', row.id, 'KEY', 'pro'), 'claimed');
      assert.equal(await LicenseEmailDelivery.claim('evt_claim', row.id, 'KEY', 'pro'), 'in_progress');
      await LicenseEmailDelivery.markSent('evt_claim');
      assert.equal(await LicenseEmailDelivery.claim('evt_claim', row.id, 'KEY', 'pro'), 'sent');
    });

    await t2.test('a failed send can be claimed again', async () => {
      assert.equal(await LicenseEmailDelivery.claim('evt_retry', row.id, 'KEY', 'pro'), 'claimed');
      await LicenseEmailDelivery.markFailed('evt_retry', new Error('smtp down'));
      assert.equal(await LicenseEmailDelivery.claim('evt_retry', row.id, 'KEY', 'pro'), 'claimed');
      const [d] = await srv.query("SELECT attempts FROM license_email_deliveries WHERE event_id = 'evt_retry'");
      assert.equal(d.attempts, 2);
    });

    await t2.test('a redelivered checkout neither re-mails the licence nor resets the expiry', async () => {
      const event = {
        id: 'evt_cs_redeliver', type: 'checkout.session.completed',
        data: { object: {
          id: 'cs_redeliver', mode: 'subscription', payment_status: 'paid', payment_intent: null,
          subscription: 'sub_redeliver', customer: 'cus_redeliver', customer_email: u.email,
          currency: 'usd', amount_total: 500,
          metadata: { userId: String(row.id), plan: 'pro', billingCycle: 'monthly' },
        } },
      };
      const first = await captureLog(async () => {
        const res = await sendEvent(api, event);
        assert.equal(res.status, 200, res.text);
      });
      assert.match(first, /plan is active/, 'the first delivery sends the licence email');

      // Stripe redelivers the event when the ledger never recorded it as
      // processed — the handler ran (and mailed), then something after it failed.
      await srv.query("UPDATE stripe_webhook_events SET status = 'failed' WHERE event_id = 'evt_cs_redeliver'");
      const renewedTo = daysFromNow(200);
      await srv.query('UPDATE subscriptions SET expiry_date = ? WHERE user_id = ?', [renewedTo, row.id]);

      const second = await captureLog(async () => {
        const res = await sendEvent(api, event);
        assert.equal(res.status, 200, res.text);
      });
      assert.doesNotMatch(second, /plan is active/, 'the licence email must not go out twice');
      const after = await subRow(row.id);
      assert.equal(seconds(new Date(after.expiry_date)), seconds(renewedTo),
        'a redelivery must not rewind an expiry a later renewal already set');
    });
  });

  await srv.stop();
});
