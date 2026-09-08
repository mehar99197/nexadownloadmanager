'use strict';

/**
 * The defences that only mean anything against the real app: the ad counters,
 * the origin gate, and the licence a replaced key leaves behind.
 */
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const srv = require('./helpers/testServer');

const DEVICE = 'c'.repeat(64);

async function seedAd(title = 'Nexa Pro') {
  const id = await srv.query(
    `INSERT INTO ads (title, body, target_url, cta_label, placement, active, weight)
     VALUES (?, '', 'https://nexadownloadmanager.com/pricing', 'Learn more', 'app_banner', 1, 1)`,
    [title]
  );
  const [row] = await srv.query('SELECT id FROM ads WHERE title = ?', [title]);
  void id;
  return row.id;
}

test('hardening', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();
  await srv.reset();
  const api = srv.client();

  await t.test('an ad event only counts with the token the server served it with', async () => {
    const adId = await seedAd('Counted promo');

    const served = await api.get('/api/ads?placement=app_banner');
    assert.equal(served.status, 200);
    const ad = served.body.data.ads.find((a) => a.id === adId);
    assert.ok(ad, 'the ad should be served');
    assert.equal(typeof ad.token, 'string');
    // The shape stays narrow: no counters, schedule or authorship leak out.
    assert.equal('impressions' in ad, false);
    assert.equal('created_by' in ad, false);

    // A forged report — which is all it used to take — counts nothing.
    const forged = await api.post(`/api/ads/${adId}/event`, { type: 'impression', token: 'made-up' });
    assert.equal(forged.status, 200);
    assert.equal(forged.body.data.counted, false);

    // …and so does no token at all, which is what an old client sends.
    const bare = await api.post(`/api/ads/${adId}/event`, { type: 'impression' });
    assert.equal(bare.status, 200);
    assert.equal(bare.body.data.counted, false);

    // A token issued for a DIFFERENT ad cannot be reused on this one.
    const otherId = await seedAd('Other promo');
    const otherAd = (await api.get('/api/ads?placement=app_banner'))
      .body.data.ads.find((a) => a.id === otherId);
    const crossed = await api.post(`/api/ads/${adId}/event`,
      { type: 'impression', token: otherAd.token });
    assert.equal(crossed.body.data.counted, false);

    // The real thing counts.
    const real = await api.post(`/api/ads/${adId}/event`, { type: 'impression', token: ad.token });
    assert.equal(real.body.data.counted, true);
    const click = await api.post(`/api/ads/${adId}/event`, { type: 'click', token: ad.token });
    assert.equal(click.body.data.counted, true);

    const [row] = await srv.query('SELECT impressions, clicks FROM ads WHERE id = ?', [adId]);
    assert.equal(Number(row.impressions), 1);
    assert.equal(Number(row.clicks), 1);
  });

  await t.test('a mutating request from a foreign origin is refused', async () => {
    const evil = await api.post('/api/auth/login',
      { email: 'nobody@example.test', password: 'x' },
      { headers: { origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal(evil.body.error.code, 'BAD_ORIGIN');

    // A configured origin passes (and then fails on credentials, as it should).
    const ours = await api.post('/api/auth/login',
      { email: 'nobody@example.test', password: 'x' },
      { headers: { origin: 'http://localhost:5173' } });
    assert.equal(ours.status, 401);

    // No Origin at all is a non-browser client — the desktop app, Stripe, curl
    // — and cannot be a CSRF vector, so it goes through.
    const app = await api.post('/api/license/validate',
      { license_key: 'NDM-AAAA-BBBB-CCCC', device_fingerprint: DEVICE });
    assert.equal(app.status, 200);
    assert.equal(app.body.valid, false);
    assert.equal(app.body.reason, 'not_found');

    // Reads are never blocked, whatever the origin.
    const read = await api.get('/api/health', { headers: { origin: 'https://evil.example' } });
    assert.equal(read.status, 200);
  });

  await t.test('issuing a licence by hand retires the one it replaces', async () => {
    const user = await srv.makeUser(api, 'reissue');
    const oldKey = (await api.get('/api/user/license', { token: user.token })).body.data.licenseKey;

    // Straight to the model: this is the admin "Issue subscription" path, and
    // the point under test is what happens to the PREVIOUS key.
    const Subscription = require('../src/models/Subscription');
    const [me] = await srv.query('SELECT id FROM users WHERE email = ?', [user.email]);
    const created = await Subscription.create({
      userId: me.id, plan: 'pro', status: 'active',
      licenseKey: 'NDM-ZZZZ-YYYY-XXXX', seats: 1,
      startDate: new Date(), expiryDate: new Date(Date.now() + 30 * 86400000),
    });
    await Subscription.retireOthers(me.id, created.id);

    // The customer used to walk away holding two keys that both validated.
    const stale = await api.post('/api/license/validate',
      { license_key: oldKey, device_fingerprint: DEVICE });
    assert.equal(stale.body.valid, false);
    assert.equal(stale.body.reason, 'expired');

    const fresh = await api.post('/api/license/validate',
      { license_key: 'NDM-ZZZZ-YYYY-XXXX', device_fingerprint: DEVICE });
    assert.equal(fresh.body.valid, true);
    assert.equal(fresh.body.plan, 'pro');
  });

  await t.test('one ad token cannot be replayed into a counter', async () => {
    const adId = await seedAd('Replay promo');
    const ad = (await api.get('/api/ads?placement=app_banner'))
      .body.data.ads.find((a) => a.id === adId);

    // First report of each kind counts, exactly as an honest client's does.
    assert.equal(
      (await api.post(`/api/ads/${adId}/event`, { type: 'impression', token: ad.token }))
        .body.data.counted, true);
    assert.equal(
      (await api.post(`/api/ads/${adId}/event`, { type: 'click', token: ad.token }))
        .body.data.counted, true);

    // A loop on the same token is what used to inflate the CTR the admin panel
    // reports. The budget is a rate, not a one-shot, because the real client
    // reuses one token for a whole 30-minute refresh cycle — so what this
    // proves is that a burst buys nothing, not that reuse is banned.
    for (let i = 0; i < 25; i += 1) {
      const replay = await api.post(`/api/ads/${adId}/event`,
        { type: 'impression', token: ad.token });
      assert.equal(replay.body.data.counted, false);
      assert.equal(replay.body.data.reason, 'rate_limited');
    }
    for (let i = 0; i < 10; i += 1) {
      assert.equal(
        (await api.post(`/api/ads/${adId}/event`, { type: 'click', token: ad.token }))
          .body.data.counted, false);
    }

    const [row] = await srv.query('SELECT impressions, clicks FROM ads WHERE id = ?', [adId]);
    assert.equal(Number(row.impressions), 1, '35 reports must not become 35 impressions');
    assert.equal(Number(row.clicks), 1);
  });

  await t.test('a heartbeat cannot register a machine that never activated', async () => {
    await srv.reset();
    const user = await srv.makeUser(api, 'beat');
    const [me] = await srv.query('SELECT id FROM users WHERE email = ?', [user.email]);
    await srv.query(
      `UPDATE subscriptions SET plan = 'pro', seats = 3, expiry_date = DATE_ADD(NOW(), INTERVAL 30 DAY)
        WHERE user_id = ?`, [me.id]);
    const key = (await api.get('/api/user/license', { token: user.token })).body.data.licenseKey;

    const known = 'a'.repeat(64);
    const unknown = 'b'.repeat(64);

    // The honest path: activate, then beat.
    const activated = await api.post('/api/license/validate',
      { license_key: key, device_fingerprint: known });
    assert.equal(activated.body.valid, true);
    const renewed = await api.post('/api/license/heartbeat',
      { license_key: key, device_fingerprint: known });
    assert.equal(renewed.body.valid, true);

    // The bypass: beat with a machine that never called /validate. There are
    // two free seats, so this is refused on principle, not on capacity.
    const skipped = await api.post('/api/license/heartbeat',
      { license_key: key, device_fingerprint: unknown });
    assert.equal(skipped.body.valid, false);
    assert.equal(skipped.body.reason, 'seat_limit');
    assert.equal(skipped.body.token, undefined, 'no licence token may be minted here');

    // Nothing was written for it either: /validate is where the key-sharing
    // assessment runs, and it can only run on rows /validate created.
    const rows = await srv.query(
      'SELECT device_fingerprint FROM license_activations WHERE device_fingerprint = ?', [unknown]);
    assert.equal(rows.length, 0);
  });

  await t.test('rotating a licence key cuts every machine holding the old one loose', async () => {
    await srv.reset();
    const user = await srv.makeUser(api, 'rotate');
    const [me] = await srv.query('SELECT id FROM users WHERE email = ?', [user.email]);
    await srv.query(
      `UPDATE subscriptions SET plan = 'team', seats = 5, expiry_date = DATE_ADD(NOW(), INTERVAL 30 DAY)
        WHERE user_id = ?`, [me.id]);
    const oldKey = (await api.get('/api/user/license', { token: user.token })).body.data.licenseKey;

    // A machine that has the old key — the ex-team-member's laptop.
    const theirs = 'd'.repeat(64);
    assert.equal((await api.post('/api/license/validate',
      { license_key: oldKey, device_fingerprint: theirs })).body.valid, true);

    const rotated = await api.post('/api/user/license/rotate', {}, { token: user.token });
    assert.equal(rotated.status, 200, rotated.text);
    const newKey = rotated.body.data.licenseKey;
    assert.notEqual(newKey, oldKey);
    assert.match(newKey, /^NDM(-[A-Z0-9]{4}){3}$/);

    // The copy they already had is worthless — this is the whole point, since
    // removing them from the roster never touched it.
    const stale = await api.post('/api/license/validate',
      { license_key: oldKey, device_fingerprint: theirs });
    assert.equal(stale.body.valid, false);
    assert.equal(stale.body.reason, 'not_found');

    // And their running app cannot simply beat on: the seat was revoked.
    const beat = await api.post('/api/license/heartbeat',
      { license_key: newKey, device_fingerprint: theirs });
    assert.equal(beat.body.valid, false);
    assert.equal(beat.body.reason, 'seat_revoked');

    // The owner just re-activates.
    assert.equal((await api.post('/api/license/validate',
      { license_key: newKey, device_fingerprint: 'e'.repeat(64) })).body.valid, true);

    // The device history survives: it is what the sharing check reads, so
    // rotating must not launder a leaked key's record.
    const [{ n }] = await srv.query(
      'SELECT COUNT(*) AS n FROM license_activations WHERE device_fingerprint = ?', [theirs]);
    assert.equal(Number(n), 1);
  });

  await t.test('a stopped subscription cannot be revived by starting a trial', async () => {
    await srv.reset();
    const user = await srv.makeUser(api, 'stopped');
    const [me] = await srv.query('SELECT id FROM users WHERE email = ?', [user.email]);
    // An admin deliberately stops the licence. `cancelled` and `expired` are
    // only ever set by a person — a plan that merely runs out is downgraded to
    // free/active instead.
    await srv.query("UPDATE subscriptions SET status = 'cancelled' WHERE user_id = ?", [me.id]);

    const trial = await api.post('/api/subscription/start-trial', {}, { token: user.token });
    assert.equal(trial.status, 403, trial.text);
    assert.equal(trial.body.error.code, 'SUBSCRIPTION_STOPPED');

    const [row] = await srv.query('SELECT plan, status FROM subscriptions WHERE user_id = ?', [me.id]);
    assert.equal(row.status, 'cancelled');
    assert.notEqual(row.plan, 'pro');
  });

  await t.test('the contact form does not label a message with an account nobody proved', async () => {
    await srv.reset();
    const victim = await srv.makeUser(api, 'victim');

    // Anonymous, using somebody else's address: no account link.
    const anon = srv.client();
    const spoofed = await anon.post('/api/contact', {
      name: 'Not Them', email: victim.email, topic: 'billing',
      message: 'Please refund my subscription and reset my password.',
    });
    assert.equal(spoofed.status, 200, spoofed.text);
    const [spoofRow] = await srv.query(
      'SELECT user_id FROM contact_messages ORDER BY id DESC LIMIT 1');
    assert.equal(spoofRow.user_id, null, 'an unauthenticated sender is anonymous');

    // The real owner, signed in: linked.
    const real = await api.post('/api/contact', {
      name: 'Them', email: victim.email, topic: 'billing', message: 'My own question.',
    }, { token: victim.token });
    assert.equal(real.status, 200, real.text);
    const [realRow] = await srv.query(
      'SELECT user_id FROM contact_messages ORDER BY id DESC LIMIT 1');
    const [them] = await srv.query('SELECT id FROM users WHERE email = ?', [victim.email]);
    assert.equal(Number(realRow.user_id), Number(them.id));
  });

  await t.test('a staff admin cannot read the creator\u2019s second factor', async () => {
    await srv.reset();
    const bcrypt = require('bcryptjs');
    const totp = require('../src/utils/totp');

    // The creator, with 2FA on — so the row genuinely holds a TOTP seed and
    // recovery hashes, which is the material this is about.
    const secret = totp.generateSecret();
    const { hashes } = totp.generateRecoveryCodes();
    await srv.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified,
                          totp_secret, totp_enabled, totp_recovery, root_refresh_token_hash)
       VALUES ('Owner', 'owner@example.test', ?, 'root', 1, ?, 1, ?, 'deadbeef')`,
      [await bcrypt.hash('owner-password-123', 12), totp.encryptSecret(secret), JSON.stringify(hashes)]
    );
    const [owner] = await srv.query('SELECT id FROM users WHERE email = ?', ['owner@example.test']);

    await srv.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified)
       VALUES ('Staff', 'staff@example.test', ?, 'admin', 1)`,
      [await bcrypt.hash('staff-password-123', 12)]
    );
    const staff = srv.client();
    const login = await staff.post('/api/admin/login',
      { email: 'staff@example.test', password: 'staff-password-123' });
    assert.equal(login.status, 200, login.text);
    const token = login.body.data.token;

    // /users/:id/details reads the row with SELECT *, so whatever the response
    // filter forgets is handed straight to a staff admin. It used to forget the
    // TOTP seed, the recovery hashes and the root refresh hash — a path from
    // staff to creator, since the recovery codes are plain SHA-256 of a
    // ten-character alphanumeric and crack offline.
    const details = await staff.get(`/api/admin/users/${owner.id}/details`, { token });
    assert.equal(details.status, 200, details.text);
    const body = JSON.stringify(details.body);
    for (const leak of ['totp_secret', 'totp_recovery', 'root_refresh_token_hash',
      'refresh_token_hash', 'password_hash', 'token_version']) {
      assert.equal(body.includes(leak), false, `${leak} must not leave the server`);
    }
    assert.equal(body.includes(secret), false, 'the raw TOTP seed must not appear either');
    // The fields the panel actually renders still arrive.
    assert.equal(details.body.data.user.email, 'owner@example.test');
    assert.equal(details.body.data.user.role, 'root');

    // The listing is the same rule.
    const list = await staff.get('/api/admin/users', { token });
    assert.equal(list.status, 200);
    for (const leak of ['totp_secret', 'password_hash', 'token_version'])
      assert.equal(JSON.stringify(list.body).includes(leak), false, leak);
  });

  await t.test('an unpaid checkout session grants nothing until the money lands', async () => {
    await srv.reset();
    const user = await srv.makeUser(api, 'delayed');
    const [me] = await srv.query('SELECT id FROM users WHERE email = ?', [user.email]);
    const post = (event) => api.post('/api/webhooks/stripe', event,
      { headers: { 'stripe-signature': 'mock' } });

    // A delayed payment method (ACH, SEPA, some bank redirects) completes the
    // session while the debit is still in flight. Granting on completion alone
    // handed out Pro for money that might never arrive.
    const session = {
      id: 'cs_delayed_1',
      customer_email: user.email,
      payment_status: 'unpaid',
      amount_total: 500,
      metadata: { plan: 'pro', billingCycle: 'monthly', userId: String(me.id) },
    };
    const pending = await post({ id: 'evt_delayed_1', type: 'checkout.session.completed',
      data: { object: session } });
    assert.equal(pending.status, 200, pending.text);
    const [before] = await srv.query('SELECT plan FROM subscriptions WHERE user_id = ?', [me.id]);
    assert.equal(before.plan, 'free', 'an unpaid session must not buy a plan');

    // …and grants it exactly once, when Stripe says the debit cleared.
    const settled = await post({
      id: 'evt_delayed_2',
      type: 'checkout.session.async_payment_succeeded',
      data: { object: { ...session, id: 'cs_delayed_1', payment_status: 'paid' } },
    });
    assert.equal(settled.status, 200, settled.text);
    const [after] = await srv.query('SELECT plan, status FROM subscriptions WHERE user_id = ?', [me.id]);
    assert.equal(after.plan, 'pro');
    assert.equal(after.status, 'active');
  });

  await t.test('a two-factor code cannot be used twice', async () => {
    await srv.reset();
    const bcrypt = require('bcryptjs');
    const totp = require('../src/utils/totp');
    const secret = totp.generateSecret();
    const { hashes } = totp.generateRecoveryCodes();
    await srv.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified,
                          totp_secret, totp_enabled, totp_recovery)
       VALUES ('Staff', 'twofa@example.test', ?, 'admin', 1, ?, 1, ?)`,
      [await bcrypt.hash('staff-password-123', 12), totp.encryptSecret(secret), JSON.stringify(hashes)]
    );

    const first = srv.client();
    const challenge = (await first.post('/api/admin/login',
      { email: 'twofa@example.test', password: 'staff-password-123' })).body.data.challenge;
    assert.ok(challenge, 'password step should hand back a 2FA challenge');

    const code = totp.totpAt(secret);
    const ok1 = await first.post('/api/admin/login/2fa', { challenge, code });
    assert.equal(ok1.status, 200, ok1.text);

    // The same six digits stay valid for their whole step and one either side —
    // up to 90 seconds. That is the window a real-time phishing proxy or anyone
    // reading the code over a shoulder operates in, so the step is spent.
    const second = srv.client();
    const challenge2 = (await second.post('/api/admin/login',
      { email: 'twofa@example.test', password: 'staff-password-123' })).body.data.challenge;
    const replay = await second.post('/api/admin/login/2fa', { challenge: challenge2, code });
    assert.equal(replay.status, 401, replay.text);
    assert.equal(replay.body.error.code, 'CODE_ALREADY_USED');

    // The NEXT step still works, so this is replay protection and not a lockout.
    const next = totp.totpAt(secret, Date.now() + 30_000);
    if (next !== code) {
      const ok2 = await second.post('/api/admin/login/2fa', { challenge: challenge2, code: next });
      assert.equal(ok2.status, 200, ok2.text);
    }
  });

  await t.test('an over-long audit summary is trimmed, never a 500 after the fact', async () => {
    await srv.reset();
    const AuditLog = require('../src/models/AuditLog');
    // audit_logs.summary is VARCHAR(255) and MySQL runs in STRICT mode, so a
    // long filename or email address used to reject the INSERT — AFTER the
    // admin action it was recording had already happened. A slightly short
    // audit line beats a missing one and a 500 on a completed action.
    const id = await AuditLog.create({
      adminUserId: null,
      action: 'x'.repeat(200),
      entityType: 'y'.repeat(120),
      entityId: null,
      summary: `deleted ${'z'.repeat(500)}`,
    });
    assert.ok(id);
    const [row] = await srv.query('SELECT action, entity_type, summary FROM audit_logs WHERE id = ?', [id]);
    assert.equal(row.summary.length, 255);
    assert.equal(row.action.length, 80);
    assert.equal(row.entity_type.length, 50);
    assert.match(row.summary, /^deleted z+\u2026$/);
  });

  await t.test('sign-in never reveals whether an address is registered', async () => {
    await srv.reset();
    const known = await srv.makeUser(api, 'oracle');

    // A Google-created account: real row, no password hash.
    await srv.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified, google_id)
       VALUES ('Googler', 'googler@example.test', NULL, 'user', 1, 'g-123')`);

    const attempt = (email) => api.post('/api/auth/login', { email, password: 'whatever-1234' });

    // Sequential, not Promise.all: bcryptjs is pure JS, so three concurrent
    // cost-12 compares monopolise the event loop and make this suite's timings
    // meaningless.
    const nobody = await attempt('nobody-at-all@example.test');
    const googler = await attempt('googler@example.test');
    const wrongPw = await attempt(known.email);

    // All three must be the same answer. The middle one used to be a 409
    // PASSWORD_NOT_SET — a definitive "yes, this address has an account" for
    // anybody who typed one.
    for (const res of [nobody, googler, wrongPw]) {
      assert.equal(res.status, 401, res.text);
      assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
      assert.equal(res.body.error.message, 'Invalid email or password');
    }
    assert.equal(JSON.stringify(googler.body), JSON.stringify(nobody.body));

    // The real password still works, so this is silence and not a lockout.
    const good = await api.post('/api/auth/login',
      { email: known.email, password: known.password });
    assert.equal(good.status, 200, good.text);
  });

  await t.test('deleting a user erases their data but not the audit trail', async () => {
    await srv.reset();
    const bcrypt = require('bcryptjs');
    await srv.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified)
       VALUES ('Staff', 'deleter@example.test', ?, 'admin', 1)`,
      [await bcrypt.hash('staff-password-123', 12)]
    );
    const staff = srv.client();
    const token = (await staff.post('/api/admin/login',
      { email: 'deleter@example.test', password: 'staff-password-123' })).body.data.token;

    const victim = await srv.makeUser(api, 'doomed');
    const [me] = await srv.query('SELECT id FROM users WHERE email = ?', [victim.email]);
    // Give them the full spread of owned rows, so the cascade is actually tested.
    await srv.query(
      `UPDATE subscriptions SET plan = 'pro', expiry_date = DATE_ADD(NOW(), INTERVAL 30 DAY)
        WHERE user_id = ?`, [me.id]);
    const key = (await api.get('/api/user/license', { token: victim.token })).body.data.licenseKey;
    await api.post('/api/license/validate',
      { license_key: key, device_fingerprint: 'f'.repeat(64) });
    await srv.query(
      `INSERT INTO payments (user_id, amount, currency, plan, billing_cycle, stripe_payment_id, status)
       VALUES (?, 5, 'usd', 'pro', 'monthly', 'pi_doomed', 'paid')`, [me.id]);

    // The confirmation must match the account exactly.
    const wrong = await staff.del(`/api/admin/users/${me.id}`, {
      token, body: { confirmEmail: 'someone-else@example.test' },
    });
    assert.equal(wrong.status, 400, wrong.text);
    assert.equal(wrong.body.error.code, 'CONFIRM_MISMATCH');
    assert.equal(
      (await srv.query('SELECT id FROM users WHERE id = ?', [me.id])).length, 1,
      'a mismatched confirmation must not delete anything');

    const gone = await staff.del(`/api/admin/users/${me.id}`, {
      token, body: { confirmEmail: victim.email },
    });
    assert.equal(gone.status, 200, gone.text);

    // Everything the account owned goes with it, through the schema's cascade.
    for (const [table, column] of [['users', 'id'], ['subscriptions', 'user_id'], ['payments', 'user_id']]) {
      const rows = await srv.query(`SELECT 1 FROM ${table} WHERE ${column} = ?`, [me.id]);
      assert.equal(rows.length, 0, `${table} should be empty for the deleted user`);
    }
    const seats = await srv.query(
      'SELECT 1 FROM license_activations WHERE device_fingerprint = ?', ['f'.repeat(64)]);
    assert.equal(seats.length, 0, 'licence activations cascade through the subscription');
    // …and the key stops working, rather than lingering as a valid licence.
    const dead = await api.post('/api/license/validate',
      { license_key: key, device_fingerprint: 'f'.repeat(64) });
    assert.equal(dead.body.valid, false);

    // The record of WHO did it survives: audit_logs.admin_user_id is
    // ON DELETE SET NULL, so the row is written before the delete.
    const [entry] = await srv.query(
      "SELECT summary FROM audit_logs WHERE action = 'user.deleted' ORDER BY id DESC LIMIT 1");
    assert.ok(entry, 'the deletion must be audited');
    assert.match(entry.summary, new RegExp(victim.email.replace(/[.+]/g, '\\$&')));
  });

  await t.test('a staff admin cannot delete a colleague or the creator', async () => {
    await srv.reset();
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('staff-password-123', 12);
    await srv.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified)
       VALUES ('Staff One', 'one@example.test', ?, 'admin', 1),
              ('Staff Two', 'two@example.test', ?, 'admin', 1),
              ('Owner', 'creator@example.test', ?, 'root', 1)`,
      [hash, hash, hash]
    );
    const staff = srv.client();
    const token = (await staff.post('/api/admin/login',
      { email: 'one@example.test', password: 'staff-password-123' })).body.data.token;

    for (const email of ['two@example.test', 'creator@example.test']) {
      const [target] = await srv.query('SELECT id FROM users WHERE email = ?', [email]);
      const res = await staff.del(`/api/admin/users/${target.id}`, { token, body: { confirmEmail: email } });
      assert.equal(res.status, 403, `${email}: ${res.text}`);
      assert.equal(
        (await srv.query('SELECT id FROM users WHERE email = ?', [email])).length, 1,
        `${email} must still exist`);
    }

    // Not even themselves — that would leave the panel with one fewer way in
    // and no way to undo it.
    const [self] = await srv.query('SELECT id FROM users WHERE email = ?', ['one@example.test']);
    const suicide = await staff.del(`/api/admin/users/${self.id}`,
      { token, body: { confirmEmail: 'one@example.test' } });
    assert.equal(suicide.status, 400, suicide.text);
    assert.equal(suicide.body.error.code, 'SELF_LOCKOUT');
  });

  await t.test('the creator address is reserved and never becomes a customer', async () => {
    await srv.reset();
    const config = require('../src/config/env');
    const reserved = config.ROOT_ADMIN_EMAIL;
    assert.ok(reserved, 'the test harness must configure ROOT_ADMIN_EMAIL');

    // The gap this closes is the one where the creator's row is NOT there —
    // deleted, or restored from a dump that predates it. The unique index does
    // the work while the row exists; nothing did once it was gone.
    assert.equal(
      (await srv.query('SELECT id FROM users WHERE email = ?', [reserved])).length, 0,
      'no creator row for this case');

    const fresh = srv.client();
    const reg = await fresh.post('/api/auth/register',
      { name: 'Impostor', email: reserved, password: 'a-strong-password' });

    // Refused — but answered exactly like an ordinary sign-up, because a
    // distinct error would point a stranger at the administrator's address.
    assert.equal(reg.status, 201, reg.text);
    assert.deepEqual(reg.body, { ok: true, data: {} });
    assert.equal(
      (await srv.query('SELECT id FROM users WHERE email = ?', [reserved])).length, 0,
      'the reserved address must not become an account');
    assert.equal((await srv.query('SELECT id FROM subscriptions')).length, 0);

    // Indistinguishable from a genuine registration, field for field.
    const control = await fresh.post('/api/auth/register',
      { name: 'Normal', email: 'ordinary@example.test', password: 'a-strong-password' });
    assert.deepEqual(reg.body, control.body);
    assert.equal(reg.status, control.status);

    // With the creator's row actually present — the normal state — the answer
    // is still the same, and still creates nothing.
    await srv.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified)
       VALUES ('Owner', ?, '$2a$12$notarealhashnotarealhashnotarealhashnotarealha', 'root', 1)`,
      [reserved]);
    const again = await fresh.post('/api/auth/register',
      { name: 'Impostor', email: reserved, password: 'a-strong-password' });
    assert.equal(again.status, 201, again.text);
    assert.deepEqual(again.body, control.body);
    assert.equal(
      (await srv.query('SELECT id FROM users WHERE email = ?', [reserved])).length, 1,
      'still exactly one row: the creator\u2019s');
    await srv.query('DELETE FROM users WHERE email = ?', [reserved]);

    // The admin panel cannot hand it out either — there the caller is already
    // authenticated, so it says why.
    const bcrypt = require('bcryptjs');
    await srv.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified)
       VALUES ('Staff', 'reserver@example.test', ?, 'admin', 1)`,
      [await bcrypt.hash('staff-password-123', 12)]
    );
    const staff = srv.client();
    const token = (await staff.post('/api/admin/login',
      { email: 'reserver@example.test', password: 'staff-password-123' })).body.data.token;
    const made = await staff.post('/api/admin/users',
      { name: 'Impostor', email: reserved, password: 'a-strong-password', plan: 'free' }, { token });
    assert.equal(made.status, 400, made.text);
    assert.equal(made.body.error.code, 'RESERVED_ADDRESS');
    assert.equal((await srv.query('SELECT id FROM users WHERE email = ?', [reserved])).length, 0);
  });

  await t.test('the customer site is not a recovery channel for a panel account', async () => {
    await srv.reset();
    const bcrypt = require('bcryptjs');
    const original = await bcrypt.hash('the-real-admin-password', 12);
    await srv.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified)
       VALUES ('Staff', 'panel@example.test', ?, 'admin', 1)`, [original]);
    const [admin] = await srv.query('SELECT id FROM users WHERE email = ?', ['panel@example.test']);

    // /admin/login and /root/login check the SAME hash this flow would rewrite,
    // so a mailbox would otherwise be worth the panel password.
    const asked = await api.post('/api/auth/forgot-password', { email: 'panel@example.test' });
    assert.equal(asked.status, 200, asked.text);
    // Constant answer, so the refusal itself does not mark the address out.
    const decoy = await api.post('/api/auth/forgot-password', { email: 'nobody@example.test' });
    assert.deepEqual(asked.body, decoy.body);

    // And a link minted before the rule existed still cannot be redeemed.
    const { signResetToken } = require('../src/utils/jwt');
    const stolen = signResetToken(await require('../src/models/User').findById(admin.id));
    const used = await api.post('/api/auth/reset-password',
      { token: stolen, password: 'attacker-chosen-password' });
    assert.equal(used.status, 400, used.text);
    assert.equal(used.body.error.code, 'INVALID_TOKEN');

    const [after] = await srv.query('SELECT password_hash FROM users WHERE id = ?', [admin.id]);
    assert.equal(after.password_hash, original, 'the panel password must be untouched');
    assert.equal(await bcrypt.compare('the-real-admin-password', after.password_hash), true);

    // An ordinary customer's reset still works — this is a fence, not a wall.
    const normal = await srv.makeUser(api, 'resettable');
    const ok1 = await api.post('/api/auth/forgot-password', { email: normal.email });
    assert.equal(ok1.status, 200);
    const [row] = await srv.query('SELECT id FROM users WHERE email = ?', [normal.email]);
    const good = signResetToken(await require('../src/models/User').findById(row.id));
    const done = await api.post('/api/auth/reset-password', { token: good, password: 'a-new-password-99' });
    assert.equal(done.status, 200, done.text);
  });

  await t.test('a control-panel account has no customer session', async () => {
    await srv.reset();
    const bcrypt = require('bcryptjs');
    const CREATOR_PW = 'the-creator-password-99';
    const STAFF_PW = 'the-staff-password-99';
    await srv.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified)
       VALUES ('Owner', 'creator@example.test', ?, 'root', 1),
              ('Staff', 'panel@example.test', ?, 'admin', 1)`,
      [await bcrypt.hash(CREATOR_PW, 12), await bcrypt.hash(STAFF_PW, 12)]
    );
    const [creator] = await srv.query(
      'SELECT id, password_hash FROM users WHERE email = ?', ['creator@example.test']);

    // The hole this closes: one users table, one password_hash, and the
    // customer sign-in form never checked the role — so the credentials meant
    // for an IP-allowlisted, second-factor panel opened an ordinary session
    // from anywhere.
    const shop = srv.client();
    for (const [email, password] of [
      ['creator@example.test', CREATOR_PW],
      ['panel@example.test', STAFF_PW],
    ]) {
      const res = await shop.post('/api/auth/login', { email, password });
      assert.equal(res.status, 401, `${email}: ${res.text}`);
      assert.equal(res.body.data, undefined, 'no session may be handed out');
      assert.equal(shop.cookies.has('ndm_refresh'), false, 'no refresh cookie either');
    }

    // …and it says NOTHING about why. This is the part that matters as much as
    // the refusal: a named error would answer "wrong password" for thousands of
    // ordinary addresses and "this one is the administrator" for exactly one,
    // so anybody credential-stuffing a leaked password would be handed the one
    // address on the site worth attacking. Four answers, one shape.
    const answers = [];
    for (const [label, address, secret] of [
      ['creator, correct password', 'creator@example.test', CREATOR_PW],
      ['staff, correct password', 'panel@example.test', STAFF_PW],
      ['creator, wrong password', 'creator@example.test', 'not-the-password'],
      ['no such account', 'nobody@example.test', 'not-the-password'],
    ]) {
      const res = await shop.post('/api/auth/login', { email: address, password: secret });
      answers.push([label, res]);
    }
    const [, baseline] = answers[answers.length - 1];
    for (const [label, res] of answers) {
      assert.equal(res.status, baseline.status, `${label}: ${res.text}`);
      assert.deepEqual(res.body, baseline.body, `${label}: every refusal must be identical`);
      assert.doesNotMatch(res.text, /control-panel|admin|creator|root|staff/i, label);
    }
    assert.equal(baseline.body.error.code, 'INVALID_CREDENTIALS');

    // The explanation the owner needs is not withheld, only moved: it goes to
    // the mailbox that owns the account, where nobody else can read it.
    const email = require('../src/utils/email');
    assert.equal(typeof email.sendControlPanelSignInAttemptEmail, 'function',
      'the owner has to be told somewhere, or the refusal is just a mystery');

    // A token minted before this rule existed — the same thing as a token held
    // by an account that has just been promoted — dies at the boundary rather
    // than at the end of its seven-day life.
    const User = require('../src/models/User');
    const { signAccessToken, generateRefreshToken } = require('../src/utils/jwt');
    const stale = signAccessToken(await User.findById(creator.id));
    for (const [method, path] of [['get', '/api/user/me'], ['get', '/api/user/license']]) {
      const res = await shop[method](path, { token: stale });
      assert.equal(res.status, 401, `${path}: ${res.text}`);
      // An ended session, never "this is a control-panel account": the customer
      // site is what renders this string.
      assert.equal(res.body.error.code, 'SESSION_REVOKED');
      assert.doesNotMatch(res.text, /control-panel|admin|creator|root/i);
    }

    // …and in particular it cannot rewrite the hash the panel signs in with,
    // which is what made this more than a cosmetic separation: PUT
    // /user/profile changed password_hash, so the customer site was a way to
    // SET the creator's panel password from an address the panel would never
    // have accepted a request from.
    const rewrite = await shop.put('/api/user/profile',
      { currentPassword: CREATOR_PW, newPassword: 'attacker-chosen-pw-1' }, { token: stale });
    assert.equal(rewrite.status, 401, rewrite.text);
    const [after] = await srv.query('SELECT password_hash FROM users WHERE id = ?', [creator.id]);
    assert.equal(after.password_hash, creator.password_hash, 'the panel password must be untouched');

    // A refresh cookie is refused AND cleared, so the session that should never
    // have existed is gone rather than retried on every page load.
    const { token: rt, hash } = generateRefreshToken();
    await User.update(creator.id, { refreshTokenHash: hash });
    const stapled = srv.client();
    stapled.cookies.set('ndm_refresh', rt);
    const refreshed = await stapled.post('/api/auth/refresh', {});
    assert.equal(refreshed.status, 401, refreshed.text);
    // Indistinguishable from a cookie that simply no longer exists — which is
    // also exactly what the browser should do with it.
    const unknownCookie = srv.client();
    unknownCookie.cookies.set('ndm_refresh', 'a-cookie-nobody-ever-issued');
    const stranger = await unknownCookie.post('/api/auth/refresh', {});
    assert.deepEqual(refreshed.body, stranger.body);
    const [cleared] = await srv.query(
      'SELECT refresh_token_hash FROM users WHERE id = ?', [creator.id]);
    assert.equal(cleared.refresh_token_hash, null, 'the stale hash must be dropped');

    // This is a fence between two doors, not a lock on both: the panel's own
    // sign-in still works with the same password.
    const panel = srv.client();
    const rootLogin = await panel.post('/api/root/login',
      { email: 'creator@example.test', password: CREATOR_PW });
    assert.equal(rootLogin.status, 200, rootLogin.text);
    assert.ok(rootLogin.body.data.token, 'the creator still signs in at /root');
    const staffLogin = await srv.client().post('/api/admin/login',
      { email: 'panel@example.test', password: STAFF_PW });
    assert.equal(staffLogin.status, 200, staffLogin.text);

    // And an ordinary customer is entirely unaffected.
    const customer = srv.client();
    const me = await srv.makeUser(customer, 'unaffected');
    assert.ok(me.token, 'a customer still signs in');
    assert.equal((await customer.get('/api/user/me', { token: me.token })).status, 200);
    assert.equal((await customer.post('/api/auth/refresh', {})).status, 200);
  });

  await t.test('promoting a customer to staff ends the session they are holding', async () => {
    await srv.reset();
    const bcrypt = require('bcryptjs');
    const CREATOR_PW = 'the-creator-password-99';
    await srv.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified)
       VALUES ('Owner', 'creator@example.test', ?, 'root', 1)`,
      [await bcrypt.hash(CREATOR_PW, 12)]
    );

    const customer = srv.client();
    const victim = await srv.makeUser(customer, 'promoted');
    assert.equal((await customer.get('/api/user/me', { token: victim.token })).status, 200);
    const [row] = await srv.query('SELECT id FROM users WHERE email = ?', [victim.email]);

    const panel = srv.client();
    const rootToken = (await panel.post('/api/root/login',
      { email: 'creator@example.test', password: CREATOR_PW })).body.data.token;
    const promoted = await panel.put(`/api/root/admins/${row.id}`,
      { role: 'admin' }, { token: rootToken });
    assert.equal(promoted.status, 200, promoted.text);

    // Both halves: the bearer token stops at the boundary, and the refresh
    // cookie has nothing left to spend — a role change now revokes, where only
    // a demotion used to.
    const held = await customer.get('/api/user/me', { token: victim.token });
    assert.equal(held.status, 401, held.text);
    assert.equal(held.body.error.code, 'SESSION_REVOKED');
    const spent = await customer.post('/api/auth/refresh', {});
    assert.equal(spent.status, 401, spent.text);
    assert.equal(spent.body.error.code, 'INVALID_REFRESH_TOKEN');

    // Signing in again is refused too — there is no route back to a customer
    // session for this address while it is staff — and the refusal still looks
    // like nothing more than a bad password.
    const again = await customer.post('/api/auth/login',
      { email: victim.email, password: victim.password });
    assert.equal(again.status, 401, again.text);
    assert.equal(again.body.error.code, 'INVALID_CREDENTIALS');
  });

  await srv.stop();
});
