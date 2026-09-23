'use strict';

/**
 * AUDIT.md H-08, the control-panel half — revoking a panel session has to
 * revoke it.
 *
 * `User.revokeSessions` bumps `users.token_version` and every panel bearer
 * carries that number as `tv` (utils/jwt.js), but only middleware/auth.js —
 * the customer gate — ever compared the two. So revoking a staff admin's
 * sessions, or demoting them (routes/root.js calls the same method), cleared
 * the refresh cookie and left the bearer in their tab working for the rest of
 * its life: eight hours for staff, four for the creator. It looked like it had
 * worked, because the cookie was gone.
 *
 * These drive the real endpoints, because the claim is about the gate every
 * panel route sits behind, not about a helper.
 */

process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const srv = require('./helpers/testServer');

const PASSWORD = 'panel-session-password';

async function seed(role, email) {
  await srv.query(
    `INSERT INTO users (name, email, password_hash, role, email_verified)
     VALUES (?, ?, ?, ?, 1)`,
    [role === 'root' ? 'Creator' : 'Staff', email, await bcrypt.hash(PASSWORD, 4), role]
  );
  const [row] = await srv.query('SELECT id FROM users WHERE email = ?', [email]);
  return row.id;
}

async function signIn(client, path, email) {
  const res = await client.post(path, { email, password: PASSWORD });
  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.data.token, 'expected a bearer');
  return res.body.data.token;
}

test('panel sessions end when they are revoked', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();

  await t.test('a staff admin’s bearer dies with their sessions', async () => {
    await srv.reset();
    const api = srv.client();
    const id = await seed('admin', 'staff-session@example.test');
    const token = await signIn(api, '/api/admin/login', 'staff-session@example.test');

    // It works, which is the part that has to change.
    assert.equal((await api.get('/api/admin/me', { token })).status, 200);

    // What the creator's console does, and what a password reset does.
    const User = require('../src/models/User');
    await User.revokeSessions(id);

    const after = await api.get('/api/admin/me', { token });
    assert.equal(after.status, 401, after.text);
    assert.equal(after.body.error.code, 'SESSION_REVOKED');
    // Every other panel route sits behind the same gate.
    assert.equal((await api.get('/api/admin/users', { token })).status, 401);

    // Signing in again works and the new bearer is on the new generation.
    const fresh = await signIn(srv.client(), '/api/admin/login', 'staff-session@example.test');
    assert.notEqual(fresh, token);
    assert.equal((await api.get('/api/admin/me', { token: fresh })).status, 200);
  });

  await t.test('the creator’s root bearer dies the same way', async () => {
    await srv.reset();
    const api = srv.client();
    // ROOT_ADMIN_EMAIL is what testServer.js sets; isRootUser matches on it.
    const email = process.env.ROOT_ADMIN_EMAIL;
    assert.ok(email, 'the suite needs ROOT_ADMIN_EMAIL');
    const id = await seed('root', email);
    const token = await signIn(api, '/api/root/login', email);
    assert.equal((await api.get('/api/root/me', { token })).status, 200);

    const User = require('../src/models/User');
    await User.revokeSessions(id);

    const after = await api.get('/api/root/me', { token });
    assert.equal(after.status, 401, after.text);
    assert.equal(after.body.error.code, 'SESSION_REVOKED');
  });

  await t.test('a demoted admin cannot keep using the panel with the token they hold', async () => {
    await srv.reset();
    const api = srv.client();
    const id = await seed('admin', 'demoted@example.test');
    const token = await signIn(api, '/api/admin/login', 'demoted@example.test');
    assert.equal((await api.get('/api/admin/me', { token })).status, 200);

    // The demotion the root panel performs: role first, then the revocation.
    const User = require('../src/models/User');
    await User.update(id, { role: 'user' });
    await User.revokeSessions(id);

    // Either answer is correct — the role check and the generation check both
    // apply — but it must not be 200.
    const after = await api.get('/api/admin/me', { token });
    assert.notEqual(after.status, 200, after.text);
    assert.ok([401, 403].includes(after.status), `unexpected ${after.status}`);
  });

  await srv.stop();
});
