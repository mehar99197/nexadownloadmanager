'use strict';

/**
 * A staff admin stops at customer accounts — for the subscription routes too.
 *
 * blockedStaffTarget kept staff off the creator's and every fellow admin's
 * account on the user routes, and on the subscription routes that load the
 * owner. Three did not, and three lists read around it:
 *
 *   - revoke-device and sharing/clear|resume never loaded the owner, so a staff
 *     admin could free the creator's seats (knocking the creator's machines off
 *     their plan) or lift a sharing suspension on a panel account;
 *   - the subscription list, its CSV export, the users list and the flagged
 *     queue all embed whole subscription rows, so the licence key and Stripe
 *     ids the details view refuses to show were one table away.
 *
 * And the panel's "create customer" skipped the password policy its own reset
 * route applies.
 */

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const srv = require('./helpers/testServer');
const config = require('../src/config/env');
const Subscription = require('../src/models/Subscription');

const PASSWORD = 'staff-limits-password';

async function seedUser(email, role) {
  await srv.query(
    `INSERT INTO users (name, email, password_hash, role, email_verified)
     VALUES (?, ?, ?, ?, 1)`,
    [role, email, await bcrypt.hash(PASSWORD, 4), role]
  );
  const [row] = await srv.query('SELECT id FROM users WHERE email = ?', [email]);
  return row.id;
}

async function seedSubscription(userId, licenseKey) {
  const sub = await Subscription.create({
    userId, plan: 'pro', status: 'active', licenseKey, seats: 1,
    startDate: new Date(), expiryDate: new Date(Date.now() + 30 * 86400000),
  });
  await srv.query(
    `UPDATE subscriptions SET stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?`,
    [`cus_${licenseKey}`, `sub_${licenseKey}`, sub.id]
  );
  return sub.id;
}

async function signInStaff(api, email) {
  const res = await api.post('/api/admin/login', { email, password: PASSWORD });
  assert.equal(res.status, 200, res.text);
  return res.body.data.token;
}

test('staff limits on subscriptions', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();

  let api;
  let token;
  let creatorSub;
  let customerSub;

  async function setup() {
    await srv.reset();
    api = srv.client();
    await seedUser('limits-staff@example.test', 'admin');
    const creator = await seedUser(config.ROOT_ADMIN_EMAIL, 'root');
    const customer = await seedUser('limits-customer@example.test', 'user');
    creatorSub = await seedSubscription(creator, 'NDM-ROOT-ROOT-ROOT');
    customerSub = await seedSubscription(customer, 'NDM-CUST-CUST-CUST');
    token = await signInStaff(api, 'limits-staff@example.test');
  }

  await t.test('the lists show a customer\'s licence to staff, never the creator\'s', async () => {
    await setup();
    const byEmail = (rows, email, field = 'userEmail') => rows.find((r) => r[field] === email);

    const list = await api.get('/api/admin/subscriptions', { token });
    assert.equal(list.status, 200, list.text);
    const root = byEmail(list.body.data.subscriptions, config.ROOT_ADMIN_EMAIL);
    const cust = byEmail(list.body.data.subscriptions, 'limits-customer@example.test');
    assert.equal(root.license_key, null, 'the creator\'s licence key is not a staff read');
    assert.equal(root.stripe_customer_id, null);
    assert.equal(root.stripe_subscription_id, null);
    assert.equal(root.plan, 'pro', 'the rest of the row is still there');
    assert.equal(cust.license_key, 'NDM-CUST-CUST-CUST', 'a customer\'s key is what support needs');

    const exported = await api.get('/api/admin/subscriptions/export', { token });
    assert.equal(exported.status, 200, exported.text);
    assert.equal(byEmail(exported.body.data, config.ROOT_ADMIN_EMAIL).license_key, null, 'nor out of the CSV');
    assert.equal(byEmail(exported.body.data, 'limits-customer@example.test').license_key, 'NDM-CUST-CUST-CUST');

    const users = await api.get('/api/admin/users?limit=50', { token });
    assert.equal(users.status, 200, users.text);
    const rootUser = users.body.data.users.find((u) => u.email === config.ROOT_ADMIN_EMAIL);
    assert.equal(rootUser.subscription.license_key, null, 'nor off the users table');
    assert.equal(rootUser.plan, 'pro');

    await srv.query(`UPDATE subscriptions SET sharing_level = 'suspected' WHERE id IN (?, ?)`, [creatorSub, customerSub]);
    const flagged = await api.get('/api/admin/subscriptions/flagged', { token });
    assert.equal(flagged.status, 200, flagged.text);
    assert.equal(byEmail(flagged.body.data.subscriptions, config.ROOT_ADMIN_EMAIL, 'email').license_key, null,
      'nor out of the flagged queue');
    assert.equal(byEmail(flagged.body.data.subscriptions, 'limits-customer@example.test', 'email').license_key,
      'NDM-CUST-CUST-CUST');
  });

  await t.test('staff cannot free the creator\'s seats or touch its sharing flag', async () => {
    await setup();
    for (const path of ['revoke-device', 'sharing/clear', 'sharing/resume']) {
      const res = await api.post(`/api/admin/subscriptions/${creatorSub}/${path}`, {}, { token });
      assert.equal(res.status, 403, `${path} on the creator's subscription: ${res.text}`);
      assert.equal(res.body.error.code, 'FORBIDDEN');
    }
    // And nothing moved.
    const [row] = await srv.query('SELECT sharing_exempt FROM subscriptions WHERE id = ?', [creatorSub]);
    assert.equal(Number(row.sharing_exempt) || 0, 0);

    // The same routes still work on a customer — the guard is not a wall.
    for (const path of ['revoke-device', 'sharing/clear', 'sharing/resume']) {
      const res = await api.post(`/api/admin/subscriptions/${customerSub}/${path}`, {}, { token });
      assert.equal(res.status, 200, `${path} on a customer's subscription: ${res.text}`);
    }
    const missing = await api.post('/api/admin/subscriptions/999999/sharing/clear', {}, { token });
    assert.equal(missing.status, 404);
  });

  await t.test('a customer created from the panel meets the password policy', async () => {
    await setup();
    const weak = await api.post('/api/admin/users', {
      name: 'New Customer', email: 'newcustomer@example.test',
      password: 'newcustomer-password', plan: 'free',
    }, { token });
    assert.equal(weak.status, 400, weak.text);
    assert.equal(weak.body.error.code, 'WEAK_PASSWORD');
    const [none] = await srv.query('SELECT COUNT(*) AS n FROM users WHERE email = ?', ['newcustomer@example.test']);
    assert.equal(Number(none.n), 0, 'refused means not created');

    const fine = await api.post('/api/admin/users', {
      name: 'New Customer', email: 'newcustomer@example.test',
      password: 'a-perfectly-fine-password', plan: 'free',
    }, { token });
    assert.equal(fine.status, 201, fine.text);
  });

  await srv.stop();
});
