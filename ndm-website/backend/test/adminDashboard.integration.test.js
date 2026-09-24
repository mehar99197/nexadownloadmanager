'use strict';

/**
 * The admin dashboard's numbers, and the panel reads behind them, checked
 * against rows whose right answer is known.
 *
 * Every figure here was plausible and wrong: "Active subscriptions" counted
 * every active row (each account has an active Free one, so it was the user
 * count), MRR priced every active Pro/Team row at a flat $5/$15 — trials,
 * admin-granted plans and yearly plans included — the revenue chart asked for
 * six months and could get seven, the creator's audit screen asked for 200
 * rows and got 100, and the CSV exports said nothing when they were cut short
 * (the subscription one was cut at 200, not at the 5000 its comment promised).
 * Nothing about any of those looks wrong on the screen, which is why they are
 * pinned against the database rather than eyeballed.
 */

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const srv = require('./helpers/testServer');
const { lastMonths } = require('../src/utils/revenue');

const PASSWORD = 'admin-dashboard-password';
const CREATOR = 'creator@example.test';

async function seedPanelAccount(email, role) {
  await srv.query(
    `INSERT INTO users (name, email, password_hash, role, email_verified)
     VALUES ('Panel', ?, ?, ?, 1)`,
    [email, await bcrypt.hash(PASSWORD, 4), role]
  );
}

async function staffToken(api) {
  await seedPanelAccount('dash-staff@example.test', 'admin');
  const res = await api.post('/api/admin/login', { email: 'dash-staff@example.test', password: PASSWORD });
  assert.equal(res.status, 200, res.text);
  return res.body.data.token;
}

async function rootToken(api) {
  await seedPanelAccount(CREATOR, 'root');
  const res = await api.post('/api/root/login', { email: CREATOR, password: PASSWORD });
  assert.equal(res.status, 200, res.text);
  return res.body.data.token;
}

let keySeq = 0;
/**
 * A customer with one subscription row, written directly — the point is the
 * shape of the row, not the path that produced it. `sub` columns are SQL
 * expressions so dates can be relative to the database's own NOW().
 */
async function customer(label, sub, payment) {
  const email = `${label}@example.test`;
  await srv.query(
    "INSERT INTO users (name, email, password_hash, role, email_verified) VALUES (?, ?, 'x', 'user', 1)",
    [label, email]
  );
  const [user] = await srv.query('SELECT id FROM users WHERE email = ?', [email]);
  keySeq += 1;
  await srv.query(
    `INSERT INTO subscriptions (user_id, plan, status, license_key, seats, start_date, expiry_date,
                                trial_ends_at, stripe_subscription_id)
     VALUES (?, ?, ?, ?, 1, NOW(), ${sub.expiry || 'NOW() + INTERVAL 20 DAY'},
             ${sub.trialEndsAt || 'NULL'}, ?)`,
    [user.id, sub.plan, sub.status || 'active', `NEXA-DASH-${keySeq}-${label}`.slice(0, 50),
     sub.stripe || null]
  );
  if (payment) {
    await srv.query(
      `INSERT INTO payments (user_id, amount, currency, plan, billing_cycle, status)
       VALUES (?, ?, 'usd', ?, ?, 'paid')`,
      [user.id, payment.amount, sub.plan, payment.cycle]
    );
  }
  return user.id;
}

test('admin dashboard figures and panel reads', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();

  await t.test('Active subscriptions counts paid plans, not every active row; trials are reported apart', async () => {
    await srv.reset();
    const api = srv.client();
    const token = await staffToken(api);

    await customer('billed-pro-monthly', { plan: 'pro', stripe: 'sub_pro_m' }, { amount: 5, cycle: 'monthly' });
    await customer('billed-team-yearly', { plan: 'team', stripe: 'sub_team_y' }, { amount: 135, cycle: 'yearly' });
    await customer('comped-pro', { plan: 'pro' });
    await customer('trial-pro', { plan: 'pro', trialEndsAt: 'NOW() + INTERVAL 5 DAY', expiry: 'NOW() + INTERVAL 5 DAY' });
    await customer('free-one', { plan: 'free', expiry: 'NOW() + INTERVAL 36500 DAY' });
    await customer('free-two', { plan: 'free', expiry: 'NOW() + INTERVAL 36500 DAY' });
    await customer('cancelled-pro', { plan: 'pro', status: 'cancelled', stripe: 'sub_gone' });
    // Paid, but its period ended a month ago and never renewed: the next read
    // of it drops it to Free, so it is not a paid plan in force.
    await customer('lapsed-pro', { plan: 'pro', stripe: 'sub_lapsed', expiry: 'NOW() - INTERVAL 30 DAY' });

    const res = await api.get('/api/admin/stats', { token });
    assert.equal(res.status, 200, res.text);
    const stats = res.body.data;

    // billed-pro-monthly, billed-team-yearly and comped-pro. Not the trial,
    // not the two Free rows, not the cancelled or the lapsed one.
    assert.equal(stats.activeSubscriptions, 3, 'paid plans in force, trials excluded');
    assert.equal(stats.activeTrials, 1, 'the running trial is its own figure');
  });

  await t.test('MRR counts only Stripe-billed plans, with a yearly plan at a twelfth of its yearly price', async () => {
    await srv.reset();
    const api = srv.client();
    const token = await staffToken(api);

    await customer('billed-pro-monthly', { plan: 'pro', stripe: 'sub_pro_m' }, { amount: 5, cycle: 'monthly' });
    await customer('billed-team-yearly', { plan: 'team', stripe: 'sub_team_y' }, { amount: 135, cycle: 'yearly' });
    await customer('billed-pro-yearly', { plan: 'pro', stripe: 'sub_pro_y' }, { amount: 45, cycle: 'yearly' });
    await customer('comped-team', { plan: 'team' });
    await customer('trial-pro', { plan: 'pro', trialEndsAt: 'NOW() + INTERVAL 5 DAY', expiry: 'NOW() + INTERVAL 5 DAY' });
    await customer('lapsed-pro', { plan: 'pro', stripe: 'sub_lapsed', expiry: 'NOW() - INTERVAL 30 DAY' },
      { amount: 5, cycle: 'monthly' });

    const stats = (await api.get('/api/admin/stats', { token })).body.data;
    // 5 (pro monthly) + 135/12 (team yearly) + 45/12 (pro yearly).
    assert.equal(stats.mrr, 20, 'monthly Pro $5 + yearly Team $11.25 + yearly Pro $3.75');
    assert.equal(stats.mrrSubscriptions, 3, 'the figure says how many subscriptions it is made of');
  });

  await t.test('with nothing billed, MRR is honestly zero', async () => {
    await srv.reset();
    const api = srv.client();
    const token = await staffToken(api);
    await customer('comped-pro', { plan: 'pro' });
    await customer('trial-team', { plan: 'team', trialEndsAt: 'NOW() + INTERVAL 5 DAY', expiry: 'NOW() + INTERVAL 5 DAY' });
    const stats = (await api.get('/api/admin/stats', { token })).body.data;
    assert.equal(stats.mrr, 0);
    assert.equal(stats.mrrSubscriptions, 0);
  });

  await t.test('the revenue series is exactly the six months it names, zero-filled', async () => {
    await srv.reset();
    const api = srv.client();
    const token = await staffToken(api);
    const buyer = await customer('buyer', { plan: 'pro', stripe: 'sub_buyer' });
    // Inside the old window (six months back from TODAY) but in the seventh
    // calendar month back — the partial bucket that should not be there.
    await srv.query(
      `INSERT INTO payments (user_id, amount, currency, plan, billing_cycle, status, created_at)
       VALUES (?, 7, 'usd', 'pro', 'monthly', 'paid', DATE_SUB(CURRENT_DATE, INTERVAL 6 MONTH) + INTERVAL 1 HOUR)`,
      [buyer]
    );
    await srv.query(
      `INSERT INTO payments (user_id, amount, currency, plan, billing_cycle, status)
       VALUES (?, 5, 'usd', 'pro', 'monthly', 'paid')`,
      [buyer]
    );

    const series = (await api.get('/api/admin/stats', { token })).body.data.revenueSeries;
    const [dbNow] = await srv.query('SELECT UTC_TIMESTAMP() AS now');
    const expected = lastMonths(6, new Date(dbNow.now));
    assert.deepEqual(series.map((b) => b.month), expected, 'six calendar months, oldest first');
    assert.equal(series.at(-1).revenue, 5, 'this month holds this month\'s payment');
    assert.equal(series.reduce((sum, b) => sum + b.revenue, 0), 5, 'the seventh month back is outside the window');
  });

  await t.test('the creator\'s audit screen gets the 200 rows it asks for', async () => {
    await srv.reset();
    const api = srv.client();
    const token = await rootToken(api);
    const staff = srv.client();
    const staffTok = await staffToken(staff);
    // 250 rows, so there is more than the 200 asked for. Counted after the
    // sign-ins, which may write rows of their own.
    const values = Array.from({ length: 250 }, (_, i) => `('test.row', 'test', ${i + 1}, 'row ${i + 1}')`);
    await srv.query(
      `INSERT INTO audit_logs (action, entity_type, entity_id, summary) VALUES ${values.join(', ')}`
    );

    const root = await api.get('/api/root/audit?limit=200', { token });
    assert.equal(root.status, 200, root.text);
    assert.equal(root.body.data.length, 200, 'the 200 rows the screen asks for and the schema allows');

    const activity = await staff.get('/api/admin/activity?limit=200', { token: staffTok });
    assert.equal(activity.status, 200, activity.text);
    assert.equal(activity.body.data.length, 200, 'the staff feed honours its own 200 ceiling too');

    // And a request above the ceiling is refused at the door, not clamped.
    assert.equal((await api.get('/api/root/audit?limit=201', { token })).status, 400);
  });

  await t.test('release download URLs can be left empty and cleared, and still refuse non-https', async () => {
    await srv.reset();
    const api = srv.client();
    const token = await staffToken(api);

    // The panel sends both fields whenever the external-URL section is open.
    const created = await api.post('/api/admin/releases',
      { version: '9.1.0', changelog: 'x', windowsUrl: '', linuxUrl: '' }, { token });
    assert.equal(created.status, 201, created.text);
    const id = created.body.data.id;

    const set = await api.put(`/api/admin/releases/${id}`,
      { windowsUrl: 'https://cdn.example.test/nexa-9.1.0.exe', linuxUrl: 'https://cdn.example.test/nexa.deb' }, { token });
    assert.equal(set.status, 200, set.text);
    assert.equal(set.body.data.windows_url, 'https://cdn.example.test/nexa-9.1.0.exe');

    const cleared = await api.put(`/api/admin/releases/${id}`, { windowsUrl: '' }, { token });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(cleared.body.data.windows_url, '', 'an empty value clears the stored URL');
    assert.equal(cleared.body.data.linux_url, 'https://cdn.example.test/nexa.deb', 'the other one is untouched');

    const nulled = await api.put(`/api/admin/releases/${id}`, { linuxUrl: null }, { token });
    assert.equal(nulled.status, 200, nulled.text);
    assert.equal(nulled.body.data.linux_url, '', 'null clears too');

    for (const bad of ['http://cdn.example.test/a.exe', 'javascript:alert(1)', 'not a url']) {
      const res = await api.put(`/api/admin/releases/${id}`, { windowsUrl: bad }, { token });
      assert.equal(res.status, 400, `${bad}: ${res.text}`);
    }
    const [row] = await srv.query('SELECT windows_url FROM releases WHERE id = ?', [id]);
    assert.equal(row.windows_url, '', 'a refused value changed nothing');
  });

  await t.test('the exports say when they were cut short, and the subscription one reaches its cap', async () => {
    await srv.reset();
    const api = srv.client();
    const token = await staffToken(api);

    // 5001 customers, each with a subscription — one more than the cap.
    const N = 5001;
    for (let start = 0; start < N; start += 1000) {
      const rows = [];
      for (let i = start; i < Math.min(N, start + 1000); i += 1) rows.push(`('Bulk ${i}', 'bulk${i}@example.test', 'x', 'user', 1)`);
      await srv.query(`INSERT INTO users (name, email, password_hash, role, email_verified) VALUES ${rows.join(', ')}`);
    }
    await srv.query(
      `INSERT INTO subscriptions (user_id, plan, status, license_key, seats, start_date, expiry_date)
       SELECT id, 'free', 'active', CONCAT('NEXA-BULK-', id), 1, NOW(), NOW() + INTERVAL 36500 DAY
         FROM users WHERE email LIKE 'bulk%'`
    );

    const users = await api.get('/api/admin/users/export', { token });
    assert.equal(users.status, 200);
    assert.ok(Array.isArray(users.body.data), 'the body is still the bare array of rows');
    assert.equal(users.body.data.length, 5000);
    assert.equal(users.headers.get('x-export-truncated'), 'true');
    assert.equal(users.headers.get('x-export-total'), String(N + 1), 'the customers and the staff account');
    assert.equal(users.headers.get('x-export-limit'), '5000');

    const subs = await api.get('/api/admin/subscriptions/export', { token });
    assert.equal(subs.status, 200);
    assert.ok(Array.isArray(subs.body.data));
    assert.equal(subs.body.data.length, 5000, 'the cap is 5000, not the 200 the table pages at');
    assert.equal(subs.headers.get('x-export-truncated'), 'true');
    assert.equal(subs.headers.get('x-export-total'), String(N));

    // A filtered export that fits says so.
    const few = await api.get('/api/admin/subscriptions/export?q=bulk4999%40', { token });
    assert.equal(few.body.data.length, 1);
    assert.equal(few.headers.get('x-export-truncated'), 'false');
    assert.equal(few.headers.get('x-export-total'), '1');
  });

  await t.test('the user list says which customer is locked out of sign-in, and unlocking clears it', async () => {
    await srv.reset();
    const api = srv.client();
    const token = await staffToken(api);
    const id = await customer('locked-out', { plan: 'free' });
    await srv.query(
      'UPDATE users SET failed_logins = 10, lock_level = 2, locked_until = NOW() + INTERVAL 1 HOUR WHERE id = ?', [id]
    );

    const find = async () => (await api.get('/api/admin/users?q=locked-out', { token })).body.data.users[0];
    const before = await find();
    assert.ok(before.signInLockedUntil, 'the lock is visible to support');
    assert.equal(before.signInLockReason, 'password');
    assert.equal('failed_logins' in before, false, 'the counters stay private');
    assert.equal('locked_until' in before, false);

    const unlock = await api.post(`/api/admin/users/${id}/unlock`, {}, { token });
    assert.equal(unlock.status, 200, unlock.text);
    assert.equal((await find()).signInLockedUntil, null);
  });

  await t.test('a customer locked out of the authenticator-code step shows as locked too, and unlocking clears it', async () => {
    await srv.reset();
    const api = srv.client();
    const token = await staffToken(api);
    const id = await customer('code-locked', { plan: 'free' });
    // The password is fine; the second step is what is locked
    // (utils/twoFactorLockout.js). The unlock route already lifted this lock,
    // but the list only ever showed the password one, so support never saw it.
    await srv.query(
      'UPDATE users SET totp_failures = 5, totp_lock_level = 1, totp_locked_until = NOW() + INTERVAL 30 MINUTE WHERE id = ?', [id]
    );

    const find = async () => (await api.get('/api/admin/users?q=code-locked', { token })).body.data.users[0];
    const before = await find();
    assert.ok(before.signInLockedUntil, 'the code lock is visible to support');
    assert.equal(before.signInLockReason, 'two_factor');
    assert.equal('totp_locked_until' in before, false, 'the raw column stays private');
    assert.equal('totp_failures' in before, false);

    const unlock = await api.post(`/api/admin/users/${id}/unlock`, {}, { token });
    assert.equal(unlock.status, 200, unlock.text);
    assert.equal(unlock.body.data.wasLocked, true);
    const after = await find();
    assert.equal(after.signInLockedUntil, null);
    assert.equal(after.signInLockReason, null);
  });

  await srv.stop();
});
