'use strict';
/**
 * Per-browser sessions with rotation and replay detection, customer TOTP,
 * enforced panel TOTP, the Google nonce gate, the security-event feed and
 * its alert rules — end to end against the real app and MySQL.
 */
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
process.env.ACCESS_TOKEN_TTL = '15m';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const srv = require('./helpers/testServer');
const config = require('../src/config/env');
const totp = require('../src/utils/totp');
const security = require('../src/utils/securityEvents');

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
const login = (api, email, password = PASS) => api.post('/api/auth/login', { email, password });

/** A raw fetch that lets a test hold on to a specific cookie value. */
async function rawPost(path, { cookie, body } = {}) {
  const res = await fetch(`${await srv.start()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body || {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const refresh = setCookies.find((c) => c.startsWith('ndm_refresh='));
  return { status: res.status, body: json, refresh: refresh ? refresh.split(';')[0] : null };
}

async function makeAdmin(email = 'staff@example.test') {
  const hash = await bcrypt.hash('admin-password-123', 12);
  await srv.query(
    "INSERT INTO users (name, email, password_hash, role, email_verified) VALUES ('Staff', ?, ?, 'admin', 1)",
    [email, hash]
  );
  const admin = srv.client();
  const res = await admin.post('/api/admin/login', { email, password: 'admin-password-123' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { admin, auth: { token: res.body.data.token }, email };
}

test('browser sessions', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();

  await t.test('two browsers hold two independent sessions and a short access token', async () => {
    await srv.reset();
    const a = srv.client();
    const b = srv.client();
    await signUp(a, 'two@example.test');
    const la = await login(a, 'two@example.test');
    const lb = await login(b, 'two@example.test');
    assert.equal(la.status, 200);
    assert.equal(lb.status, 200);
    const payload = jwt.decode(la.body.data.token);
    assert.equal(payload.exp - payload.iat, 15 * 60, 'access token lives 15 minutes');
    // Signing in on B did not end A (the single-slot design used to).
    assert.equal((await a.post('/api/auth/refresh', {})).status, 200);
    assert.equal((await b.post('/api/auth/refresh', {})).status, 200);
    const [{ n }] = await srv.query('SELECT COUNT(*) AS n FROM user_sessions WHERE revoked_at IS NULL');
    assert.equal(Number(n), 2);
  });

  await t.test('refresh rotates the cookie; a replay within the grace window is tolerated', async () => {
    await srv.reset();
    await signUp(srv.client(), 'rot@example.test');
    const first = await rawPost('/api/auth/login', { body: { email: 'rot@example.test', password: PASS } });
    assert.ok(first.refresh);
    const second = await rawPost('/api/auth/refresh', { cookie: first.refresh });
    assert.equal(second.status, 200);
    assert.ok(second.refresh && second.refresh !== first.refresh, 'a new cookie every refresh');
    // Two tabs racing: the OLD cookie again, a moment later.
    const raced = await rawPost('/api/auth/refresh', { cookie: first.refresh });
    assert.equal(raced.status, 200, JSON.stringify(raced.body));
    assert.ok(raced.refresh, 'rotated again rather than refused');
  });

  await t.test('a rotated cookie replayed later is a stolen cookie: family revoked, critical event', async () => {
    await srv.reset();
    const other = srv.client();
    await signUp(other, 'theft@example.test');
    await login(other, 'theft@example.test');           // an unrelated session on another browser
    const first = await rawPost('/api/auth/login', { body: { email: 'theft@example.test', password: PASS } });
    const second = await rawPost('/api/auth/refresh', { cookie: first.refresh });
    assert.equal(second.status, 200);
    await srv.query('UPDATE user_sessions SET rotated_at = DATE_SUB(NOW(), INTERVAL 2 MINUTE) WHERE prev_token_hash IS NOT NULL');

    const replay = await rawPost('/api/auth/refresh', { cookie: first.refresh });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, 'INVALID_REFRESH_TOKEN');
    // The legitimate holder of the newest cookie is out too — the family is gone…
    const victim = await rawPost('/api/auth/refresh', { cookie: second.refresh });
    assert.equal(victim.status, 401);
    // …but the other browser's session is untouched.
    assert.equal((await other.post('/api/auth/refresh', {})).status, 200);
    const [ev] = await srv.query("SELECT kind, severity, email FROM security_events WHERE kind = 'session.reuse_detected'");
    assert.ok(ev, 'the replay is on the security feed');
    assert.equal(ev.severity, 'critical');
    assert.equal(ev.email, 'theft@example.test');
  });

  await t.test('logout ends only this browser; a password change ends every other one', async () => {
    await srv.reset();
    const a = srv.client();
    const b = srv.client();
    await signUp(a, 'lo@example.test');
    await login(a, 'lo@example.test');
    const tb = (await login(b, 'lo@example.test')).body.data.token;
    assert.equal((await a.post('/api/auth/logout', {})).status, 200);
    assert.equal((await a.post('/api/auth/refresh', {})).status, 401);
    assert.equal((await b.post('/api/auth/refresh', {})).status, 200, 'B survives A logging out');

    const c = srv.client();
    const tc = (await login(c, 'lo@example.test')).body.data.token;
    const changed = await c.put('/api/user/profile', { currentPassword: PASS, newPassword: 'another-fine-password-2' }, { token: tc });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal((await b.post('/api/auth/refresh', {})).status, 401, 'B is signed out by the change');
    assert.equal((await b.get('/api/user/me', { token: tb })).status, 401);
    assert.equal((await c.post('/api/auth/refresh', {})).status, 200, 'the changer keeps a fresh session');
  });

  await t.test('the account page lists sessions, signs one out, and signs out everywhere else', async () => {
    await srv.reset();
    const a = srv.client();
    const b = srv.client();
    const c = srv.client();
    await signUp(a, 'list@example.test');
    const ta = (await login(a, 'list@example.test')).body.data.token;
    await login(b, 'list@example.test');
    await login(c, 'list@example.test');
    const list = await a.get('/api/user/sessions', { token: ta });
    assert.equal(list.status, 200);
    assert.equal(list.body.data.sessions.length, 3);
    assert.equal(list.body.data.sessions.filter((s) => s.current).length, 1);
    const victim = list.body.data.sessions.find((s) => !s.current);
    assert.equal((await a.del(`/api/user/sessions/${victim.id}`, { token: ta })).status, 200);
    assert.equal((await a.del('/api/user/sessions/999999', { token: ta })).status, 404);
    const others = await a.post('/api/user/sessions/revoke-others', {}, { token: ta });
    assert.equal(others.status, 200);
    assert.equal(others.body.data.revoked, 1);
    assert.equal((await a.post('/api/auth/refresh', {})).status, 200);
    assert.equal((await b.post('/api/auth/refresh', {})).status, 401);
    assert.equal((await c.post('/api/auth/refresh', {})).status, 401);
  });
});

test('customer two-factor authentication', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();

  await t.test('enrol, sign in with a code, refuse wrong and replayed codes, use a recovery code, disable', async () => {
    await srv.reset();
    const api = srv.client();
    await signUp(api, 'totp@example.test');
    const token = (await login(api, 'totp@example.test')).body.data.token;

    const state = await api.get('/api/auth/2fa', { token });
    assert.deepEqual(state.body.data, { enabled: false, pending: false, recoveryCodesLeft: 0, recoveryCodesLegacy: false });
    const setup = await api.post('/api/auth/2fa/setup', {}, { token });
    assert.equal(setup.status, 200, JSON.stringify(setup.body));
    assert.match(setup.body.data.otpauthUrl, /^otpauth:\/\/totp\/.*issuer=Nexa\+Download\+Manager/);
    const secret = setup.body.data.secret;
    const [row] = await srv.query("SELECT totp_secret FROM users WHERE email = 'totp@example.test'");
    assert.notEqual(row.totp_secret, secret, 'the secret is encrypted at rest');

    const bad = await api.post('/api/auth/2fa/enable', { password: PASS, code: '000000' }, { token });
    assert.equal(bad.status, 400);
    const enable = await api.post('/api/auth/2fa/enable', { password: PASS, code: totp.totpAt(secret) }, { token });
    assert.equal(enable.status, 200, JSON.stringify(enable.body));
    assert.equal(enable.body.data.recoveryCodes.length, totp.RECOVERY_COUNT);
    const recovery = enable.body.data.recoveryCodes[0];

    // A fresh browser: the password alone yields a challenge, not a session.
    const fresh = srv.client();
    const step1 = await login(fresh, 'totp@example.test');
    assert.equal(step1.status, 200);
    assert.equal(step1.body.data.requiresTwoFactor, true);
    assert.ok(step1.body.data.challenge);
    assert.equal(step1.body.data.token, undefined);
    assert.equal((await fresh.post('/api/auth/refresh', {})).status, 401, 'no cookie until the code');

    const wrong = await fresh.post('/api/auth/login/2fa', { challenge: step1.body.data.challenge, code: '123456' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, 'INVALID_CODE');
    const code = totp.totpAt(secret, Date.now() + totp.STEP_SECONDS * 1000);   // a step later than enrolment used
    const done = await fresh.post('/api/auth/login/2fa', { challenge: step1.body.data.challenge, code });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.ok(done.body.data.token);
    assert.equal((await fresh.post('/api/auth/refresh', {})).status, 200);

    // The same code again is a replay.
    const again = await login(srv.client(), 'totp@example.test');
    const replay = await fresh.post('/api/auth/login/2fa', { challenge: again.body.data.challenge, code });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, 'CODE_ALREADY_USED');

    // A recovery code works once.
    const rc = await fresh.post('/api/auth/login/2fa', { challenge: again.body.data.challenge, code: recovery });
    assert.equal(rc.status, 200, JSON.stringify(rc.body));
    const again2 = await login(srv.client(), 'totp@example.test');
    const rcAgain = await fresh.post('/api/auth/login/2fa', { challenge: again2.body.data.challenge, code: recovery });
    assert.equal(rcAgain.status, 401);

    const kinds = (await srv.query("SELECT kind FROM security_events WHERE kind LIKE '2fa.%' ORDER BY id")).map((r) => r.kind);
    // …and the spent recovery code presented again is just another failed code.
    assert.deepEqual(kinds, ['2fa.enabled', '2fa.failed', '2fa.replayed', '2fa.recovery_used', '2fa.failed']);

    // Disable needs the password AND a code. The sign-in above consumed this
    // time step (a code never works twice), so the replay guard is reset the
    // way thirty seconds would — the test is about the password + code rule.
    const t2 = done.body.data.token;
    await srv.query("UPDATE users SET totp_last_step = NULL WHERE email = 'totp@example.test'");
    const noPw = await fresh.post('/api/auth/2fa/disable', { password: 'nope-nope-nope', code: totp.totpAt(secret) }, { token: t2 });
    assert.equal(noPw.status, 400);
    const omitted = await fresh.post('/api/auth/2fa/disable', { code: totp.totpAt(secret) }, { token: t2 });
    assert.equal(omitted.status, 400, 'an account with a password cannot skip it');
    assert.equal(omitted.body.error.code, 'INVALID_PASSWORD');
    const off = await fresh.post('/api/auth/2fa/disable', { password: PASS, code: totp.totpAt(secret) }, { token: t2 });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal((await login(srv.client(), 'totp@example.test')).body.data.requiresTwoFactor, undefined);

    // A Google-created account has no password: the authenticator code alone
    // turns two-factor off (the same allowance routes/user.js makes for
    // deleting such an account), so enrolling can never strand it.
    await srv.query("UPDATE users SET password_hash = NULL, totp_last_step = NULL WHERE email = 'totp@example.test'");
    const setup2 = await fresh.post('/api/auth/2fa/setup', {}, { token: t2 });
    assert.equal(setup2.status, 200, JSON.stringify(setup2.body));
    const secret2 = setup2.body.data.secret;
    const on2 = await fresh.post('/api/auth/2fa/enable', { code: totp.totpAt(secret2) }, { token: t2 });
    assert.equal(on2.status, 200, JSON.stringify(on2.body));
    await srv.query("UPDATE users SET totp_last_step = NULL WHERE email = 'totp@example.test'");
    const off2 = await fresh.post('/api/auth/2fa/disable', { code: totp.totpAt(secret2) }, { token: t2 });
    assert.equal(off2.status, 200, JSON.stringify(off2.body));
    assert.equal((await fresh.get('/api/auth/2fa', { token: t2 })).body.data.enabled, false);
  });

  await t.test('turning 2FA on needs the password, so a stolen access token alone cannot enrol it', async () => {
    await srv.reset();
    const api = srv.client();
    await signUp(api, 'enrol@example.test');
    const token = (await login(api, 'enrol@example.test')).body.data.token;
    const secret = (await api.post('/api/auth/2fa/setup', {}, { token })).body.data.secret;

    const missing = await api.post('/api/auth/2fa/enable', { code: totp.totpAt(secret) }, { token });
    assert.equal(missing.status, 400, JSON.stringify(missing.body));
    assert.equal(missing.body.error.code, 'INVALID_PASSWORD');
    const wrong = await api.post('/api/auth/2fa/enable',
      { password: 'not-the-password-1', code: totp.totpAt(secret) }, { token });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.code, 'INVALID_PASSWORD');
    assert.equal((await api.get('/api/auth/2fa', { token })).body.data.enabled, false,
      'nothing was switched on by a request without the password');

    // The refused attempts did not spend the code: the owner's own attempt with
    // the same digits and the password goes straight through.
    const right = await api.post('/api/auth/2fa/enable', { password: PASS, code: totp.totpAt(secret) }, { token });
    assert.equal(right.status, 200, JSON.stringify(right.body));
    assert.equal(right.body.data.recoveryCodes.length, totp.RECOVERY_COUNT);

    // The staff panels mount the same routes, so they need it too.
    const { admin, auth } = await makeAdmin();
    const adminSecret = (await admin.post('/api/admin/2fa/setup', {}, auth)).body.data.secret;
    const bare = await admin.post('/api/admin/2fa/enable', { code: totp.totpAt(adminSecret) }, auth);
    assert.equal(bare.status, 400);
    assert.equal(bare.body.error.code, 'INVALID_PASSWORD');
    const proved = await admin.post('/api/admin/2fa/enable',
      { password: 'admin-password-123', code: totp.totpAt(adminSecret) }, auth);
    assert.equal(proved.status, 200, JSON.stringify(proved.body));
  });

  await t.test('wrong second-factor codes lock the code step for that account, and a correct code clears it', async () => {
    await srv.reset();
    const api = srv.client();
    const email = 'guessed@example.test';
    await signUp(api, email);
    // Enrolled directly, so this test depends on nothing but the login route.
    const secret = totp.generateSecret();
    const recovery = 'k7f3q-9x2mp';
    await srv.query(
      'UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_recovery = ? WHERE email = ?',
      [totp.encryptSecret(secret), JSON.stringify([await totp.hashRecoveryCode(recovery)]), email]
    );
    const challenge = async () => {
      const res = await login(srv.client(), email);
      assert.equal(res.body.data.requiresTwoFactor, true, JSON.stringify(res.body));
      return res.body.data.challenge;
    };
    const liveCodes = () => [-1, 0, 1].map((s) => totp.totpAt(secret, Date.now() + s * totp.STEP_SECONDS * 1000));
    const wrongCode = () => {
      for (let n = 0; ; n += 1) {
        const guess = String(n).padStart(6, '0');
        if (!liveCodes().includes(guess)) return guess;
      }
    };
    const guess = async (code) => api.post('/api/auth/login/2fa', { challenge: await challenge(), code });
    const unspend = () => srv.query('UPDATE users SET totp_last_step = NULL WHERE email = ?', [email]);

    // Four wrong codes and then the right one: an honest typo streak signs in,
    // and the success wipes the count.
    for (let i = 0; i < 4; i += 1) assert.equal((await guess(wrongCode())).status, 401);
    assert.equal((await guess(totp.totpAt(secret))).status, 200);
    await unspend();
    for (let i = 0; i < 4; i += 1) assert.equal((await guess(wrongCode())).status, 401);
    assert.equal((await guess(totp.totpAt(secret))).status, 200, 'the earlier streak was cleared by the success');
    await unspend();

    // Five in a row — each from a FRESH challenge, since whoever holds the
    // password can mint as many as they like — and the code step locks.
    const streak = [];
    for (let i = 0; i < 5; i += 1) streak.push(await guess(wrongCode()));
    assert.deepEqual(streak.slice(0, 4).map((r) => r.status), [401, 401, 401, 401]);
    assert.equal(streak[4].status, 429);
    assert.equal(streak[4].body.error.code, 'TWO_FACTOR_LOCKED');

    // Now even the right authenticator code is refused: that is the lock.
    const blocked = await guess(totp.totpAt(secret));
    assert.equal(blocked.status, 429, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error.code, 'TWO_FACTOR_LOCKED');
    const [row] = await srv.query('SELECT totp_last_step, failed_logins, locked_until FROM users WHERE email = ?', [email]);
    assert.equal(row.totp_last_step, null, 'a refused code is not spent');
    // The password gate is a different lock and is untouched by code guesses.
    assert.equal(Number(row.failed_logins), 0);
    assert.equal(row.locked_until, null);

    // The owner is not stranded: a recovery code (52 bits, not guessable)
    // still gets through, and it clears the lock.
    const rescued = await guess(recovery);
    assert.equal(rescued.status, 200, JSON.stringify(rescued.body));
    assert.equal((await guess(totp.totpAt(secret))).status, 200, 'the authenticator works again');

    const kinds = (await srv.query("SELECT kind FROM security_events WHERE kind = '2fa.locked'")).map((r) => r.kind);
    assert.deepEqual(kinds, ['2fa.locked']);
  });

  await t.test('the code-step lock ends on its own, and only counts accounts that have 2FA', async () => {
    await srv.reset();
    const api = srv.client();
    await signUp(api, 'plain@example.test');
    // An account without two-factor has no code step: sign-in is unaffected.
    const plain = await login(api, 'plain@example.test');
    assert.ok(plain.body.data.token);
    const [row] = await srv.query("SELECT totp_failures, totp_locked_until FROM users WHERE email = 'plain@example.test'");
    assert.equal(Number(row.totp_failures), 0);
    assert.equal(row.totp_locked_until, null);

    // A lock whose time has passed lets the right code straight back in.
    const secret = totp.generateSecret();
    await srv.query(
      `UPDATE users SET totp_secret = ?, totp_enabled = 1,
         totp_locked_until = DATE_SUB(NOW(), INTERVAL 1 MINUTE), totp_lock_level = 1
       WHERE email = 'plain@example.test'`,
      [totp.encryptSecret(secret)]
    );
    const step1 = await login(srv.client(), 'plain@example.test');
    const done = await api.post('/api/auth/login/2fa', { challenge: step1.body.data.challenge, code: totp.totpAt(secret) });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const [after] = await srv.query("SELECT totp_lock_level, totp_locked_until FROM users WHERE email = 'plain@example.test'");
    assert.equal(Number(after.totp_lock_level), 0, 'a correct code resets the escalation too');
    assert.equal(after.totp_locked_until, null);
  });

  await t.test('the control panel refuses everything but enrolment until TOTP is on', async () => {
    await srv.reset();
    const was = config.ADMIN_2FA_REQUIRED;
    config.ADMIN_2FA_REQUIRED = true;
    try {
      const { admin, auth } = await makeAdmin();
      const blocked = await admin.get('/api/admin/stats', auth);
      assert.equal(blocked.status, 403);
      assert.equal(blocked.body.error.code, 'TWO_FACTOR_REQUIRED');
      const me = await admin.get('/api/admin/me', auth);
      assert.equal(me.status, 200);
      // …and /me says why, so the SPA can go straight to the setup screen.
      assert.equal(me.body.data.twoFactorRequired, true);
      assert.equal(me.body.data.twoFactorEnabled, false);
      const setup = await admin.post('/api/admin/2fa/setup', {}, auth);
      assert.equal(setup.status, 200, JSON.stringify(setup.body));
      const enable = await admin.post('/api/admin/2fa/enable',
        { password: 'admin-password-123', code: totp.totpAt(setup.body.data.secret) }, auth);
      assert.equal(enable.status, 200, JSON.stringify(enable.body));
      assert.equal((await admin.get('/api/admin/stats', auth)).status, 200, 'enrolled: the panel opens');
      assert.equal((await admin.get('/api/admin/me', auth)).body.data.twoFactorEnabled, true);
    } finally {
      config.ADMIN_2FA_REQUIRED = was;
    }
  });
});

test('google nonce gate and the security feed', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();

  await t.test('a Google sign-in without this server\'s nonce cookie is refused', async () => {
    await srv.reset();
    const was = { id: config.GOOGLE_CLIENT_ID, on: config.isGoogleAuthEnabled };
    config.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
    config.isGoogleAuthEnabled = true;
    try {
      const base = await srv.start();
      const nonceRes = await fetch(`${base}/api/auth/google/nonce`);
      assert.equal(nonceRes.status, 200);
      const { nonce } = (await nonceRes.json()).data;
      const cookie = nonceRes.headers.getSetCookie().find((c) => c.startsWith('ndm_gnonce='));
      assert.ok(cookie && /HttpOnly/i.test(cookie) && /Path=\/api\/auth\/google/i.test(cookie), cookie);
      assert.match(nonce, /^[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]+$/);

      const noCookie = await rawPost('/api/auth/google', { body: { credential: 'x'.repeat(40), nonce } });
      assert.equal(noCookie.status, 401);
      assert.equal(noCookie.body.error.code, 'GOOGLE_NONCE_INVALID');
      const forged = await rawPost('/api/auth/google', { cookie: 'ndm_gnonce=abc.999999999999999.forgedsig', body: { credential: 'x'.repeat(40) } });
      assert.equal(forged.status, 401);
      assert.equal(forged.body.error.code, 'GOOGLE_NONCE_INVALID');
      // A valid nonce gets as far as the token itself, which is not Google's.
      const real = await rawPost('/api/auth/google', { cookie: cookie.split(';')[0], body: { credential: 'x'.repeat(40), nonce } });
      assert.equal(real.status, 401);
      assert.equal(real.body.error.code, 'GOOGLE_AUTH_FAILED');
      const kinds = (await srv.query("SELECT kind FROM security_events WHERE kind LIKE 'google.%' ORDER BY id")).map((r) => r.kind);
      assert.deepEqual(kinds, ['google.nonce_rejected', 'google.nonce_rejected', 'google.token_rejected']);
    } finally {
      config.GOOGLE_CLIENT_ID = was.id;
      config.isGoogleAuthEnabled = was.on;
    }
  });

  await t.test('failed sign-ins land on the feed, the admin can read it, and a burst mails one alert', async () => {
    await srv.reset();
    security._lastAlertAt.clear();
    const api = srv.client();
    await signUp(api, 'feed@example.test');
    const mail = await captureMail(async () => {
      for (let i = 0; i < 25; i++) await login(api, `nobody-${i}@example.test`, 'guess');
      await new Promise((r) => setTimeout(r, 100));
    });
    const alerts = (mail.match(/\[security\] \d+ × login\.failed/g) || []).length;
    assert.equal(alerts, 1, 'one alert for the burst, not one per failure');
    assert.match(mail, /credential-stuffing/);

    const { admin, auth } = await makeAdmin();
    const feed = await admin.get('/api/admin/security/events?hours=1&kind=login.failed', auth);
    assert.equal(feed.status, 200, JSON.stringify(feed.body));
    assert.equal(feed.body.data.events.length, 25);
    assert.ok(feed.body.data.counts.some((c) => c.kind === 'login.failed' && c.n === 25));
    assert.equal((await admin.get('/api/admin/security/events?kind=DROP%20TABLE', auth)).status, 400);
  });

  await srv.stop();
});
