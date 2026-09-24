'use strict';

/**
 * What the site tells a customer about their account has to be true.
 *
 *  1. "Any other devices have been signed out" — a password change or reset,
 *     an admin's "revoke sessions" and a ban end the desktop app's sign-in
 *     (its device token) too, not only the browser sessions.
 *  2. "Machines signed in with an account are not affected" — replacing the
 *     licence key cuts loose the machines that used the KEY, and leaves the
 *     machines signed in with an account entitled to the plan running.
 *  3. The public "registered users" figure counts customers: verified, not
 *     banned, not staff.
 *  4. The account export is "everything we hold" — sessions, security events,
 *     contact messages, Google link, two-factor state, desktop sign-ins, team
 *     rows — and still carries no secret material.
 *
 * Each case failed against d52d86d.
 */
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
// The public figure is hidden below a floor (utils/stats.js); this suite is
// about WHICH rows are counted, so show whatever the count is.
process.env.STATS_MIN_USERS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const srv = require('./helpers/testServer');
const { signResetToken } = require('../src/utils/jwt');
const User = require('../src/models/User');

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

/** code → approval on the site by `user` → device token, for one machine. */
async function signIn(app, site, user, fingerprint, deviceName = 'Test PC') {
  const code = await app.post('/api/device/code', { device_fingerprint: fingerprint, device_name: deviceName, app_version: '0.3.0' });
  assert.equal(code.status, 200, code.text);
  const approved = await site.post('/api/device/approve', { user_code: code.body.data.userCode }, { token: user.token });
  assert.equal(approved.status, 200, approved.text);
  const poll = await app.post('/api/device/token', { device_code: code.body.data.deviceCode, device_fingerprint: fingerprint });
  assert.equal(poll.body.data.status, 'approved', poll.text);
  return { token: poll.body.data.deviceToken, deviceCode: code.body.data.deviceCode, userCode: code.body.data.userCode };
}

async function userId(email) {
  const [row] = await srv.query('SELECT id FROM users WHERE email = ?', [email]);
  return row.id;
}

async function adminSession(api, email = `staff${Date.now()}@example.test`) {
  const password = 'admin-password-123';
  await srv.query(
    "INSERT INTO users (name, email, password_hash, role, email_verified) VALUES ('Staff', ?, ?, 'admin', 1)",
    [email, await bcrypt.hash(password, 12)]
  );
  const login = await api.post('/api/admin/login', { email, password });
  assert.equal(login.status, 200, login.text);
  return { token: login.body.data.token };
}

test('account truth', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();

  // ---------------------------------------------------------------- item 1
  await t.test('ending every session signs the desktop app out too', async (t2) => {
    await srv.reset();
    const app = srv.client();

    // One signed-in machine per path, each checked valid first so the later
    // `signed_out` can only come from the path under test.
    async function signedInMachine(label, fingerprint) {
      const site = srv.client();
      const user = await srv.makeUser(site, label);
      const { token } = await signIn(app, site, user, fingerprint, `${label} PC`);
      const before = await app.post('/api/license/validate', { device_token: token, device_fingerprint: fingerprint });
      assert.equal(before.body.valid, true, before.text);
      return { site, user, token, fingerprint, id: await userId(user.email) };
    }
    const stillSignedIn = async (m) =>
      (await app.post('/api/license/heartbeat', { device_token: m.token, device_fingerprint: m.fingerprint })).body;

    await t2.test('a password change on the profile page', async () => {
      const m = await signedInMachine('pwchange', '1'.repeat(32));
      const res = await m.site.put('/api/user/profile',
        { currentPassword: m.user.password, newPassword: 'another-strong-password-9' }, { token: m.user.token });
      assert.equal(res.status, 200, res.text);
      // The browser that changed it keeps working on the fresh token…
      assert.equal((await m.site.get('/api/user/me', { token: res.body.data.token })).status, 200);
      // …and the app does not: this is what "any other devices have been
      // signed out" promises.
      const beat = await stillSignedIn(m);
      assert.equal(beat.valid, false);
      assert.equal(beat.reason, 'signed_out');
      const [row] = await srv.query('SELECT revoked_at, revoked_reason FROM device_tokens WHERE user_id = ?', [m.id]);
      assert.ok(row.revoked_at, 'the token row is revoked, not merely refused');
    });

    await t2.test('a password reset from the emailed link', async () => {
      const m = await signedInMachine('pwreset', '2'.repeat(32));
      const link = signResetToken(await User.findById(m.id));
      const res = await srv.client().post('/api/auth/reset-password', { token: link, password: 'reset-strong-password-7' });
      assert.equal(res.status, 200, res.text);
      assert.equal((await stillSignedIn(m)).reason, 'signed_out');
    });

    await t2.test("an admin's revoke-sessions", async () => {
      const m = await signedInMachine('revoke', '3'.repeat(32));
      const staff = srv.client();
      const auth = await adminSession(staff, 'revoker@example.test');
      const res = await staff.post(`/api/admin/users/${m.id}/revoke-sessions`, {}, auth);
      assert.equal(res.status, 200, res.text);
      assert.equal((await stillSignedIn(m)).reason, 'signed_out');
    });

    await t2.test('a ban, and the app stays signed out after the ban is lifted', async () => {
      const m = await signedInMachine('banned', '4'.repeat(32));
      const staff = srv.client();
      const auth = await adminSession(staff, 'banner@example.test');
      assert.equal((await staff.put(`/api/admin/users/${m.id}`, { banned: true }, auth)).status, 200);
      assert.equal((await staff.put(`/api/admin/users/${m.id}`, { banned: false }, auth)).status, 200);
      // Before, the ban was only ever enforced at use: a token nobody
      // presented during the ban came back to life with the unban.
      assert.equal((await stillSignedIn(m)).reason, 'signed_out');
    });

    await t2.test('User.revokeSessions ends the browser sessions and the app together', async () => {
      const m = await signedInMachine('browser', '5'.repeat(32));
      await User.revokeSessions(m.id);
      const me = await m.site.get('/api/user/me', { token: m.user.token });
      assert.equal(me.status, 401);
      assert.equal((await stillSignedIn(m)).reason, 'signed_out');
    });
  });

  // ---------------------------------------------------------------- item 2
  await t.test('replacing the key spares machines signed in with an account', async () => {
    await srv.reset();
    const app = srv.client();
    const site = srv.client();
    const owner = await srv.makeUser(site, 'owner');
    const ownerId = await userId(owner.email);
    await srv.query(
      `UPDATE subscriptions SET plan = 'team', seats = 5, expiry_date = DATE_ADD(NOW(), INTERVAL 30 DAY)
        WHERE user_id = ?`, [ownerId]);
    const [sub] = await srv.query('SELECT id, license_key FROM subscriptions WHERE user_id = ?', [ownerId]);
    const oldKey = sub.license_key;

    // Two teammates on the roster, signed in with their own accounts.
    const onRoster = async (label) => {
      const s = srv.client();
      const u = await srv.makeUser(s, label);
      const id = await userId(u.email);
      await srv.query(
        `INSERT INTO team_members (subscription_id, email, user_id, status, accepted_at)
         VALUES (?, ?, ?, 'active', NOW())`, [sub.id, u.email, id]);
      return { site: s, user: u, id };
    };
    const stays = await onRoster('stays');
    const leaves = await onRoster('leaves');

    const FP_KEY = 'a1'.repeat(16);      // a machine running on the pasted key
    const FP_OWNER = 'b2'.repeat(16);    // the owner's machine, signed in
    const FP_MEMBER = 'c3'.repeat(16);   // a current member's machine, signed in
    const FP_GONE = 'd4'.repeat(16);     // a member about to be removed, signed in

    assert.equal((await app.post('/api/license/validate', { license_key: oldKey, device_fingerprint: FP_KEY })).body.valid, true);
    const ownerMachine = (await signIn(app, site, owner, FP_OWNER, 'Owner PC')).token;
    const memberMachine = (await signIn(app, stays.site, stays.user, FP_MEMBER, 'Member PC')).token;
    const goneMachine = (await signIn(app, leaves.site, leaves.user, FP_GONE, 'Former PC')).token;
    for (const [token, fp] of [[ownerMachine, FP_OWNER], [memberMachine, FP_MEMBER], [goneMachine, FP_GONE]]) {
      const res = await app.post('/api/license/validate', { device_token: token, device_fingerprint: fp });
      assert.equal(res.body.valid, true, res.text);
      assert.equal(res.body.plan, 'team');
    }

    // The owner removes one member, then replaces the key — the documented
    // way to take a team seat back.
    const [goneRow] = await srv.query('SELECT id FROM team_members WHERE user_id = ?', [leaves.id]);
    assert.equal((await site.del(`/api/team/members/${goneRow.id}`, { token: owner.token })).status, 200);
    const rotated = await site.post('/api/user/license/rotate', {}, { token: owner.token });
    assert.equal(rotated.status, 200, rotated.text);
    const newKey = rotated.body.data.licenseKey;
    assert.notEqual(newKey, oldKey);
    // The key machine and the removed member's machine — nobody else.
    assert.equal(rotated.body.data.devicesRevoked, 2);

    // The account machines beat on, still on the team plan: nothing they hold
    // was replaced. Before, both were answered seat_revoked and fell to Free.
    for (const [token, fp] of [[ownerMachine, FP_OWNER], [memberMachine, FP_MEMBER]]) {
      const beat = await app.post('/api/license/heartbeat', { device_token: token, device_fingerprint: fp });
      assert.equal(beat.body.valid, true, beat.text);
      assert.equal(beat.body.plan, 'team');
    }

    // The machine on the old key is cut loose exactly as before…
    assert.equal((await app.post('/api/license/heartbeat', { license_key: oldKey, device_fingerprint: FP_KEY })).body.reason, 'not_found');
    const keyBeat = await app.post('/api/license/heartbeat', { license_key: newKey, device_fingerprint: FP_KEY });
    assert.equal(keyBeat.body.reason, 'seat_revoked', 'its seat went with the key');
    // …and so is the removed member's seat on the team plan.
    const rows = await srv.query(
      'SELECT device_fingerprint, revoked_at, lease_expires_at FROM license_activations WHERE subscription_id = ?', [sub.id]);
    const byFp = Object.fromEntries(rows.map((r) => [r.device_fingerprint, r]));
    assert.ok(byFp[FP_KEY].revoked_at && !byFp[FP_KEY].lease_expires_at);
    assert.ok(byFp[FP_GONE].revoked_at && !byFp[FP_GONE].lease_expires_at);
    assert.equal(byFp[FP_OWNER].revoked_at, null);
    assert.equal(byFp[FP_MEMBER].revoked_at, null);
    // The removed member's account still works — on their own Free plan.
    const goneNow = await app.post('/api/license/validate', { device_token: goneMachine, device_fingerprint: FP_GONE });
    assert.equal(goneNow.body.valid, true, goneNow.text);
    assert.equal(goneNow.body.plan, 'free');
  });

  // ---------------------------------------------------------------- item 3
  await t.test('the public user count is customers who can sign in', async () => {
    await srv.reset();
    const api = srv.client();
    await srv.makeUser(api, 'counted');                                  // counted
    const unverified = `unverified${Date.now()}@example.test`;
    await api.post('/api/auth/register', { name: 'Never Verified', email: unverified, password: 'a-strong-password' });
    const banned = await srv.makeUser(api, 'banned');
    await srv.query('UPDATE users SET banned = 1 WHERE email = ?', [banned.email]);
    const hash = await bcrypt.hash('admin-password-123', 12);
    await srv.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified) VALUES
        ('Staff', 'staff-count@example.test', ?, 'admin', 1),
        ('Creator', 'root-count@example.test', ?, 'root', 1)`, [hash, hash]);
    assert.equal(Number((await srv.query('SELECT COUNT(*) AS n FROM users'))[0].n), 5);

    const res = await api.get('/api/stats');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.users, 1, 'staff, banned and unverified rows are not "registered users"');
  });

  // ---------------------------------------------------------------- item 4
  await t.test('the export holds everything about the account and no secret', async () => {
    await srv.reset();
    const app = srv.client();
    const site = srv.client();
    const u = await srv.makeUser(site, 'export');
    const id = await userId(u.email);
    const FP = 'e5'.repeat(16);
    const machine = await signIn(app, site, u, FP, 'Export PC');

    // Credentials and identifiers that must never leave, planted so their
    // absence is checked rather than assumed.
    const TOTP_SECRET = 'JBSWY3DPEHPK3PXPSENTINELSECRET';
    const RECOVERY = JSON.stringify([sha256('recovery-code-sentinel')]);
    const GOOGLE_SUB = 'google-subject-sentinel-1234567890';
    const AVATAR = 'https://lh3.googleusercontent.com/a/export-avatar';
    await srv.query(
      `UPDATE users SET totp_enabled = 1, totp_secret = ?, totp_recovery = ?, google_id = ?, avatar_url = ?
        WHERE id = ?`, [TOTP_SECRET, RECOVERY, GOOGLE_SUB, AVATAR, id]);

    // A team this person owns, with an invite out; and an invite TO them.
    const [ownSub] = await srv.query('SELECT id FROM subscriptions WHERE user_id = ?', [id]);
    const SENT_INVITE_HASH = sha256('sent-invite-token');
    await srv.query(
      `INSERT INTO team_members (subscription_id, email, token_hash, status)
       VALUES (?, 'friend@example.test', ?, 'invited')`, [ownSub.id, SENT_INVITE_HASH]);
    const other = await srv.makeUser(srv.client(), 'otherowner');
    const otherId = await userId(other.email);
    await srv.query("UPDATE users SET name = 'Other Owner' WHERE id = ?", [otherId]);
    const [otherSub] = await srv.query('SELECT id FROM subscriptions WHERE user_id = ?', [otherId]);
    const RECEIVED_INVITE_HASH = sha256('received-invite-token');
    await srv.query(
      `INSERT INTO team_members (subscription_id, email, token_hash, status)
       VALUES (?, ?, ?, 'invited')`, [otherSub.id, u.email, RECEIVED_INVITE_HASH]);

    // Contact messages: signed in, signed out from the same address, and
    // somebody else's — only the first two are theirs.
    await srv.query(
      `INSERT INTO contact_messages (user_id, name, email, topic, message, ip, user_agent)
       VALUES (?, 'Export', ?, 'billing', 'signed-in message', '203.0.113.9', 'Browser/1')`, [id, u.email]);
    const [mine] = await srv.query("SELECT id FROM contact_messages WHERE message = 'signed-in message'");
    await srv.query(
      "INSERT INTO contact_replies (message_id, admin_user_id, admin_name, body) VALUES (?, NULL, 'Support', 'reply to you')",
      [mine.id]);
    await srv.query(
      `INSERT INTO contact_messages (user_id, name, email, topic, message)
       VALUES (NULL, 'Export', ?, 'general', 'signed-out message')`, [u.email]);
    await srv.query(
      `INSERT INTO contact_messages (user_id, name, email, topic, message)
       VALUES (NULL, 'Stranger', 'stranger@example.test', 'general', 'not yours')`);

    // Security events: theirs by account, theirs by address, and a stranger's.
    await srv.query(
      `INSERT INTO security_events (kind, severity, user_id, email, ip, detail)
       VALUES ('login.failed', 'warning', NULL, ?, '198.51.100.7', 'wrong password')`, [u.email]);
    await srv.query(
      `INSERT INTO security_events (kind, severity, user_id, email, ip, detail)
       VALUES ('login.failed', 'warning', NULL, 'stranger@example.test', '198.51.100.8', 'stranger event')`);

    const res = await site.get('/api/user/export', { token: u.token });
    assert.equal(res.status, 200, res.text);
    const doc = JSON.parse(res.text);

    // Everything that was already there is still there, under the same keys.
    for (const key of ['exportedAt', 'account', 'subscriptions', 'payments', 'review', 'team'])
      assert.ok(key in doc, `${key} is kept`);
    assert.equal(doc.account.email, u.email);

    // Google link and avatar, as presence and a URL; 2FA as on/off.
    assert.equal(doc.account.googleLinked, true);
    assert.equal(doc.account.avatarUrl, AVATAR);
    assert.equal(doc.account.hasPassword, true);
    assert.deepEqual(doc.twoFactor, { enabled: true });

    // Browser sessions with where and when.
    assert.ok(doc.sessions.length >= 1);
    assert.ok(doc.sessions[0].ip);
    assert.ok(doc.sessions[0].userAgent);
    assert.ok(doc.sessions[0].createdAt && doc.sessions[0].expiresAt);

    // The desktop sign-in, and the request that approved it.
    assert.equal(doc.deviceSignIns.length, 1);
    assert.equal(doc.deviceSignIns[0].name, 'Export PC');
    assert.equal(doc.deviceSignIns[0].fingerprintPrefix, FP.slice(0, 8));
    assert.ok(doc.deviceSignIns[0].createdAt);
    assert.equal(doc.deviceSignInRequests.length, 1);
    assert.equal(doc.deviceSignInRequests[0].status, 'consumed');

    // Team rows both ways.
    assert.deepEqual(doc.teamInvitesSent.map((m) => [m.email, m.status]), [['friend@example.test', 'invited']]);
    assert.deepEqual(doc.teamMemberships.map((m) => [m.ownerName, m.status]), [['Other Owner', 'invited']]);

    // Contact messages they sent (both ways), with the reply; not a stranger's.
    const messages = doc.contactMessages.map((m) => m.message).sort();
    assert.deepEqual(messages, ['signed-in message', 'signed-out message']);
    const withReply = doc.contactMessages.find((m) => m.message === 'signed-in message');
    assert.deepEqual(withReply.replies.map((r) => r.body), ['reply to you']);
    assert.equal(withReply.ip, '203.0.113.9');

    // Security events about the account: its sign-in, the failure against its
    // address; not a stranger's.
    const kinds = doc.securityEvents.map((e) => e.kind);
    assert.ok(kinds.includes('login.success'), kinds.join());
    assert.ok(doc.securityEvents.some((e) => e.detail === 'wrong password'));
    assert.ok(!doc.securityEvents.some((e) => e.detail === 'stranger event'));

    // And not one secret, hash or credential.
    const [sessionRow] = await srv.query('SELECT token_hash, family FROM user_sessions WHERE user_id = ? LIMIT 1', [id]);
    const [tokenRow] = await srv.query('SELECT token_hash FROM device_tokens WHERE user_id = ?', [id]);
    const [codeRow] = await srv.query('SELECT device_code_hash, user_code FROM device_codes WHERE user_id = ?', [id]);
    const [userRow] = await srv.query('SELECT password_hash FROM users WHERE id = ?', [id]);
    const forbidden = {
      'totp secret': TOTP_SECRET,
      'recovery codes': sha256('recovery-code-sentinel'),
      'google subject id': GOOGLE_SUB,
      'password hash': userRow.password_hash,
      'refresh cookie': site.cookies.get('ndm_refresh'),
      'session token hash': sessionRow.token_hash,
      'session family': sessionRow.family,
      'device token': machine.token,
      'device token hash': tokenRow.token_hash,
      'device code': machine.deviceCode,
      'device code hash': codeRow.device_code_hash,
      'user code': codeRow.user_code,
      'full fingerprint': FP,
      'sent invite hash': SENT_INVITE_HASH,
      'received invite hash': RECEIVED_INVITE_HASH,
    };
    for (const [what, value] of Object.entries(forbidden)) {
      assert.ok(value, `${what} was planted`);
      assert.ok(!res.text.includes(value), `${what} must not be in the export`);
    }
    assert.doesNotMatch(res.text, /password_hash|refresh_token|totp|token_hash|google_id/);
  });

  await t.test('rows filed under an address stay out of an unverified account’s export', async () => {
    await srv.reset();
    const api = srv.client();
    const email = `squatter${Date.now()}@example.test`;
    await api.post('/api/auth/register', { name: 'Unverified', email, password: 'a-strong-password' });
    const login = await api.post('/api/auth/login', { email, password: 'a-strong-password' });
    assert.equal(login.status, 200, login.text);
    await srv.query(
      `INSERT INTO contact_messages (user_id, name, email, topic, message)
       VALUES (NULL, 'Real Owner', ?, 'general', 'written by the real owner')`, [email]);
    await srv.query(
      `INSERT INTO security_events (kind, severity, user_id, email, detail)
       VALUES ('login.failed', 'warning', NULL, ?, 'the real owner mistyped')`, [email]);
    const res = await api.get('/api/user/export', { token: login.body.data.token });
    assert.equal(res.status, 200, res.text);
    const doc = JSON.parse(res.text);
    assert.deepEqual(doc.contactMessages, []);
    assert.ok(!doc.securityEvents.some((e) => e.detail === 'the real owner mistyped'));
  });

  await srv.stop();
});
