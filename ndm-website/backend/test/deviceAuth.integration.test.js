'use strict';
/**
 * Desktop-app account sign-in (routes/device.js + the device-token path in
 * routes/license.js), end to end: code → approval on the site → token →
 * validate/heartbeat/release with the token, misuse, sign-out from both
 * ends, Free-plan seats, and a Team member whose machine must never learn
 * the owner's key.
 */
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.EMAIL_VERIFICATION_REQUIRED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const srv = require('./helpers/testServer');

const FP_A = 'a'.repeat(32);
const FP_B = 'b'.repeat(32);

const claimsOf = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

async function captureMail(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  try { await fn(); } finally { console.log = original; }
  return lines.join('\n');
}

/** The whole dance for one machine: code, approval by `user`, token. */
async function signIn(app, site, user, fingerprint, deviceName = 'Test PC') {
  const code = await app.post('/api/device/code', { device_fingerprint: fingerprint, device_name: deviceName, app_version: '0.3.0' });
  assert.equal(code.status, 200, code.text);
  const ok = await site.post('/api/device/approve', { user_code: code.body.data.userCode }, { token: user.token });
  assert.equal(ok.status, 200, ok.text);
  const poll = await app.post('/api/device/token', { device_code: code.body.data.deviceCode, device_fingerprint: fingerprint });
  assert.equal(poll.status, 200, poll.text);
  assert.equal(poll.body.data.status, 'approved');
  return poll.body.data.deviceToken;
}

test('desktop account sign-in', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();
  await srv.reset();

  const site = srv.client();
  const user = await srv.makeUser(site, 'device');
  const app = srv.client();   // the desktop app: no cookies, no bearer

  let deviceCode;
  let userCode;
  await t.test('the app asks for a code and gets both halves', async () => {
    const res = await app.post('/api/device/code', { device_fingerprint: FP_A, device_name: 'Office laptop', app_version: '0.3.0' });
    assert.equal(res.status, 200, res.text);
    const d = res.body.data;
    assert.match(d.deviceCode, /^[A-Za-z0-9_-]{43}$/);
    assert.match(d.userCode, /^[ACDEFGHJKMNPQRTUVWXYZ234679]{4}-[ACDEFGHJKMNPQRTUVWXYZ234679]{4}$/);
    assert.equal(d.verificationUrlComplete, `${d.verificationUrl}?code=${encodeURIComponent(d.userCode)}`);
    assert.ok(d.expiresIn >= 300 && d.interval >= 1);
    deviceCode = d.deviceCode;
    userCode = d.userCode;
  });

  await t.test('polling before anybody decides is pending, and impatience is told to slow down', async () => {
    const first = await app.post('/api/device/token', { device_code: deviceCode, device_fingerprint: FP_A });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.data.status, 'pending');
    assert.equal(first.body.data.deviceToken, undefined);
    const again = await app.post('/api/device/token', { device_code: deviceCode, device_fingerprint: FP_A });
    assert.equal(again.body.data.status, 'slow_down');
  });

  await t.test('the approval page needs a session, an unverified account may not approve', async () => {
    const anon = await srv.client().get(`/api/device/code/${userCode}`);
    assert.equal(anon.status, 401);
    const lookup = await site.get(`/api/device/code/${userCode.toLowerCase().replace('-', '')}`, { token: user.token });
    assert.equal(lookup.status, 200, lookup.text);
    assert.equal(lookup.body.data.deviceName, 'Office laptop');
    assert.equal(lookup.body.data.appVersion, '0.3.0');

    await srv.query('UPDATE users SET email_verified = 0 WHERE email = ?', [user.email]);
    const refused = await site.post('/api/device/approve', { user_code: userCode }, { token: user.token });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'EMAIL_NOT_VERIFIED');
    await srv.query('UPDATE users SET email_verified = 1 WHERE email = ?', [user.email]);
  });

  let deviceToken;
  await t.test('approving hands the app a device token exactly once, and mails the owner', async () => {
    const mail = await captureMail(async () => {
      const ok = await site.post('/api/device/approve', { user_code: userCode }, { token: user.token });
      assert.equal(ok.status, 200, ok.text);
      assert.equal(ok.body.data.approved, true);
    });
    assert.match(mail, /new device signed in/i);
    assert.match(mail, /Office laptop/);
    // Not pending any more: the page cannot approve it twice.
    assert.equal((await site.get(`/api/device/code/${userCode}`, { token: user.token })).status, 404);

    const poll = await app.post('/api/device/token', { device_code: deviceCode, device_fingerprint: FP_A });
    assert.equal(poll.status, 200, poll.text);
    assert.equal(poll.body.data.status, 'approved');
    assert.match(poll.body.data.deviceToken, /^ndt_[A-Za-z0-9_-]{43}$/);
    assert.equal(poll.body.data.account.email, user.email);
    deviceToken = poll.body.data.deviceToken;
    // The code is spent.
    const spent = await app.post('/api/device/token', { device_code: deviceCode, device_fingerprint: FP_A });
    assert.equal(spent.body.data.status, 'expired');
    // …and a copied device code polled from another machine is spent too.
    const other = await app.post('/api/device/code', { device_fingerprint: FP_A });
    const elsewhere = await app.post('/api/device/token', { device_code: other.body.data.deviceCode, device_fingerprint: FP_B });
    assert.equal(elsewhere.body.data.status, 'expired');
  });

  await t.test('the token validates like a key, with the account in the signature and no key on the wire', async () => {
    const res = await app.post('/api/license/validate', { device_token: deviceToken, device_fingerprint: FP_A, device_name: 'Office laptop', app_version: '0.3.0' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.valid, true);
    assert.equal(res.body.plan, 'free');
    assert.equal(res.body.account.email, user.email);
    assert.ok(!('licenseKey' in res.body));
    const claims = claimsOf(res.body.token);
    const [row] = await srv.query('SELECT id FROM users WHERE email = ?', [user.email]);
    assert.equal(claims.sub, `user:${row.id}`);
    assert.equal(claims.acct, row.id);
    assert.equal(claims.plan, 'free');
    assert.equal(claims.device, FP_A);
    assert.doesNotMatch(JSON.stringify(res.body), /NDM-/, 'no licence key anywhere in the answer');

    const beat = await app.post('/api/license/heartbeat', { device_token: deviceToken, device_fingerprint: FP_A });
    assert.equal(beat.body.valid, true);
    assert.equal(claimsOf(beat.body.token).acct, row.id);
  });

  await t.test('the dashboard lists the machine as signed in', async () => {
    const res = await site.get('/api/user/devices', { token: user.token });
    assert.equal(res.status, 200, res.text);
    const [d] = res.body.data.devices;
    assert.equal(d.signedIn, true);
    assert.ok(d.tokenId);
    assert.equal(d.name, 'Office laptop');
    assert.equal(d.appVersion, '0.3.0');
    assert.equal(d.active, true, 'holding a seat');
    assert.equal(res.body.data.seatsEnforced, false, 'the Free plan does not ration seats');
  });

  await t.test('either credential, never both, never neither', async () => {
    const both = await app.post('/api/license/validate', { device_token: deviceToken, license_key: 'NDM-AAAA-BBBB-CCCC', device_fingerprint: FP_A });
    assert.equal(both.status, 400);
    const neither = await app.post('/api/license/validate', { device_fingerprint: FP_A });
    assert.equal(neither.status, 400);
  });

  await t.test('the Free plan never answers seat_limit: a second machine signs in beside the first', async () => {
    const second = await signIn(app, site, user, FP_B, 'Home desktop');
    const res = await app.post('/api/license/validate', { device_token: second, device_fingerprint: FP_B });
    assert.equal(res.body.valid, true, JSON.stringify(res.body));
    assert.equal((await site.get('/api/user/devices', { token: user.token })).body.data.devices.length, 2);
    // Upgrade the account: a one-seat Pro plan now rations, and the second
    // machine loses — while the first, which holds its lease, keeps beating.
    await srv.query("UPDATE subscriptions SET plan = 'pro', seats = 1, expiry_date = DATE_ADD(NOW(), INTERVAL 30 DAY) WHERE user_id = (SELECT id FROM users WHERE email = ?)", [user.email]);
    await srv.query('UPDATE license_activations SET lease_expires_at = NULL WHERE device_fingerprint = ?', [FP_B]);
    const first = await app.post('/api/license/heartbeat', { device_token: deviceToken, device_fingerprint: FP_A });
    assert.equal(first.body.valid, true, JSON.stringify(first.body));
    assert.equal(first.body.plan, 'pro', 'the upgrade reached the signed-in machine on its next beat');
    assert.equal(claimsOf(first.body.token).plan, 'pro');
    const blocked = await app.post('/api/license/validate', { device_token: second, device_fingerprint: FP_B });
    assert.equal(blocked.body.valid, false);
    assert.equal(blocked.body.reason, 'seat_limit');
    assert.equal(blocked.body.account.email, user.email, 'still signed in — just no seat');
    assert.equal((await site.get('/api/user/devices', { token: user.token })).body.data.seatsEnforced, true);
  });

  await t.test('a token presented by another machine is refused there AND revoked', async () => {
    const stolen = await app.post('/api/license/validate', { device_token: deviceToken, device_fingerprint: FP_B });
    assert.equal(stolen.body.valid, false);
    assert.equal(stolen.body.reason, 'signed_out');
    const legit = await app.post('/api/license/validate', { device_token: deviceToken, device_fingerprint: FP_A });
    assert.equal(legit.body.reason, 'signed_out', 'the copy killed the original too');
    const events = await srv.query("SELECT kind, severity FROM security_events WHERE kind = 'device.token_misuse'");
    assert.equal(events.length, 1);
    assert.equal(events[0].severity, 'critical');
    deviceToken = await signIn(app, site, user, FP_A, 'Office laptop');
    assert.equal((await app.post('/api/license/validate', { device_token: deviceToken, device_fingerprint: FP_A })).body.valid, true);
  });

  await t.test('signing a machine out from the dashboard ends its session at the next check', async () => {
    const list = await site.get('/api/user/devices', { token: user.token });
    const laptop = list.body.data.devices.find((d) => d.shortId === FP_A.slice(0, 8));
    assert.ok(laptop.signedIn && laptop.tokenId);
    const out = await site.del(`/api/user/devices/tokens/${laptop.tokenId}`, { token: user.token });
    assert.equal(out.status, 200, out.text);
    const res = await app.post('/api/license/heartbeat', { device_token: deviceToken, device_fingerprint: FP_A });
    assert.equal(res.body.valid, false);
    assert.equal(res.body.reason, 'signed_out');
    // Somebody else's token id is not this user's to revoke.
    const stranger = await srv.makeUser(srv.client(), 'stranger');
    assert.equal((await site.del(`/api/user/devices/tokens/${laptop.tokenId}`, { token: stranger.token })).status, 404);
  });

  await t.test('the app signing itself out frees the seat and forgets the token', async () => {
    deviceToken = await signIn(app, site, user, FP_A, 'Office laptop');
    assert.equal((await app.post('/api/license/validate', { device_token: deviceToken, device_fingerprint: FP_A })).body.valid, true);
    const out = await app.post('/api/device/signout', { device_token: deviceToken, device_fingerprint: FP_A });
    assert.equal(out.status, 200, out.text);
    assert.deepEqual(out.body.data, { signedOut: true, wasSignedIn: true });
    const [seat] = await srv.query('SELECT lease_expires_at FROM license_activations WHERE device_fingerprint = ?', [FP_A]);
    assert.equal(seat.lease_expires_at, null, 'seat handed back');
    assert.equal((await app.post('/api/license/validate', { device_token: deviceToken, device_fingerprint: FP_A })).body.reason, 'signed_out');
    const again = await app.post('/api/device/signout', { device_token: deviceToken, device_fingerprint: FP_A });
    assert.deepEqual(again.body.data, { signedOut: true, wasSignedIn: false });
  });

  await t.test('denying a code sends the app away', async () => {
    const code = await app.post('/api/device/code', { device_fingerprint: FP_A, device_name: 'Unknown PC' });
    const deny = await site.post('/api/device/deny', { user_code: code.body.data.userCode }, { token: user.token });
    assert.equal(deny.status, 200, deny.text);
    const poll = await app.post('/api/device/token', { device_code: code.body.data.deviceCode, device_fingerprint: FP_A });
    assert.equal(poll.body.data.status, 'denied');
    assert.equal((await srv.query("SELECT COUNT(*) AS n FROM security_events WHERE kind = 'device.denied'"))[0].n, 1);
  });

  await t.test('a Team member signs in with their own account and gets the team plan without the owner\'s key', async () => {
    const owner = srv.client();
    const o = await srv.makeUser(owner, 'teamowner');
    const buy = await owner.post('/api/subscription/mock-complete', { plan: 'team', billingCycle: 'monthly' }, { token: o.token });
    assert.equal(buy.status, 200, buy.text);
    const member = srv.client();
    const m = await srv.makeUser(member, 'teammember');
    let inviteToken;
    await captureMail(async () => {
      const res = await owner.post('/api/team/invites', { email: m.email }, { token: o.token });
      assert.equal(res.status, 201, res.text);
    });
    const [invite] = await srv.query('SELECT token_hash FROM team_members WHERE email = ?', [m.email]);
    assert.ok(invite.token_hash);
    // The join token is only in the mail; the model stores its hash. Accept
    // through the model's own path instead of scraping the mail here.
    const TeamMember = require('../src/models/TeamMember');
    const [memberRow] = await srv.query('SELECT id FROM team_members WHERE email = ?', [m.email]);
    const [memberUser] = await srv.query('SELECT id FROM users WHERE email = ?', [m.email]);
    assert.equal(await TeamMember.accept(memberRow.id, memberUser.id), true);
    inviteToken = null;
    void inviteToken;

    const memberApp = srv.client();
    const token = await signIn(memberApp, member, m, 'c'.repeat(32), 'Member laptop');
    const res = await memberApp.post('/api/license/validate', { device_token: token, device_fingerprint: 'c'.repeat(32) });
    assert.equal(res.body.valid, true, JSON.stringify(res.body));
    assert.equal(res.body.plan, 'team');
    assert.equal(res.body.account.email, m.email);
    const claims = claimsOf(res.body.token);
    assert.equal(claims.sub, `user:${memberUser.id}`);
    assert.equal(claims.plan, 'team');
    const ownerKey = (await owner.get('/api/user/license', { token: o.token })).body.data.licenseKey;
    assert.ok(!JSON.stringify(res.body).includes(ownerKey), 'the owner\'s key never reaches the member\'s machine');
    // The member's machine holds a seat on the OWNER's plan, and shows on
    // the member's own device list as signed in.
    const ownerDevices = (await owner.get('/api/user/devices', { token: o.token })).body.data;
    assert.ok(ownerDevices.devices.some((d) => d.shortId === 'cccccccc' && d.active), 'seat on the team plan');
    const memberDevices = (await member.get('/api/user/devices', { token: m.token })).body.data;
    assert.ok(memberDevices.devices.some((d) => d.shortId === 'cccccccc' && d.signedIn && d.active),
      'the member sees their machine holding its seat');
    // Their seat lives on the owner's plan, so their own device list has to
    // read from that plan: their own (free) row would say "no seat limit".
    assert.equal(memberDevices.seatsEnforced, true);
    assert.equal(memberDevices.seats, 5);

    // …but only their own machines. A member must not learn what a colleague
    // runs, nor be able to free a colleague's seat by guessing its id.
    const ownerApp = srv.client();
    const ownerToken = await signIn(ownerApp, owner, o, 'e'.repeat(32), 'Owner PC');
    assert.equal((await ownerApp.post('/api/license/validate',
      { device_token: ownerToken, device_fingerprint: 'e'.repeat(32) })).body.valid, true);
    const memberAgain = (await member.get('/api/user/devices', { token: m.token })).body.data;
    assert.ok(!memberAgain.devices.some((d) => d.shortId === 'eeeeeeee'),
      "a colleague's machine never appears on a member's list");
    const [ownerSeat] = await srv.query(
      'SELECT id FROM license_activations WHERE device_fingerprint = ?', ['e'.repeat(32)]);
    const refusedRelease = await member.del(`/api/user/devices/${ownerSeat.id}`, { token: m.token });
    assert.equal(refusedRelease.status, 404, "a member cannot free a colleague's seat");
    // Signing the member's machine out frees the seat on the team plan.
    await memberApp.post('/api/device/signout', { device_token: token, device_fingerprint: 'c'.repeat(32) });
    const [seat] = await srv.query('SELECT lease_expires_at FROM license_activations WHERE device_fingerprint = ?', ['c'.repeat(32)]);
    assert.equal(seat.lease_expires_at, null);
  });

  await t.test('a control-panel account cannot approve, and a promoted account is signed out', async () => {
    const admin = srv.client();
    const a = await srv.makeUser(admin, 'willbeadmin');
    const token = await signIn(app, admin, a, 'd'.repeat(32), 'Admin PC');
    assert.equal((await app.post('/api/license/validate', { device_token: token, device_fingerprint: 'd'.repeat(32) })).body.valid, true);
    await srv.query("UPDATE users SET role = 'admin' WHERE email = ?", [a.email]);
    const res = await app.post('/api/license/validate', { device_token: token, device_fingerprint: 'd'.repeat(32) });
    assert.equal(res.body.reason, 'signed_out');
    const code = await app.post('/api/device/code', { device_fingerprint: 'd'.repeat(32) });
    const refused = await admin.post('/api/device/approve', { user_code: code.body.data.userCode }, { token: a.token });
    assert.ok(refused.status === 403 || refused.status === 401, refused.text);
  });

  await srv.stop();
});
