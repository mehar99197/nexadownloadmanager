'use strict';
/**
 * Per-account sign-in lockout, cookie flags and the flat query parser —
 * end to end against the real app and a real MySQL (see test/README.md).
 *
 * The (IP, email) limiter is off here (RATE_LIMIT_DISABLED) on purpose: the
 * lockout exists for the guesses that limiter cannot see — many addresses,
 * one account — and with it off every request looks like a different one.
 */
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
process.env.LOGIN_LOCKOUT_THRESHOLD = '5';
process.env.LOGIN_LOCKOUT_MINUTES = '15';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const srv = require('./helpers/testServer');
const { signResetToken } = require('../src/utils/jwt');
const User = require('../src/models/User');

const PASS = 'a-correct-password-1';

async function captureMail(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  try { await fn(); } finally { console.log = original; }
  return lines.join('\n');
}

async function signUp(api, email) {
  const reg = await api.post('/api/auth/register', { name: 'Test Person', email, password: PASS });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const [row] = await srv.query('SELECT id FROM users WHERE email = ?', [email]);
  return row.id;
}

const login = (api, email, password) => api.post('/api/auth/login', { email, password });

async function lockState(id) {
  const [row] = await srv.query(
    'SELECT failed_logins, lock_level, locked_until, lock_notified_at FROM users WHERE id = ?', [id]
  );
  return row;
}

test('sign-in lockout', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();

  await t.test('the threshold of wrong passwords locks the account, silently, and tells the owner', async () => {
    await srv.reset();
    const api = srv.client();
    const id = await signUp(api, 'locked@example.test');

    for (let i = 1; i < 5; i++) {
      const res = await login(api, 'locked@example.test', 'wrong-' + i);
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
      assert.equal((await lockState(id)).failed_logins, i);
    }

    // The fifth wrong guess trips the lock and the notice goes out once.
    const mail = await captureMail(async () => {
      const res = await login(api, 'locked@example.test', 'wrong-5');
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
      // The mail is sent without being awaited by the route.
      await new Promise((r) => setTimeout(r, 50));
    });
    assert.match(mail, /locked@example\.test/);
    assert.match(mail, /paused for 15 minutes/);
    const state = await lockState(id);
    assert.ok(state.locked_until, 'locked_until is set');
    assert.equal(state.failed_logins, 0);
    assert.equal(state.lock_level, 1);
    assert.ok(state.lock_notified_at);

    // The CORRECT password is refused while the lock holds — with the same
    // answer as a wrong one, so nothing about the lock shows on the wire.
    const right = await login(api, 'locked@example.test', PASS);
    assert.equal(right.status, 401);
    assert.deepEqual(right.body.error, { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });

    // …and guesses during the lock do not keep counting (they never reach the hash).
    await login(api, 'locked@example.test', 'wrong-again');
    assert.equal((await lockState(id)).failed_logins, 0);
  });

  await t.test('an expired lock lets the right password in and zeroes the counters', async () => {
    await srv.reset();
    const api = srv.client();
    const id = await signUp(api, 'expired@example.test');
    await srv.query(
      'UPDATE users SET failed_logins = 3, lock_level = 2, locked_until = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?',
      [id]
    );
    const res = await login(api, 'expired@example.test', PASS);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const state = await lockState(id);
    assert.equal(state.failed_logins, 0);
    assert.equal(state.lock_level, 0);
    assert.equal(state.locked_until, null);
  });

  await t.test('a second lock lasts twice as long and does not mail again the same day', async () => {
    await srv.reset();
    const api = srv.client();
    const id = await signUp(api, 'again@example.test');
    await srv.query(
      'UPDATE users SET lock_level = 1, lock_notified_at = NOW() WHERE id = ?', [id]
    );
    const mail = await captureMail(async () => {
      for (let i = 0; i < 5; i++) await login(api, 'again@example.test', 'wrong');
      await new Promise((r) => setTimeout(r, 50));
    });
    assert.doesNotMatch(mail, /paused for/);
    const state = await lockState(id);
    assert.equal(state.lock_level, 2);
    const [row] = await srv.query(
      'SELECT TIMESTAMPDIFF(MINUTE, NOW(), locked_until) AS minutes FROM users WHERE id = ?', [id]
    );
    assert.ok(row.minutes >= 29 && row.minutes <= 30, `second lock is ~30 minutes, got ${row.minutes}`);
  });

  await t.test('a password reset ends the lock at once', async () => {
    await srv.reset();
    const api = srv.client();
    const id = await signUp(api, 'reset@example.test');
    for (let i = 0; i < 5; i++) await login(api, 'reset@example.test', 'wrong');
    assert.ok((await lockState(id)).locked_until);

    const user = await User.findById(id);
    const reset = await api.post('/api/auth/reset-password',
      { token: signResetToken(user), password: 'a-brand-new-passphrase-99' });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    const state = await lockState(id);
    assert.equal(state.locked_until, null);
    assert.equal(state.lock_level, 0);
    assert.equal((await login(api, 'reset@example.test', 'a-brand-new-passphrase-99')).status, 200);
  });

  await t.test('an admin can lift the lock, and it is audited', async () => {
    await srv.reset();
    const api = srv.client();
    const id = await signUp(api, 'support@example.test');
    for (let i = 0; i < 5; i++) await login(api, 'support@example.test', 'wrong');

    const hash = await bcrypt.hash('admin-password-123', 12);
    await srv.query(
      "INSERT INTO users (name, email, password_hash, role, email_verified) VALUES ('Staff', 'staff@example.test', ?, 'admin', 1)",
      [hash]
    );
    const admin = srv.client();
    const adminLogin = await admin.post('/api/admin/login', { email: 'staff@example.test', password: 'admin-password-123' });
    assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.body));
    const auth = { token: adminLogin.body.data.token };

    const bad = await admin.post('/api/admin/users/not-a-number/unlock', {}, auth);
    assert.equal(bad.status, 400);

    const unlocked = await admin.post(`/api/admin/users/${id}/unlock`, {}, auth);
    assert.equal(unlocked.status, 200, JSON.stringify(unlocked.body));
    assert.equal(unlocked.body.data.wasLocked, true);
    assert.equal((await lockState(id)).locked_until, null);
    assert.equal((await login(api, 'support@example.test', PASS)).status, 200);

    const [audit] = await srv.query("SELECT action, entity_id FROM audit_logs WHERE action = 'user.unlocked'");
    assert.equal(Number(audit.entity_id), id);
  });

  await t.test('a control-panel account cannot be locked from the customer form', async () => {
    await srv.reset();
    const api = srv.client();
    const hash = await bcrypt.hash('admin-password-123', 12);
    await srv.query(
      "INSERT INTO users (name, email, password_hash, role, email_verified) VALUES ('Staff', 'staff2@example.test', ?, 'admin', 1)",
      [hash]
    );
    for (let i = 0; i < 6; i++) await login(api, 'staff2@example.test', 'wrong');
    const [row] = await srv.query("SELECT failed_logins, locked_until FROM users WHERE email = 'staff2@example.test'");
    assert.equal(row.failed_logins, 0);
    assert.equal(row.locked_until, null);
  });

  await t.test('a hash made at a lower cost is upgraded on sign-in', async () => {
    await srv.reset();
    const api = srv.client();
    const id = await signUp(api, 'oldhash@example.test');
    await srv.query('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(PASS, 8), id]);
    assert.equal((await login(api, 'oldhash@example.test', PASS)).status, 200);
    const [row] = await srv.query('SELECT password_hash FROM users WHERE id = ?', [id]);
    assert.equal(bcrypt.getRounds(row.password_hash), 12);
    assert.ok(await bcrypt.compare(PASS, row.password_hash));
  });

  await t.test('the lock bookkeeping never reaches the profile', async () => {
    await srv.reset();
    const api = srv.client();
    await signUp(api, 'profile@example.test');
    const token = (await login(api, 'profile@example.test', PASS)).body.data.token;
    const me = await api.get('/api/user/me', { token });
    assert.equal(me.status, 200);
    const text = JSON.stringify(me.body);
    for (const key of ['failed_logins', 'locked_until', 'lock_level', 'lock_notified_at']) {
      assert.ok(!text.includes(key), `${key} leaked into /user/me`);
    }
  });
  // The second suite below reuses the server; it stops it.
});

test('session cookies and request parsing', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();

  await t.test('the refresh cookie is httpOnly, path-scoped and SameSite=Strict; the hint is not', async () => {
    await srv.reset();
    await signUp(srv.client(), 'cookies@example.test');
    const res = await fetch(`${await srv.start()}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'cookies@example.test', password: PASS }),
    });
    assert.equal(res.status, 200);
    const cookies = res.headers.getSetCookie();
    const refresh = cookies.find((c) => c.startsWith('ndm_refresh='));
    const hint = cookies.find((c) => c.startsWith('ndm_session='));
    assert.ok(refresh && hint, cookies.join(' | '));
    assert.match(refresh, /; *HttpOnly/i);
    assert.match(refresh, /; *SameSite=Strict/i);
    assert.match(refresh, /; *Path=\/api\/auth/i);
    assert.doesNotMatch(hint, /HttpOnly/i);
    assert.match(hint, /; *SameSite=Lax/i);
  });

  await t.test('query strings are flat: bracket syntax is not turned into arrays or objects', async () => {
    const base = await srv.start();
    // With the extended parser `q[]=x` became `{ q: ['x'] }`; now the key is
    // literally "q[]", which the strict schema refuses, and `q=x` is a string.
    const bracket = await fetch(`${base}/api/reviews?page[]=1`);
    assert.equal(bracket.status, 400);
    const plain = await fetch(`${base}/api/reviews?page=1&limit=5`);
    assert.equal(plain.status, 200);
  });

  await srv.stop();
});
