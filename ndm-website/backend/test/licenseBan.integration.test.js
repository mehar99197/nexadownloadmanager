'use strict';

/**
 * H-03 — a ban must reach the desktop app, not just the website.
 *
 * `resolveSubscription()` used to read the `subscriptions` row alone: status and
 * expiry_date, never the owner. Banning an account from the admin panel deletes
 * its site sessions and sets `users.banned`, but it leaves the subscription
 * exactly as it was — so `POST /api/license/validate` kept answering
 * `valid: true` with full Pro entitlements and a freshly signed 24-hour token,
 * every day, for ever. Banning was website-only.
 *
 * There are TWO people a ban can land on, and the second is the harder half. A
 * Pro licence belongs to the account that pays for it, so refusing the owner is
 * the whole story. A TEAM licence is one key with five seats that routes/user.js
 * deliberately hands to every member — so when a MEMBER is banned, the account
 * these routes read is the owner's, and the owner is perfectly fine. Both halves
 * are exercised below, because the second one is invisible from a single-user
 * fixture.
 *
 * This suite drives the REAL HTTP endpoints the C++ app calls, because the hole
 * was in how the route composed its queries, not in any one helper: a unit test
 * on the model would have passed throughout. It asserts the LITERAL body the app
 * parses (see CONTRACT.md §2 EXCEPTION 1) — `{valid, reason, trial, features}`,
 * never the `{ok, data}` envelope.
 */
process.env.RATE_LIMIT_DISABLED = '1';   // this suite spends more than licenseLimiter's 10/hour

const test = require('node:test');
const assert = require('node:assert/strict');
const srv = require('./helpers/testServer');
const { entitlementsFor } = require('../src/config/plans');

const DEVICE = 'a'.repeat(64);
const OWNER_DEVICE = 'c'.repeat(64);
const MEMBER_DEVICE = 'd'.repeat(64);

/** The whole refusal shape, asserted in one place so every case is held to it. */
function assertRefused(res, reason) {
  assert.equal(res.status, 200, res.text);      // always 200 so the C++ client parses it
  assert.equal(res.body.ok, undefined, 'literal body, not the envelope');
  assert.equal(res.body.valid, false);
  assert.equal(res.body.reason, reason);
  assert.equal(res.body.trial, false);
  assert.equal(res.body.token, undefined, 'a refused client is handed no token');
  assert.equal(res.body.plan, undefined);
  // Free entitlements, so the app degrades to reduced mode instead of guessing.
  assert.deepEqual(res.body.features, entitlementsFor('free'));
}

test('a banned account cannot keep a working licence', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();
  await srv.reset();

  const api = srv.client();
  await srv.makeUser(api, 'ban');
  const [sub] = await srv.query('SELECT * FROM subscriptions LIMIT 1');
  // Pro, so a granted and a refused answer differ by more than one boolean: the
  // refusal has to hand back FREE entitlements, not the plan's.
  await srv.query("UPDATE subscriptions SET plan = 'pro', seats = 1 WHERE id = ?", [sub.id]);
  const key = sub.license_key;

  const validate = (fp = DEVICE) =>
    api.post('/api/license/validate', { license_key: key, device_fingerprint: fp });
  const heartbeat = (fp = DEVICE) =>
    api.post('/api/license/heartbeat', { license_key: key, device_fingerprint: fp });
  const release = (fp = DEVICE) =>
    api.post('/api/license/release', { license_key: key, device_fingerprint: fp });

  // The ban is set straight in the database: what is under test is what the
  // licence routes do with `users.banned`, and going through the admin panel
  // would make this suite fail for reasons that belong to the admin routes.
  const setBanned = (banned) =>
    srv.query('UPDATE users SET banned = ? WHERE id = ?', [banned, sub.user_id]);

  const liveLeases = async () => Number((await srv.query(
    `SELECT COUNT(*) AS n FROM license_activations
      WHERE subscription_id = ? AND lease_expires_at IS NOT NULL AND lease_expires_at > NOW()`,
    [sub.id]
  ))[0].n);

  await t.test('an unbanned account validates and takes its seat', async () => {
    const res = await validate();
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.valid, true);
    assert.equal(res.body.plan, 'pro');
    assert.ok(res.body.token, 'signed licence token issued');
    assert.deepEqual(res.body.features, entitlementsFor('pro'));
    assert.equal(await liveLeases(), 1, 'the device holds a seat');
  });

  await t.test('validate refuses the moment the owner is banned', async () => {
    await setBanned(1);
    assertRefused(await validate(), 'banned');
  });

  await t.test('heartbeat refuses too — an existing lease does not keep the app alive', async () => {
    // The seat taken above is still live: the ban is enforced when the licence
    // is resolved, so the running client is cut off on its very next beat
    // rather than being allowed to coast until the 15-minute lease lapses.
    assert.equal(await liveLeases(), 1, 'the pre-ban lease is still in the table');
    assertRefused(await heartbeat(), 'banned');
    assert.equal(await liveLeases(), 1, 'refusing is not revoking');
  });

  await t.test('a second device is refused for the ban, not for the seat cap', async () => {
    // Without the ban check this device would have been told `seat_limit` — a
    // reason the desktop app treats as recoverable and keeps the key for.
    assertRefused(await validate('b'.repeat(64)), 'banned');
  });

  await t.test('the ban outranks status and expiry', async () => {
    await srv.query(
      "UPDATE subscriptions SET status = 'cancelled', expiry_date = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id = ?",
      [sub.id]
    );
    assertRefused(await validate(), 'banned');
    await srv.query(
      "UPDATE subscriptions SET status = 'active', expiry_date = NULL WHERE id = ?", [sub.id]
    );
  });

  await t.test('releasing a seat still works while banned', async () => {
    // Deliberate exemption: handing a seat back is housekeeping, not a
    // privilege. Refusing it would only pin the banned user's seat for the rest
    // of its lease, where it blocks a legitimate team member.
    const res = await release();
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.released, true);
    assert.equal(await liveLeases(), 0, 'the lease really was dropped');
  });

  await t.test('unbanning restores the licence', async () => {
    await setBanned(0);
    const res = await validate();
    assert.equal(res.body.valid, true);
    assert.equal(res.body.plan, 'pro');
    assert.ok(res.body.token);
    const beat = await heartbeat();
    assert.equal(beat.body.valid, true);
    assert.equal(beat.body.plan, 'pro');
  });

  // No srv.stop() here: it ends the process-wide pool that config/db caches and
  // never rebuilds, so only the LAST suite in this file may close it.
});

test('a banned team member cannot keep the key they were handed', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();
  await srv.reset();

  const api = srv.client();
  // Two real accounts: the owner of a five-seat Team licence, and somebody on
  // their roster. Both are addressed by bearer token below, so one client (one
  // cookie jar) is enough for the pair.
  const owner = await srv.makeUser(api, 'teamowner');
  const member = await srv.makeUser(api, 'teammember');
  const idOf = async (email) =>
    (await srv.query('SELECT id FROM users WHERE email = ?', [email]))[0].id;
  const ownerId = await idOf(owner.email);
  const memberId = await idOf(member.email);

  const [ownerSub] = await srv.query('SELECT * FROM subscriptions WHERE user_id = ?', [ownerId]);
  await srv.query("UPDATE subscriptions SET plan = 'team', seats = 5 WHERE id = ?", [ownerSub.id]);
  // The roster row is written straight to the table rather than driven through
  // /api/team's invite + accept: what is under test is what the LICENCE routes
  // do with a shared key, and an invite-flow failure would make this suite red
  // for something that belongs to another router.
  await srv.query(
    `INSERT INTO team_members (subscription_id, email, user_id, status, invited_by, accepted_at)
     VALUES (?, ?, ?, 'active', ?, NOW())`,
    [ownerSub.id, member.email, memberId, ownerId]
  );

  const sharedKey = ownerSub.license_key;
  const validate = (key, fp) =>
    api.post('/api/license/validate', { license_key: key, device_fingerprint: fp });
  const heartbeat = (key, fp) =>
    api.post('/api/license/heartbeat', { license_key: key, device_fingerprint: fp });

  const currentKey = async () => (await srv.query(
    'SELECT license_key FROM subscriptions WHERE id = ?', [ownerSub.id]
  ))[0].license_key;
  const rosterSize = async () => Number((await srv.query(
    'SELECT COUNT(*) AS n FROM team_members WHERE subscription_id = ?', [ownerSub.id]
  ))[0].n);
  const liveLeases = async () => Number((await srv.query(
    `SELECT COUNT(*) AS n FROM license_activations
      WHERE subscription_id = ? AND lease_expires_at IS NOT NULL AND lease_expires_at > NOW()`,
    [ownerSub.id]
  ))[0].n);

  await t.test('the member runs on the owner key, which is how a team plan works', async () => {
    // Not an attack: this is the key the member's own dashboard hands them.
    const dashboard = await api.get('/api/user/license', { token: member.token });
    assert.equal(dashboard.status, 200, dashboard.text);
    assert.equal(dashboard.body.data.licenseKey, sharedKey);
    assert.equal(dashboard.body.data.viaTeam, true);

    for (const device of [OWNER_DEVICE, MEMBER_DEVICE]) {
      const res = await validate(sharedKey, device);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.valid, true);
      assert.equal(res.body.plan, 'team');
      assert.ok(res.body.token, 'signed licence token issued');
    }
    assert.equal(await liveLeases(), 2, 'both machines hold a seat');
  });

  await t.test('banning the member takes the shared key away', async () => {
    await srv.query('UPDATE users SET banned = ? WHERE id = ?', [1, memberId]);
    // The half a single-user fixture cannot see: the ban is on the member, the
    // account behind the licence is the owner's, and the request carries no
    // user identity at all. Before the fix this answered valid:true, plan
    // 'team', full Pro entitlements and a fresh 24-hour token, every day for
    // ever, while the banned member went on pinning one of the owner's seats.
    // Nothing can tell this device from a colleague's, so the shared secret
    // itself is withdrawn — and the key just rotated away is not found.
    assertRefused(await validate(sharedKey, MEMBER_DEVICE), 'not_found');
    assert.notEqual(await currentKey(), sharedKey, 'the shared key was rotated');
    assert.equal(await rosterSize(), 0, 'the banned member is off the roster');
    assert.equal(await liveLeases(), 0, 'every seat on the licence was let go');
    // The old key is dead on every machine, the owner's included. That is the
    // price of a credential a banned person already knows, and it is paid once:
    // the dashboard hands the new one out immediately (next subtest).
    assertRefused(await validate(sharedKey, OWNER_DEVICE), 'not_found');
    assertRefused(await heartbeat(sharedKey, MEMBER_DEVICE), 'not_found');
  });

  await t.test('the team is re-keyed, not locked out', async () => {
    const rotated = await currentKey();
    const dashboard = await api.get('/api/user/license', { token: owner.token });
    assert.equal(dashboard.body.data.licenseKey, rotated, 'the owner sees the new key at once');

    const res = await validate(rotated, OWNER_DEVICE);
    assert.equal(res.body.valid, true);
    assert.equal(res.body.plan, 'team');
    assert.equal(res.body.seats, 5);
    assert.ok(res.body.token);
    assert.equal(await liveLeases(), 1, 'the seats the rotation freed are usable again');
  });

  await t.test('the reconciliation runs once, not on every beat', async () => {
    // Nothing records that a rotation happened, so deleting the roster row is
    // the only thing stopping the next request rotating again — and a key that
    // churns every five minutes is a licence nobody can use.
    const rotated = await currentKey();
    assert.equal((await heartbeat(rotated, OWNER_DEVICE)).body.valid, true);
    assert.equal((await validate(rotated, OWNER_DEVICE)).body.valid, true);
    assert.equal(await currentKey(), rotated, 'the key is stable once the ban is reconciled');
  });

  await t.test('the banned member cannot follow the key', async () => {
    // The rotation only bites because the banned account cannot read the new
    // key: requireAuth refuses it, and the ban drops its sessions as well.
    const denied = await api.get('/api/user/license', { token: member.token });
    assert.equal(denied.status, 403, denied.text);

    // ...and an unban does not silently hand it back either, because the ban
    // ended the membership: the owner has to invite them again.
    await srv.query('UPDATE users SET banned = ? WHERE id = ?', [0, memberId]);
    const own = await api.get('/api/user/license', { token: member.token });
    assert.equal(own.status, 200, own.text);
    assert.equal(own.body.data.viaTeam, false);
    assert.equal(own.body.data.plan, 'free');
    assert.notEqual(own.body.data.licenseKey, await currentKey());
  });

  await srv.stop();
});
