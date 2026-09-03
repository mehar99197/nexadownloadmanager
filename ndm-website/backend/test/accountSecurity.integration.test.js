'use strict';

/**
 * Account security: session revocation, single-use reset links, and the rule
 * that an unverified address gets nothing.
 *
 * Every case here is a hole that was open before: a seven-day bearer token that
 * outlived the password change meant to kill it, a reset link that kept working
 * after it had been used, and a licence key handed to an address nobody had
 * proved they owned.
 */
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_DISABLED = '1';
// The suite drives both settings, so pin the default it starts from.
process.env.EMAIL_VERIFICATION_REQUIRED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const srv = require('./helpers/testServer');
const config = require('../src/config/env');
const { signResetToken } = require('../src/utils/jwt');
const User = require('../src/models/User');

async function signUp(api, email, password = 'password-1234') {
  const reg = await api.post('/api/auth/register', { name: 'Test Person', email, password });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const [row] = await srv.query('SELECT id FROM users WHERE email = ?', [email]);
  return row.id;
}

async function login(api, email, password = 'password-1234') {
  const res = await api.post('/api/auth/login', { email, password });
  return res;
}

test('account security', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();

  await t.test('a password change ends every other session immediately', async () => {
    await srv.reset();
    const api = srv.client();
    const id = await signUp(api, 'rotate@example.test');
    await srv.query('UPDATE users SET email_verified = 1 WHERE id = ?', [id]);

    const stolen = (await login(api, 'rotate@example.test')).body.data.token;
    assert.equal((await api.get('/api/user/me', { token: stolen })).status, 200);

    // The owner changes their password from another session.
    const owner = srv.client();
    const ownerToken = (await login(owner, 'rotate@example.test')).body.data.token;
    const changed = await owner.put('/api/user/profile',
      { currentPassword: 'password-1234', newPassword: 'a-brand-new-password' },
      { token: ownerToken });
    assert.equal(changed.status, 200);

    // The stolen token is dead — this is what a 7-day access token used to
    // survive, because only the refresh hash was cleared.
    const after = await api.get('/api/user/me', { token: stolen });
    assert.equal(after.status, 401);
    assert.equal(after.body.error.code, 'SESSION_REVOKED');

    // …and the session that made the change keeps working, on its new token.
    assert.ok(changed.body.data.token, 'a replacement token is returned');
    assert.equal((await owner.get('/api/user/me', { token: changed.body.data.token })).status, 200);
  });

  await t.test('an admin revoking sessions takes effect at once', async () => {
    await srv.reset();
    const api = srv.client();
    const id = await signUp(api, 'revoked@example.test');
    await srv.query('UPDATE users SET email_verified = 1 WHERE id = ?', [id]);
    const token = (await login(api, 'revoked@example.test')).body.data.token;
    assert.equal((await api.get('/api/user/me', { token })).status, 200);

    await User.revokeSessions(id);

    const after = await api.get('/api/user/me', { token });
    assert.equal(after.status, 401);
    assert.equal(after.body.error.code, 'SESSION_REVOKED');
  });

  await t.test('a password reset link works exactly once', async () => {
    await srv.reset();
    const api = srv.client();
    const id = await signUp(api, 'reset@example.test');
    await srv.query('UPDATE users SET email_verified = 1 WHERE id = ?', [id]);

    const link = signResetToken(await User.findById(id));
    const first = await api.post('/api/auth/reset-password', { token: link, password: 'first-new-password' });
    assert.equal(first.status, 200);

    // Replaying the same link — still inside its hour — must fail.
    const second = await api.post('/api/auth/reset-password', { token: link, password: 'attacker-password' });
    assert.equal(second.status, 400);
    assert.equal(second.body.error.code, 'INVALID_TOKEN');

    // And the password really is the first one.
    assert.equal((await login(api, 'reset@example.test', 'first-new-password')).status, 200);
    assert.equal((await login(api, 'reset@example.test', 'attacker-password')).status, 401);
  });

  await t.test('a reset also proves the address, so it is marked verified', async () => {
    await srv.reset();
    const api = srv.client();
    const id = await signUp(api, 'unverified-reset@example.test');
    const before = await User.findById(id);
    assert.equal(Boolean(before.email_verified), false);

    await api.post('/api/auth/reset-password',
      { token: signResetToken(before), password: 'chosen-by-the-owner' });

    const after = await User.findById(id);
    assert.equal(Boolean(after.email_verified), true,
      'receiving the link proves the inbox, which is what verification asks');
  });

  await t.test('an unverified account gets no licence key', async () => {
    await srv.reset();
    const api = srv.client();
    const id = await signUp(api, 'nokey@example.test');
    const token = (await login(api, 'nokey@example.test')).body.data.token;

    const denied = await api.get('/api/user/license', { token });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'EMAIL_NOT_VERIFIED');

    await srv.query('UPDATE users SET email_verified = 1 WHERE id = ?', [id]);
    const allowed = await api.get('/api/user/license', { token });
    assert.equal(allowed.status, 200);
    assert.match(allowed.body.data.licenseKey, /^NDM(-[A-Z0-9]{4}){3}$/);
  });

  await t.test('with verification required, no token and no refresh get through', async () => {
    await srv.reset();
    const api = srv.client();
    await signUp(api, 'gated@example.test');
    // A token minted while the requirement was off.
    const token = (await login(api, 'gated@example.test')).body.data.token;
    assert.equal((await api.get('/api/user/me', { token })).status, 200);

    config.EMAIL_VERIFICATION_REQUIRED = true;
    try {
      const blocked = await api.get('/api/user/me', { token });
      assert.equal(blocked.status, 403);
      assert.equal(blocked.body.error.code, 'EMAIL_NOT_VERIFIED');

      const relogin = await login(api, 'gated@example.test');
      assert.equal(relogin.status, 403);
      assert.equal(relogin.body.error.code, 'EMAIL_NOT_VERIFIED');

      // The 30-day refresh cookie must not mint a fresh one either.
      const refreshed = await api.post('/api/auth/refresh', {});
      assert.equal(refreshed.status, 403);
      assert.equal(refreshed.body.error.code, 'EMAIL_NOT_VERIFIED');
    } finally {
      config.EMAIL_VERIFICATION_REQUIRED = false;
    }
  });

  await t.test('resend-verification never reveals whether an address exists', async () => {
    await srv.reset();
    const api = srv.client();
    await signUp(api, 'real@example.test');

    const known = await api.post('/api/auth/resend-verification', { email: 'real@example.test' });
    const unknown = await api.post('/api/auth/resend-verification', { email: 'nobody@example.test' });
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.deepEqual(known.body, unknown.body);
  });

  await t.test('a banned account cannot log in or refresh', async () => {
    await srv.reset();
    const api = srv.client();
    const id = await signUp(api, 'banned@example.test');
    await srv.query('UPDATE users SET email_verified = 1 WHERE id = ?', [id]);
    await login(api, 'banned@example.test');       // establishes the refresh cookie
    await srv.query('UPDATE users SET banned = 1 WHERE id = ?', [id]);

    const relogin = await login(api, 'banned@example.test');
    assert.equal(relogin.status, 403);
    assert.equal(relogin.body.error.code, 'FORBIDDEN');

    const refreshed = await api.post('/api/auth/refresh', {});
    assert.equal(refreshed.status, 403);
  });

  await srv.stop();
});
