'use strict';

/**
 * Admin edits must change what the admin changed, and nothing else.
 *
 * Three bugs of one shape: the panel's edit dialogs posted every field on
 * every save, and the routes treated "a field is present" as "a field was
 * changed".
 *
 *  - PUT /admin/users/:id with the account's CURRENT plan reset the licence's
 *    seats to the plan default and ended a running trial — so ticking "Email
 *    verified" on a Team customer with 20 seats cut them to 5.
 *  - PUT /admin/subscriptions/:id always carried plan, status and seats, so a
 *    Pro -> Team change kept Pro's single seat, and correcting only a trial's
 *    expiry ended the trial.
 *  - PUT /admin/releases/:id demoted the current latest BEFORE checking the
 *    target existed, and un-ticking "latest" on the latest was accepted; both
 *    leave the desktop update feed with no release to offer. POST demoted the
 *    latest in a separate statement before inserting, with the same result
 *    whenever the insert failed.
 *
 * The bug cases fail on e746cb8 and pass with the fix; the "still works" cases
 * alongside them pin the behaviour the fix must not lose.
 */

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const srv = require('./helpers/testServer');
const { getPool } = require('../src/config/db');

const PASSWORD = 'admin-edits-password';
const STAFF = 'admin-edits-staff@example.test';

async function seedStaff() {
  await srv.query(
    `INSERT INTO users (name, email, password_hash, role, email_verified)
     VALUES ('Staff', ?, ?, 'admin', 1)`,
    [STAFF, await bcrypt.hash(PASSWORD, 4)]
  );
}

async function signInStaff(api) {
  const res = await api.post('/api/admin/login', { email: STAFF, password: PASSWORD });
  assert.equal(res.status, 200, res.text);
  return res.body.data.token;
}

/** A customer whose (registration-issued) subscription is set to `fields`. */
async function customer(api, fields) {
  const { email } = await srv.makeUser(api);
  const [user] = await srv.query('SELECT id FROM users WHERE email = ?', [email]);
  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
  await srv.query(`UPDATE subscriptions SET ${sets} WHERE user_id = ?`, [...Object.values(fields), user.id]);
  const [sub] = await srv.query('SELECT * FROM subscriptions WHERE user_id = ?', [user.id]);
  return { userId: user.id, sub };
}

async function subscriptionOf(userId) {
  const [sub] = await srv.query('SELECT * FROM subscriptions WHERE user_id = ?', [userId]);
  return sub;
}

function inDays(days) {
  // Whole seconds: DATETIME drops the milliseconds.
  return new Date(Math.floor((Date.now() + days * 86400000) / 1000) * 1000);
}

async function latestIds() {
  return (await srv.query('SELECT id FROM releases WHERE is_latest = 1')).map((r) => r.id);
}

test('admin edits keep what they did not change', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();

  let api;
  let token;
  const fresh = async () => {
    await srv.reset();
    api = srv.client();
    await seedStaff();
    token = await signInStaff(api);
  };

  // ---- PUT /admin/users/:id --------------------------------------------------

  await t.test('re-sending the same plan keeps a Team licence\'s custom seats', async () => {
    await fresh();
    const { userId } = await customer(api, { plan: 'team', seats: 20 });

    const res = await api.put(`/api/admin/users/${userId}`,
      { banned: false, emailVerified: true, plan: 'team' }, { token });
    assert.equal(res.status, 200, res.text);

    const sub = await subscriptionOf(userId);
    assert.equal(sub.plan, 'team');
    assert.equal(sub.seats, 20, 'ticking "Email verified" must not reset the seats');
  });

  await t.test('re-sending the same plan does not end a running trial', async () => {
    await fresh();
    const trialEnd = inDays(5);
    const { userId, sub: before } = await customer(api, {
      plan: 'pro', seats: 1, trial_ends_at: trialEnd, expiry_date: trialEnd,
    });

    const res = await api.put(`/api/admin/users/${userId}`,
      { banned: false, emailVerified: true, plan: 'pro' }, { token });
    assert.equal(res.status, 200, res.text);

    const sub = await subscriptionOf(userId);
    assert.ok(sub.trial_ends_at, 'the trial must still be running');
    assert.equal(new Date(sub.trial_ends_at).getTime(), trialEnd.getTime());
    assert.equal(new Date(sub.expiry_date).getTime(), new Date(before.expiry_date).getTime());
  });

  await t.test('a real plan change still moves seats and ends the trial', async () => {
    await fresh();
    const { userId } = await customer(api, { plan: 'pro', seats: 1, trial_ends_at: inDays(5) });

    const res = await api.put(`/api/admin/users/${userId}`, { plan: 'team' }, { token });
    assert.equal(res.status, 200, res.text);

    const sub = await subscriptionOf(userId);
    assert.equal(sub.plan, 'team');
    assert.equal(sub.seats, 5);
    assert.equal(sub.trial_ends_at, null);
  });

  // ---- PUT /admin/subscriptions/:id -----------------------------------------

  await t.test('Pro -> Team with the old seat count echoed back gets Team\'s seats', async () => {
    await fresh();
    const { sub: before } = await customer(api, { plan: 'pro', seats: 1 });

    // Exactly what the dialog sent: every field, seats unchanged.
    const res = await api.put(`/api/admin/subscriptions/${before.id}`,
      { plan: 'team', status: 'active', seats: 1 }, { token });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.plan, 'team');
    assert.equal(res.body.data.seats, 5, 'a Team licence must not be left with one seat');
  });

  await t.test('a plan change with an explicit, different seat count keeps that count', async () => {
    await fresh();
    const { sub: before } = await customer(api, { plan: 'pro', seats: 1 });

    const res = await api.put(`/api/admin/subscriptions/${before.id}`,
      { plan: 'team', seats: 12 }, { token });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.seats, 12);
  });

  await t.test('editing only a trial\'s expiry leaves the trial running', async () => {
    await fresh();
    const trialEnd = inDays(5);
    const { sub: before } = await customer(api, {
      plan: 'pro', seats: 1, trial_ends_at: trialEnd, expiry_date: trialEnd,
    });

    const newExpiry = inDays(9);
    const res = await api.put(`/api/admin/subscriptions/${before.id}`, {
      plan: 'pro', status: 'active', seats: 1, expiryDate: newExpiry.toISOString(),
    }, { token });
    assert.equal(res.status, 200, res.text);

    const sub = await subscriptionOf(before.user_id);
    assert.ok(sub.trial_ends_at, 'the trial must still be running');
    assert.equal(new Date(sub.trial_ends_at).getTime(), trialEnd.getTime());
    assert.equal(new Date(sub.expiry_date).getTime(), newExpiry.getTime());
    assert.equal(sub.plan, 'pro');
  });

  await t.test('re-sending a Team licence\'s plan and seats changes nothing', async () => {
    await fresh();
    const { sub: before } = await customer(api, { plan: 'team', seats: 20 });

    const res = await api.put(`/api/admin/subscriptions/${before.id}`,
      { plan: 'team', status: 'active', seats: 20 }, { token });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.seats, 20);
  });

  // ---- releases: there is always exactly one latest --------------------------

  async function seedReleases() {
    const a = await api.post('/api/admin/releases', { version: '1.0.0', isLatest: true }, { token });
    assert.equal(a.status, 201, a.text);
    const b = await api.post('/api/admin/releases', { version: '1.1.0', isLatest: false }, { token });
    assert.equal(b.status, 201, b.text);
    return { latest: a.body.data, other: b.body.data };
  }

  await t.test('"set latest" on a deleted release 404s and leaves the latest alone', async () => {
    await fresh();
    const { latest, other } = await seedReleases();
    const del = await api.del(`/api/admin/releases/${other.id}`, { token });
    assert.equal(del.status, 200, del.text);

    // A second tab still showing the deleted row clicks "Set latest".
    const res = await api.put(`/api/admin/releases/${other.id}`, { isLatest: true }, { token });
    assert.equal(res.status, 404, res.text);
    assert.deepEqual(await latestIds(), [latest.id], 'the update feed must keep its latest release');
  });

  await t.test('un-ticking "latest" on the latest release is refused', async () => {
    await fresh();
    const { latest } = await seedReleases();

    const res = await api.put(`/api/admin/releases/${latest.id}`,
      { version: '1.0.0', changelog: 'edited', isLatest: false }, { token });
    assert.equal(res.status, 409, res.text);
    assert.equal(res.body.error.code, 'LATEST_RELEASE');
    assert.deepEqual(await latestIds(), [latest.id]);
    // Refused as a whole — no half-applied edit.
    const [row] = await srv.query('SELECT changelog FROM releases WHERE id = ?', [latest.id]);
    assert.equal(row.changelog, '');
  });

  await t.test('promoting another release moves "latest" to it, and only it', async () => {
    await fresh();
    const { other } = await seedReleases();

    const res = await api.put(`/api/admin/releases/${other.id}`, { isLatest: true }, { token });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(await latestIds(), [other.id]);

    // Editing a non-latest release with isLatest:false is still fine.
    const [first] = await srv.query("SELECT id FROM releases WHERE version = '1.0.0'");
    const edit = await api.put(`/api/admin/releases/${first.id}`,
      { changelog: 'notes', isLatest: false }, { token });
    assert.equal(edit.status, 200, edit.text);
    assert.deepEqual(await latestIds(), [other.id]);
  });

  await t.test('a create that fails after demoting the latest leaves the latest in place', async () => {
    await fresh();
    const { latest } = await seedReleases();

    // The insert can still fail after the route's checks pass — two tabs
    // publishing one version, the second losing on uq_releases_version. That
    // race cannot be timed from a test, so a trigger stands in for it: it
    // refuses one version at INSERT time, after the route has done its checks.
    // (Text protocol: CREATE TRIGGER is not a preparable statement.)
    const pool = await getPool();
    await pool.query('DROP TRIGGER IF EXISTS test_refuse_release');
    await pool.query(`
      CREATE TRIGGER test_refuse_release BEFORE INSERT ON releases FOR EACH ROW
      BEGIN
        IF NEW.version = '9.9.9-refused' THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'refused by test trigger';
        END IF;
      END`);
    try {
      const res = await api.post('/api/admin/releases',
        { version: '9.9.9-refused', isLatest: true }, { token });
      assert.equal(res.status >= 500, true, `the insert must fail: ${res.status} ${res.text}`);
      assert.deepEqual(await latestIds(), [latest.id], 'the demotion must roll back with the insert');
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS test_refuse_release');
    }
  });

  await srv.stop();
});
