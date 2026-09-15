'use strict';

/**
 * End-to-end HTTP tests against the real app and a real MySQL database.
 *
 * These cover the paths where a bug costs money or access: the auth/refresh
 * rotation, licence validation and seat caps, the no-card trial, the release
 * feed the desktop updater polls, and the admin session. They skip themselves
 * when no database is reachable (see test/README.md).
 */
process.env.RATE_LIMIT_DISABLED = '1';   // the limiter suite re-enables them

const test = require('node:test');
const assert = require('node:assert/strict');
const srv = require('./helpers/testServer');

const dbUp = () => srv.available();

test('backend API', async (t) => {
  if (!(await dbUp())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();

  // ---------------------------------------------------------------- auth ---
  await t.test('registration, login and refresh rotation', async (t2) => {
    await srv.reset();
    const api = srv.client();
    const email = 'auth-user@example.test';
    const password = 'a-strong-password';

    await t2.test('registers and issues a free licence', async () => {
      const res = await api.post('/api/auth/register', { name: 'Auth User', email, password });
      assert.equal(res.status, 201, res.text);   // created
      const rows = await srv.query('SELECT plan, license_key FROM subscriptions');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].plan, 'free');
      assert.match(rows[0].license_key, /^NDM(-[A-Z0-9]{4}){3}$/);
    });

    await t2.test('a duplicate email is answered exactly like a new one', async () => {
      // Registration must not be a membership oracle. The reply to an address
      // that already has an account is byte-identical to the reply for a fresh
      // one — same status, same envelope — and no second account is created;
      // the real owner is told in their own inbox instead.
      const res = await api.post('/api/auth/register', { name: 'Again', email, password });
      assert.equal(res.status, 201, res.text);
      assert.equal(res.body.ok, true);
      assert.doesNotMatch(JSON.stringify(res.body).toLowerCase(), /exist|already|taken|duplicate/);
      // Byte-identical, not merely "both 201". Returning `{userId}` on the
      // real-registration branch alone made the PRESENCE of that field the
      // oracle the equal status codes were supposed to remove.
      const fresh = await api.post('/api/auth/register',
        { name: 'Fresh', email: `fresh-${Date.now()}@example.test`, password });
      assert.deepEqual(res.body, fresh.body);
      const users = await srv.query('SELECT id FROM users WHERE email = ?', [email]);
      assert.equal(users.length, 1);
      const subs = await srv.query(
        'SELECT s.id FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE u.email = ?', [email]);
      assert.equal(subs.length, 1, 'no second subscription for an address that already had one');
    });

    await t2.test('rejects the wrong password without leaking which field was wrong', async () => {
      const res = await api.post('/api/auth/login', { email, password: 'not-it' });
      assert.equal(res.status, 401);
      assert.equal(res.body.ok, false);
      assert.doesNotMatch(String(res.body.error.message).toLowerCase(), /password is|no such user/);
    });

    let accessToken;
    await t2.test('logs in and sets an httpOnly refresh cookie', async () => {
      const res = await api.post('/api/auth/login', { email, password });
      assert.equal(res.status, 200, res.text);
      accessToken = res.body.data.token;
      assert.ok(accessToken);
      assert.ok(api.cookies.get('ndm_refresh'), 'refresh cookie set');
    });

    await t2.test('the access token authenticates /api/user/me', async () => {
      const res = await api.get('/api/user/me', { token: accessToken });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.user.email, email);
      // The trial fields the frontend renders must always be present.
      assert.ok(Object.hasOwn(res.body.data.subscription, 'trial'));
      assert.ok(Object.hasOwn(res.body.data.subscription, 'trialEndsAt'));
      // CONTRACT.md documents the User as carrying camelCase timestamps, but
      // this route returns the DB row, which is snake_case. The profile page
      // read `createdAt`, got undefined, and printed "Member since —" for
      // every account that ever existed. The mismatch was invisible because
      // nothing failed — so assert the documented names exist and parse.
      assert.ok(res.body.data.user.createdAt, 'createdAt is exposed');
      assert.ok(!Number.isNaN(Date.parse(res.body.data.user.createdAt)), 'createdAt is a date');
      assert.equal(typeof res.body.data.user.emailVerified, 'boolean');
      // ...and that exposing them did not also expose a credential.
      for (const leaked of ['password_hash', 'refresh_token_hash', 'totp_secret', 'token_version'])
        assert.ok(!(leaked in res.body.data.user), `${leaked} is not returned`);
    });

    await t2.test('refresh rotates the cookie and invalidates the old one', async () => {
      const old = api.cookies.get('ndm_refresh');
      const res = await api.post('/api/auth/refresh');
      assert.equal(res.status, 200, res.text);
      assert.ok(res.body.data.token);
      const rotated = api.cookies.get('ndm_refresh');
      assert.notEqual(rotated, old, 'cookie value changed');

      // Replaying the old cookie must fail: that is the whole point of
      // rotation. Two tabs racing on one cookie jar get a 30-second grace
      // (models/UserSession.js), so the rotation is aged past it first.
      await srv.query('UPDATE user_sessions SET rotated_at = DATE_SUB(NOW(), INTERVAL 2 MINUTE) WHERE prev_token_hash IS NOT NULL');
      const replay = srv.client();
      replay.cookies.set('ndm_refresh', old);
      const res2 = await replay.post('/api/auth/refresh');
      assert.equal(res2.status, 401, 'stale refresh token rejected');
      // …and the replay ended the whole family: the rotated cookie is dead too.
      assert.equal((await api.post('/api/auth/refresh')).status, 401, 'family revoked after replay');
      // A fresh sign-in for the tests that follow.
      const again = await api.post('/api/auth/login', { email, password });
      assert.equal(again.status, 200, again.text);
    });

    await t2.test('logout clears the cookie and revokes the session', async () => {
      const res = await api.post('/api/auth/logout');
      assert.equal(res.status, 200, res.text);
      const rows = await srv.query(
        'SELECT COUNT(*) AS live FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ? AND s.revoked_at IS NULL',
        [email]);
      assert.equal(Number(rows[0].live), 0);
    });

    await t2.test('a banned user cannot use a still-valid access token', async () => {
      const fresh = await api.post('/api/auth/login', { email, password });
      const token = fresh.body.data.token;
      await srv.query('UPDATE users SET banned = 1 WHERE email = ?', [email]);
      const res = await api.get('/api/user/me', { token });
      assert.equal(res.status, 403);
      await srv.query('UPDATE users SET banned = 0 WHERE email = ?', [email]);
    });
  });

  // ------------------------------------------------------------- licence ---
  await t.test('licence validation', async (t2) => {
    await srv.reset();
    const api = srv.client();
    const user = await srv.makeUser(api, 'lic');
    const [sub] = await srv.query('SELECT * FROM subscriptions LIMIT 1');
    const key = sub.license_key;
    const fingerprint = 'a'.repeat(64);

    await t2.test('always answers 200 with a literal body, never the envelope', async () => {
      const res = await api.post('/api/license/validate', {
        license_key: key, device_fingerprint: fingerprint,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, undefined, 'no envelope');
      assert.equal(res.body.valid, true);
      assert.equal(res.body.plan, 'free');
      assert.ok(res.body.token, 'signed licence token returned');
      assert.equal(typeof res.body.trial, 'boolean', 'trial is always present');
    });

    await t2.test('an unknown key is invalid, still HTTP 200', async () => {
      const res = await api.post('/api/license/validate', {
        license_key: 'NDM-ZZZZ-ZZZZ-ZZZZ', device_fingerprint: fingerprint,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.valid, false);
      assert.equal(res.body.reason, 'not_found');
      assert.equal(res.body.trial, false);
    });

    await t2.test('a malformed key is rejected by validation', async () => {
      const res = await api.post('/api/license/validate', {
        license_key: 'nope', device_fingerprint: fingerprint,
      });
      assert.equal(res.status, 400);
    });

    await t2.test('the same device re-validates without consuming a seat', async () => {
      for (let i = 0; i < 3; i += 1) {
        const res = await api.post('/api/license/validate', {
          license_key: key, device_fingerprint: fingerprint,
        });
        assert.equal(res.body.valid, true);
      }
      const rows = await srv.query('SELECT COUNT(*) AS n FROM license_activations');
      assert.equal(Number(rows[0].n), 1, 'one activation row for one device');
    });

    await t2.test('a second device exceeds a 1-seat plan', async () => {
      const res = await api.post('/api/license/validate', {
        license_key: key, device_fingerprint: 'b'.repeat(64),
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.valid, false);
      assert.equal(res.body.reason, 'seat_limit');
    });

    // A period that runs out is no longer reported as `expired`: the desktop
    // client DELETES a key it is told is expired, so a renewal webhook arriving
    // late used to cost the customer their licence outright. A lapsed plan
    // falls back to Free instead — see Subscription.expireIfLapsed — and only a
    // deliberately stopped licence still reports `expired`.
    await t2.test('a plan just past its date keeps working through the grace period', async () => {
      await srv.query(
        "UPDATE subscriptions SET expiry_date = DATE_SUB(NOW(), INTERVAL 1 DAY), plan = 'pro' WHERE id = ?",
        [sub.id]
      );
      const res = await api.post('/api/license/validate', {
        license_key: key, device_fingerprint: fingerprint,
      });
      assert.equal(res.body.valid, true);
      assert.equal(res.body.plan, 'pro');
    });

    await t2.test('past the grace period it falls back to Free, key intact', async () => {
      await srv.query(
        "UPDATE subscriptions SET expiry_date = DATE_SUB(NOW(), INTERVAL 10 DAY), plan = 'pro' WHERE id = ?",
        [sub.id]
      );
      const res = await api.post('/api/license/validate', {
        license_key: key, device_fingerprint: fingerprint,
      });
      assert.equal(res.body.valid, true);
      assert.equal(res.body.plan, 'free');
    });

    await t2.test('a licence stopped on purpose still reports expired', async () => {
      await srv.query("UPDATE subscriptions SET status = 'expired' WHERE id = ?", [sub.id]);
      const res = await api.post('/api/license/validate', {
        license_key: key, device_fingerprint: fingerprint,
      });
      assert.equal(res.body.valid, false);
      assert.equal(res.body.reason, 'expired');
      await srv.query("UPDATE subscriptions SET status = 'active' WHERE id = ?", [sub.id]);
    });

    void user;
  });

  // ------------------------------------------------- sharing suspension ---
  // Auto-suspension is the only place this system acts against a paying
  // customer with no human in the loop, so the whole chain gets driven for
  // real: a leaked key gets cut off, the cut-off is indistinguishable from a
  // full licence, the key SURVIVES it, and an admin can undo it and have that
  // decision stick.
  await t.test('a leaked key is auto-suspended, and an admin can undo it', async (t2) => {
    await srv.reset();
    const api = srv.client();
    await srv.makeUser(api, 'sharing');
    const [sub] = await srv.query('SELECT * FROM subscriptions LIMIT 1');
    await srv.query("UPDATE subscriptions SET plan = 'pro', seats = 1 WHERE id = ?", [sub.id]);
    const key = sub.license_key;

    const validate = (fp) => api.post('/api/license/validate',
      { license_key: key, device_fingerprint: fp });
    const device = (n) => String(n).padStart(64, '0');

    const bcrypt = require('bcryptjs');
    await srv.query(
      "INSERT INTO users (name, email, password_hash, role, email_verified) VALUES ('Admin', 'shareadmin@example.test', ?, 'admin', 1)",
      [await bcrypt.hash('admin-password-123', 12)]
    );
    const adminApi = srv.client();
    const adminLogin = await adminApi.post('/api/admin/login',
      { email: 'shareadmin@example.test', password: 'admin-password-123' });
    const adminAuth = { token: adminLogin.body.data.token };

    await t2.test('a handful of devices is completely normal', async () => {
      for (let i = 1; i <= 5; i += 1) {
        // Each device frees its seat, exactly as a real client does on exit.
        assert.equal((await validate(device(i))).body.valid, true, `device ${i}`);
        await api.post('/api/license/release',
          { license_key: key, device_fingerprint: device(i) });
      }
      const [row] = await srv.query('SELECT * FROM subscriptions WHERE id = ?', [sub.id]);
      assert.equal(row.sharing_suspended_at, null, 'nobody is suspended for five machines');
    });

    await t2.test('a key spreading across many machines gets cut off', async () => {
      let cutOffAt = null;
      for (let i = 6; i <= 60 && cutOffAt === null; i += 1) {
        const res = await validate(device(i));
        if (!res.body.valid) cutOffAt = i;
        else {
          await api.post('/api/license/release',
            { license_key: key, device_fingerprint: device(i) });
        }
      }
      assert.ok(cutOffAt, 'the licence must eventually be suspended');
      const [row] = await srv.query('SELECT * FROM subscriptions WHERE id = ?', [sub.id]);
      assert.ok(row.sharing_suspended_at, 'and it is recorded as a sharing suspension');
      assert.equal(row.sharing_level, 'suspected');
      assert.ok(row.sharing_reason, 'with a reason an admin can read');
    });

    await t2.test('the cut-off looks like a full licence, and keeps the key alive', async () => {
      const res = await validate(device(1));
      assert.equal(res.body.valid, false);
      // `seat_limit` is what the desktop client keeps its stored key for.
      // `cancelled`/`expired` would make it DELETE the key, which is not
      // something to do to somebody a heuristic merely suspects.
      assert.equal(res.body.reason, 'seat_limit');

      const [row] = await srv.query('SELECT * FROM subscriptions WHERE id = ?', [sub.id]);
      assert.equal(row.status, 'active', 'status is untouched — this is reversible');
      assert.ok(row.license_key, 'the key itself still exists');
    });

    await t2.test('it shows up in the admin review queue', async () => {
      const res = await adminApi.get('/api/admin/subscriptions/flagged', adminAuth);
      assert.equal(res.status, 200, res.text);
      const found = res.body.data.subscriptions.find((s) => String(s.id) === String(sub.id));
      assert.ok(found, 'the suspended licence is listed for review');
      assert.ok(found.sharing_suspended_at);
    });

    await t2.test('an admin can lift it, and the licence works again', async () => {
      const res = await adminApi.post(
        `/api/admin/subscriptions/${sub.id}/sharing/clear`, {}, adminAuth);
      assert.equal(res.status, 200, res.text);
      assert.equal((await validate(device(1))).body.valid, true, 'the customer is back');
    });

    await t2.test('lifting it sticks — the next new device does not re-suspend', async () => {
      // The device history that triggered the suspension is still there, so
      // without the exemption the admin's decision would last one activation.
      await api.post('/api/license/release',
        { license_key: key, device_fingerprint: device(1) });
      const res = await validate(device(99));
      assert.equal(res.body.valid, true, 'the admin decision survives a new device');
      const [row] = await srv.query('SELECT * FROM subscriptions WHERE id = ?', [sub.id]);
      assert.equal(row.sharing_suspended_at, null);
    });

    await t2.test('an admin can put it back under enforcement', async () => {
      const res = await adminApi.post(
        `/api/admin/subscriptions/${sub.id}/sharing/resume`, {}, adminAuth);
      assert.equal(res.status, 200, res.text);
      const [row] = await srv.query('SELECT * FROM subscriptions WHERE id = ?', [sub.id]);
      assert.equal(Number(row.sharing_exempt), 0);
    });
  });

  // -------------------------------------------------------- seat freeing ---
  // Regression suite for the bug where freeing a seat did nothing: /heartbeat
  // called the same acquireSeat() as /validate, and since `busy` counts only
  // OTHER devices, a one-seat licence read "0 busy >= 1 seat" as false and
  // handed the just-freed device a brand-new lease. The admin action was undone
  // within five minutes and no client ever downgraded.
  await t.test('freeing a seat actually frees it', async (t2) => {
    await srv.reset();
    const api = srv.client();
    const user = await srv.makeUser(api, 'seat');
    const [sub] = await srv.query('SELECT * FROM subscriptions LIMIT 1');
    await srv.query("UPDATE subscriptions SET plan = 'pro', seats = 1 WHERE id = ?", [sub.id]);
    const key = sub.license_key;
    const deviceA = 'a'.repeat(64);
    const deviceB = 'b'.repeat(64);

    const validate = (fp) => api.post('/api/license/validate',
      { license_key: key, device_fingerprint: fp });
    const heartbeat = (fp) => api.post('/api/license/heartbeat',
      { license_key: key, device_fingerprint: fp });

    // Driven through the REAL admin endpoint the "Free seats" button calls, not
    // a hand-written UPDATE — the point of this suite is that the whole chain
    // works, and a direct UPDATE would keep passing even if the route stopped
    // marking the seat revoked.
    const bcrypt = require('bcryptjs');
    await srv.query(
      "INSERT INTO users (name, email, password_hash, role, email_verified) VALUES ('Admin', 'seatadmin@example.test', ?, 'admin', 1)",
      [await bcrypt.hash('admin-password-123', 12)]
    );
    const adminApi = srv.client();
    const adminLogin = await adminApi.post('/api/admin/login',
      { email: 'seatadmin@example.test', password: 'admin-password-123' });
    const adminAuth = { token: adminLogin.body.data.token };
    const freeAllSeats = () =>
      adminApi.post(`/api/admin/subscriptions/${sub.id}/revoke-device`, {}, adminAuth);

    await t2.test('device A takes the only seat and can beat to hold it', async () => {
      assert.equal((await validate(deviceA)).body.valid, true);
      const beat = await heartbeat(deviceA);
      assert.equal(beat.body.valid, true, 'a held lease renews');
    });

    await t2.test('a heartbeat re-issues a usable, device-bound licence token', async () => {
      // This is what lets the token be short-lived. Without it the client, which
      // re-validates only every six hours, would hold an expired token for most
      // of its session — so a regression here shows up as paying users seeing
      // ads, not as an obvious failure.
      const { verifyLicense } = require('../src/utils/jwt');
      const beat = await heartbeat(deviceA);
      assert.ok(beat.body.token, 'the beat carries a token');

      const claims = verifyLicense(beat.body.token);
      assert.equal(claims.device, deviceA, 'bound to the beating device');
      assert.equal(claims.plan, beat.body.plan, 'and agrees with the plan it reports');
      assert.ok(claims.features, 'entitlements ride inside the signature');

      const lifetime = claims.exp - claims.iat;
      assert.ok(lifetime <= 15 * 60 && lifetime > 0,
        `token should be short-lived, got ${lifetime}s`);
    });

    await t2.test('device B is refused while A holds the seat', async () => {
      const res = await validate(deviceB);
      assert.equal(res.body.valid, false);
      assert.equal(res.body.reason, 'seat_limit');
    });

    await t2.test('after freeing, A\'s heartbeat is refused instead of re-taking it', async () => {
      const freed = await freeAllSeats();
      assert.equal(freed.status, 200, freed.text);
      const beat = await heartbeat(deviceA);
      assert.equal(beat.body.valid, false, 'the freed device must not keep Pro');
      assert.equal(beat.body.reason, 'seat_revoked');
      // ...and it must stay refused, not recover on the next beat.
      assert.equal((await heartbeat(deviceA)).body.reason, 'seat_revoked');
      const rows = await srv.query(
        'SELECT lease_expires_at FROM license_activations WHERE device_fingerprint = ?', [deviceA]
      );
      assert.equal(rows[0].lease_expires_at, null, 'no lease was handed back');
    });

    await t2.test('the freed seat is immediately usable by another device', async () => {
      const res = await validate(deviceB);
      assert.equal(res.body.valid, true, 'B can now take the seat A gave up');
      assert.equal(res.body.plan, 'pro');
    });

    await t2.test('A re-activating is refused while B holds the seat', async () => {
      const res = await validate(deviceA);
      assert.equal(res.body.valid, false);
      assert.equal(res.body.reason, 'seat_limit', 'not seat_revoked — someone else has it now');
    });

    await t2.test('A regains Pro by re-activating once the seat is free again', async () => {
      await srv.query('UPDATE license_activations SET lease_expires_at = NULL WHERE device_fingerprint = ?',
        [deviceB]);
      const res = await validate(deviceA);
      assert.equal(res.body.valid, true);
      assert.equal(res.body.plan, 'pro');
      const rows = await srv.query(
        'SELECT revoked_at FROM license_activations WHERE device_fingerprint = ?', [deviceA]
      );
      assert.equal(rows[0].revoked_at, null, 're-activation clears the revocation');
      assert.equal((await heartbeat(deviceA)).body.valid, true, 'and beats normally again');
    });

    await t2.test('a user freeing a device from their dashboard revokes it too', async () => {
      // Same guarantee on the self-service path: Dashboard's "Free this seat"
      // calls DELETE /api/user/devices/:id, which must also stop the freed
      // machine's heartbeat from quietly taking the seat back.
      assert.equal((await validate(deviceA)).body.valid, true);
      const list = await api.get('/api/user/devices', { token: user.token });
      assert.equal(list.status, 200, list.text);
      const device = list.body.data.devices.find((d) => d.active);
      assert.ok(device, 'the live device is listed as holding a seat');

      const freed = await api.del(`/api/user/devices/${device.id}`, { token: user.token });
      assert.equal(freed.status, 200, freed.text);

      const beat = await heartbeat(deviceA);
      assert.equal(beat.body.valid, false, 'the freed device must not keep Pro');
      assert.equal(beat.body.reason, 'seat_revoked');
      // ...and re-activating still gets it back, since the seat is free.
      assert.equal((await validate(deviceA)).body.valid, true);
    });

    await t2.test('a lease that merely lapsed still recovers on a heartbeat', async () => {
      // The distinction that makes revoked_at necessary: a laptop asleep past
      // its 15-minute lease must not be treated like a revoked one.
      await srv.query(
        'UPDATE license_activations SET lease_expires_at = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE device_fingerprint = ?',
        [deviceA]
      );
      const beat = await heartbeat(deviceA);
      assert.equal(beat.body.valid, true, 'an expired-but-not-revoked lease is retaken');
    });

    void user;
  });

  // --------------------------------------------------------------- trial ---
  await t.test('the 7-day no-card Pro trial', async (t2) => {
    await srv.reset();
    const api = srv.client();
    const user = await srv.makeUser(api, 'trial');

    await t2.test('starts once and grants Pro', async () => {
      const res = await api.post('/api/subscription/start-trial', {}, { token: user.token });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.plan, 'pro');
      assert.equal(res.body.data.trial, true);
      assert.ok(res.body.data.trialEndsAt);
      const rows = await srv.query('SELECT plan, trial_ends_at FROM subscriptions');
      assert.equal(rows[0].plan, 'pro');
      assert.notEqual(rows[0].trial_ends_at, null);
    });

    await t2.test('cannot be started twice', async () => {
      const res = await api.post('/api/subscription/start-trial', {}, { token: user.token });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'TRIAL_UNAVAILABLE');
    });

    await t2.test('licence validation reports trial:true while it runs', async () => {
      const [sub] = await srv.query('SELECT license_key FROM subscriptions LIMIT 1');
      const res = await api.post('/api/license/validate', {
        license_key: sub.license_key, device_fingerprint: 'c'.repeat(64),
      });
      assert.equal(res.body.valid, true);
      assert.equal(res.body.plan, 'pro');
      assert.equal(res.body.trial, true);
    });

    await t2.test('expires lazily back to free once the end date passes', async () => {
      await srv.query(
        'UPDATE subscriptions SET trial_ends_at = DATE_SUB(NOW(), INTERVAL 1 HOUR), expiry_date = DATE_SUB(NOW(), INTERVAL 1 HOUR)'
      );
      const res = await api.get('/api/subscription/status', { token: user.token });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.plan, 'free', 'downgraded without a cron job');
      assert.equal(res.body.data.trial, false);
      const rows = await srv.query('SELECT plan, trial_ends_at FROM subscriptions');
      assert.equal(rows[0].plan, 'free');
      assert.equal(rows[0].trial_ends_at, null);
    });
  });

  // ------------------------------------------------------------ releases ---
  await t.test('releases, update feed and counted downloads', async (t2) => {
    await srv.reset();
    const api = srv.client();

    await t2.test('the feed 404s cleanly with no release published', async () => {
      const res = await api.get('/api/releases/feed?os=windows');
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'no_release');
    });

    await srv.query(
      `INSERT INTO releases (version, windows_url, linux_url, changelog, windows_sha256, is_latest, published_at)
       VALUES ('0.2.0', 'https://cdn.example.test/nexa.exe', 'https://cdn.example.test/nexa.deb',
               'Faster everything', ?, 1, NOW())`,
      ['d'.repeat(64)]
    );

    await t2.test('latest exposes checksums and the download count', async () => {
      const res = await api.get('/api/releases/latest');
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.version, '0.2.0');
      assert.equal(res.body.data.windowsSha256, 'd'.repeat(64));
      assert.equal(res.body.data.linuxSha256, null, 'absent checksum is null, not invented');
      assert.equal(res.body.data.downloadCount, 0);
    });

    await t2.test('the feed returns the literal shape the desktop updater parses', async () => {
      const res = await api.get('/api/releases/feed?os=windows');
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.ok, undefined, 'no envelope');
      assert.equal(res.body.version, '0.2.0');
      assert.equal(res.body.sha256, 'd'.repeat(64));
      assert.match(res.body.url, /\/api\/releases\/download\/windows$/);
      assert.match(res.headers.get('cache-control') || '', /max-age=300/);
    });

    await t2.test('a missing checksum is an empty string, never fabricated', async () => {
      const res = await api.get('/api/releases/feed?os=linux');
      assert.equal(res.status, 200);
      assert.equal(res.body.sha256, '');
    });

    await t2.test('an unknown os is rejected', async () => {
      const res = await api.get('/api/releases/feed?os=solaris');
      assert.equal(res.status, 400);
    });

    await t2.test('the download route redirects and counts exactly once', async () => {
      const res = await api.get('/api/releases/download/windows');
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), 'https://cdn.example.test/nexa.exe');
      const rows = await srv.query('SELECT download_count FROM releases');
      assert.equal(Number(rows[0].download_count), 1);

      await api.get('/api/releases/download/linux');
      const after = await srv.query('SELECT download_count FROM releases');
      assert.equal(Number(after[0].download_count), 2);
    });

    await t2.test('public stats now report the real download total', async () => {
      const res = await api.get('/api/stats');
      assert.equal(res.body.data.downloads, 2);
    });
  });

  // ----------------------------------------------------------------- ads ---
  // Ads are the one surface where the plan decides what the SERVER returns, so
  // the entitlement is tested against real rows rather than a stub.
  await t.test('ads: free installs are served, paid licences are not', async (t2) => {
    await srv.reset();
    const api = srv.client();
    const { signLicenseToken } = require('../src/utils/jwt');

    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('admin-password-123', 12);
    await srv.query(
      "INSERT INTO users (name, email, password_hash, role, email_verified) VALUES ('Admin', 'adsadmin@example.test', ?, 'admin', 1)",
      [hash]
    );
    const login = await api.post('/api/admin/login', {
      email: 'adsadmin@example.test', password: 'admin-password-123',
    });
    const adminToken = login.body.data.token;
    const auth = { token: adminToken };

    let adId;
    await t2.test('an admin can create an ad', async () => {
      const res = await api.post('/api/admin/ads', {
        title: 'Go Pro', body: 'Unlimited downloads',
        targetUrl: 'https://nexadownloadmanager.com/pricing', ctaLabel: 'See plans', weight: 5,
      }, auth);
      assert.equal(res.status, 201, res.text);
      adId = res.body.data.id;
      assert.equal(res.body.data.active, 1);
      assert.equal(res.body.data.ctr, 0);
    });

    await t2.test('a non-https link is refused', async () => {
      const res = await api.post('/api/admin/ads', {
        title: 'Bad', targetUrl: 'http://evil.example',
      }, auth);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    await t2.test('a free install (no token) is served the ad', async () => {
      const res = await api.get('/api/ads?placement=app_banner');
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.adFree, false);
      assert.equal(res.body.data.ads.length, 1);
      const ad = res.body.data.ads[0];
      assert.equal(ad.title, 'Go Pro');
      // Counters, schedule and authorship must never reach the client. `token`
      // is the one addition: the proof the client hands back when it reports an
      // impression or a click (utils/ads.js#signAdEventToken).
      assert.deepEqual(Object.keys(ad).sort(),
        ['body', 'ctaLabel', 'id', 'imageUrl', 'placement', 'targetUrl', 'title', 'token', 'weight']);
      assert.ok(ad.token);
    });

    for (const plan of ['pro', 'team']) {
      await t2.test(`a ${plan} licence is served nothing`, async () => {
        const token = signLicenseToken({ sub: 'NDM-AAAA-BBBB-CCCC', plan, device: 'd' });
        const res = await api.get('/api/ads', { headers: { authorization: `Bearer ${token}` } });
        assert.equal(res.status, 200, res.text);
        assert.equal(res.body.data.adFree, true);
        assert.deepEqual(res.body.data.ads, []);
      });
    }

    await t2.test('a free licence token still sees ads', async () => {
      const token = signLicenseToken({ sub: 'NDM-AAAA-BBBB-CCCC', plan: 'free', device: 'd' });
      const res = await api.get('/api/ads', { headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.body.data.adFree, false);
      assert.equal(res.body.data.ads.length, 1);
    });

    await t2.test('a forged token cannot buy ad-free', async () => {
      const jwt = require('jsonwebtoken');
      const forged = jwt.sign({ plan: 'pro', typ: 'license' }, 'not-the-real-secret');
      const res = await api.get('/api/ads', { headers: { authorization: `Bearer ${forged}` } });
      assert.equal(res.body.data.adFree, false);
      assert.equal(res.body.data.ads.length, 1);
    });

    // The event token comes back with the ad; without it nothing is counted, so
    // the counters (and the CTR the panel computes) cannot be run up by
    // anything that was never served the ad.
    const eventToken = async () =>
      (await api.get('/api/ads?placement=app_banner')).body.data.ads[0].token;

    await t2.test('impressions and clicks are counted, once each', async () => {
      const token = await eventToken();
      assert.equal((await api.post(`/api/ads/${adId}/event`, { type: 'impression', token })).body.data.counted, true);
      assert.equal((await api.post(`/api/ads/${adId}/event`, { type: 'click', token })).body.data.counted, true);
      const [row] = await srv.query('SELECT impressions, clicks FROM ads WHERE id = ?', [adId]);
      assert.equal(row.impressions, 1);
      assert.equal(row.clicks, 1);
    });

    await t2.test('an event with no token counts nothing', async () => {
      const res = await api.post(`/api/ads/${adId}/event`, { type: 'impression' });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.counted, false);
      const [row] = await srv.query('SELECT impressions FROM ads WHERE id = ?', [adId]);
      assert.equal(row.impressions, 1, 'unchanged');
    });

    await t2.test('a paid licence reporting an event counts nothing', async () => {
      const eventTok = await eventToken();
      const token = signLicenseToken({ sub: 'NDM-AAAA-BBBB-CCCC', plan: 'pro', device: 'd' });
      const res = await api.post(`/api/ads/${adId}/event`, { type: 'impression', token: eventTok },
        { headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.body.data.counted, false);
      const [row] = await srv.query('SELECT impressions FROM ads WHERE id = ?', [adId]);
      assert.equal(row.impressions, 1, 'unchanged');
    });

    await t2.test('an unknown ad id is not an error', async () => {
      const res = await api.post('/api/ads/999999/event', { type: 'click', token: 'whatever' });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.counted, false);
    });

    await t2.test('renaming an ad leaves its schedule alone', async () => {
      await api.put(`/api/admin/ads/${adId}`, {
        startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2030-01-01T00:00:00.000Z',
      }, auth);
      const res = await api.put(`/api/admin/ads/${adId}`, { title: 'Go Pro today' }, auth);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.title, 'Go Pro today');
      assert.ok(res.body.data.starts_at, 'start survived a partial edit');
      assert.ok(res.body.data.ends_at, 'end survived a partial edit');
    });

    await t2.test('an empty string clears a schedule bound', async () => {
      const res = await api.put(`/api/admin/ads/${adId}`, { startsAt: '', endsAt: '' }, auth);
      assert.equal(res.body.data.starts_at, null);
      assert.equal(res.body.data.ends_at, null);
    });

    await t2.test('a scheduled ad is withheld until its window opens', async () => {
      await api.put(`/api/admin/ads/${adId}`, { startsAt: '2099-01-01T00:00:00.000Z' }, auth);
      assert.deepEqual((await api.get('/api/ads')).body.data.ads, []);
      await api.put(`/api/admin/ads/${adId}`, { startsAt: '' }, auth);
      assert.equal((await api.get('/api/ads')).body.data.ads.length, 1);
    });

    await t2.test('an expired ad stops being served', async () => {
      await api.put(`/api/admin/ads/${adId}`, { endsAt: '2020-01-01T00:00:00.000Z' }, auth);
      assert.deepEqual((await api.get('/api/ads')).body.data.ads, []);
      await api.put(`/api/admin/ads/${adId}`, { endsAt: '' }, auth);
    });

    await t2.test('pausing an ad withdraws it immediately', async () => {
      await api.put(`/api/admin/ads/${adId}`, { active: false }, auth);
      assert.deepEqual((await api.get('/api/ads')).body.data.ads, []);
      // A paused ad also stops counting.
      assert.equal((await api.post(`/api/ads/${adId}/event`, { type: 'click' })).body.data.counted, false);
      await api.put(`/api/admin/ads/${adId}`, { active: true }, auth);
    });

    await t2.test('an ad for another placement is not served here', async () => {
      await api.put(`/api/admin/ads/${adId}`, { placement: 'app_complete' }, auth);
      assert.deepEqual((await api.get('/api/ads?placement=app_banner')).body.data.ads, []);
      assert.equal((await api.get('/api/ads?placement=app_complete')).body.data.ads.length, 1);
      await api.put(`/api/admin/ads/${adId}`, { placement: 'app_banner' }, auth);
    });

    await t2.test('the admin list carries the counters and CTR the app never sees', async () => {
      const res = await api.get('/api/admin/ads', auth);
      assert.equal(res.status, 200, res.text);
      const ad = res.body.data.find((a) => a.id === adId);
      assert.equal(ad.impressions, 1);
      assert.equal(ad.clicks, 1);
      assert.equal(ad.ctr, 100);
      // The counters the client never sees are exactly the ones the panel does.
      assert.equal('token' in ad, false);
      const stats = await api.get('/api/admin/ads/stats', auth);
      assert.equal(stats.body.data.total, 1);
      assert.equal(stats.body.data.active, 1);
    });

    await t2.test('the ads routes need no user session, the admin routes do', async () => {
      assert.equal((await api.get('/api/ads')).status, 200);
      const anon = srv.client();
      assert.equal((await anon.get('/api/admin/ads')).status >= 401, true);
      assert.equal((await anon.post('/api/admin/ads', { title: 'x', targetUrl: 'https://a.example' })).status >= 401, true);
    });

    await t2.test('deleting an ad removes it everywhere', async () => {
      assert.equal((await api.del(`/api/admin/ads/${adId}`, auth)).status, 200);
      assert.equal((await api.del(`/api/admin/ads/${adId}`, auth)).status, 404);
      assert.deepEqual((await api.get('/api/ads')).body.data.ads, []);
    });
  });

  // --------------------------------------------------------------- admin ---
  await t.test('admin session', async (t2) => {
    await srv.reset();
    const api = srv.client();
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('admin-password-123', 12);
    await srv.query(
      "INSERT INTO users (name, email, password_hash, role, email_verified) VALUES ('Admin', 'admin@example.test', ?, 'admin', 1)",
      [hash]
    );

    let adminToken;
    await t2.test('login returns a token and sets the admin refresh cookie', async () => {
      const res = await api.post('/api/admin/login', {
        email: 'admin@example.test', password: 'admin-password-123',
      });
      assert.equal(res.status, 200, res.text);
      adminToken = res.body.data.token;
      assert.ok(adminToken);
      assert.ok(api.cookies.get('ndm_admin_refresh'), 'admin refresh cookie set');
    });

    await t2.test('a user access token cannot reach admin routes', async () => {
      const userApi = srv.client();
      const user = await srv.makeUser(userApi, 'notadmin');
      const res = await api.get('/api/admin/stats', { token: user.token });
      assert.equal(res.status >= 401, true, 'user token rejected by the admin guard');
    });

    await t2.test('refresh returns a new token from the cookie alone', async () => {
      const res = await api.post('/api/admin/refresh');
      assert.equal(res.status, 200, res.text);
      assert.ok(res.body.data.token);
      adminToken = res.body.data.token;
    });

    await t2.test('/me identifies the admin', async () => {
      const res = await api.get('/api/admin/me', { token: adminToken });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.email, 'admin@example.test');
      assert.equal(res.body.data.role, 'admin');
    });

    await t2.test('logout clears the cookie and the stored hash', async () => {
      const res = await api.post('/api/admin/logout', {}, { token: adminToken });
      assert.equal(res.status, 200, res.text);
      const rows = await srv.query(
        'SELECT admin_refresh_token_hash FROM users WHERE email = ?', ['admin@example.test']
      );
      assert.equal(rows[0].admin_refresh_token_hash, null);
      const after = await api.post('/api/admin/refresh');
      assert.equal(after.status, 401, 'the cleared cookie no longer refreshes');
    });
  });

  await srv.stop();
});
