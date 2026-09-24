'use strict';

/**
 * T-08 — the thirteen routes no test named.
 *
 * Extracting every `router.<verb>(...)` from `src/routes/` and matching the
 * paths against everything under `test/` gave 132 routes, 119 of which some
 * test at least mentions. These are the other thirteen. Reading them by hand
 * found all thirteen correctly guarded, so this suite is not closing a hole —
 * it is making the guards fail loudly when someone moves them.
 *
 * The two exports are the reason this file exists at all. `/users/export` and
 * `/subscriptions/export` are bulk reads of the users table: exactly the shape
 * of H-01, the worst finding in this audit.
 *
 * They turn out to be defended twice — `User.listAll` selects an explicit
 * column list, and the route maps `safeUser` over the result — which is better
 * than the first reading of this code suggested. The assertions below were
 * checked against that rather than trusted: with `safeUser` removed the tests
 * still pass, because the narrow SELECT alone is enough; with the SELECT
 * widened to `SELECT *` as well, they fail on `password_hash`. That is the
 * behaviour wanted from a regression guard — it fires on the outcome, not on
 * the presence of a particular line — and it is why these assertions read the
 * HTTP body for the columns instead of asserting that a helper was called.
 */

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const srv = require('./helpers/testServer');
const config = require('../src/config/env');

const PASSWORD = 'untested-routes-password';

// Columns that must never leave the server, whatever the route. Kept as a list
// rather than a spot-check of `password_hash` so a column added to the table
// later is caught by the same assertion.
const SECRET_KEYS = [
  'password_hash', 'totp_secret', 'totp_recovery', 'totp_last_step',
  'token_version', 'reset_token_hash', 'refresh_token_hash',
  'root_refresh_token_hash', 'verification_token_hash',
];

async function seedStaff(email) {
  await srv.query(
    `INSERT INTO users (name, email, password_hash, role, email_verified)
     VALUES ('Staff', ?, ?, 'admin', 1)`,
    [email, await bcrypt.hash(PASSWORD, 4)]
  );
  const [row] = await srv.query('SELECT id FROM users WHERE email = ?', [email]);
  return row.id;
}

async function signInStaff(api, email) {
  const res = await api.post('/api/admin/login', { email, password: PASSWORD });
  assert.equal(res.status, 200, res.text);
  return res.body.data.token;
}

/** Every string in a response body, however deeply nested. */
function keysOf(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const v of value) keysOf(v, found);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      found.add(k);
      keysOf(v, found);
    }
  }
  return found;
}

test('the routes no test named', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();

  // ---- the two bulk exports ------------------------------------------------

  await t.test('the user export is gated, and projects through the allow-list', async () => {
    await srv.reset();
    const api = srv.client();

    // The gate first: this is a dump of the users table.
    assert.equal((await api.get('/api/admin/users/export')).status, 401);

    const email = 'export-staff@example.test';
    await seedStaff(email);
    const token = await signInStaff(api, email);

    // Somebody with real secrets in their row, so the assertion has something
    // to find if the projection is ever dropped.
    await srv.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified, totp_secret, totp_enabled)
       VALUES ('Customer', 'export-customer@example.test', ?, 'user', 1, 'ENCRYPTEDSECRETVALUE', 1)`,
      [await bcrypt.hash('a-customer-password', 4)]
    );

    const res = await api.get('/api/admin/users/export', { token });
    assert.equal(res.status, 200, res.text);
    const rows = res.body.data;
    assert.ok(Array.isArray(rows) && rows.length >= 2, 'both accounts export');

    const keys = keysOf(rows);
    for (const secret of SECRET_KEYS) {
      assert.equal(keys.has(secret), false, `${secret} must not be exported`);
    }
    // And not by value either, in case a column is ever renamed on the way out.
    assert.equal(res.text.includes('ENCRYPTEDSECRETVALUE'), false, 'no TOTP secret in the body');
    assert.equal(/\$2[aby]\$\d\d\$/.test(res.text), false, 'no bcrypt hash in the body');

    // The export is still useful — a projection that returned nothing would
    // also pass every assertion above.
    assert.ok(rows.some((r) => r.email === 'export-customer@example.test'), 'the customer is in it');
  });

  await t.test('the subscription export is gated and carries no user secrets', async () => {
    await srv.reset();
    const api = srv.client();
    assert.equal((await api.get('/api/admin/subscriptions/export')).status, 401);

    const email = 'subexport-staff@example.test';
    await seedStaff(email);
    const token = await signInStaff(api, email);

    const res = await api.get('/api/admin/subscriptions/export', { token });
    assert.equal(res.status, 200, res.text);
    const keys = keysOf(res.body.data);
    for (const secret of SECRET_KEYS) {
      assert.equal(keys.has(secret), false, `${secret} must not be exported`);
    }
  });

  // ---- the rest of the admin surface --------------------------------------

  await t.test('every other unnamed admin route refuses an anonymous caller', async () => {
    await srv.reset();
    const api = srv.client();
    const paths = [
      '/api/admin/activity',
      '/api/admin/security/token-rejections',
      '/api/admin/faq/votes',
      '/api/admin/contact/stats',
    ];
    for (const path of paths) {
      const res = await api.get(path);
      assert.equal(res.status, 401, `${path} answered ${res.status}`);
      assert.equal(res.body.error.code, 'UNAUTHORIZED', path);
    }
    const bulk = await api.put('/api/admin/reviews/bulk', { ids: [1], status: 'approved' });
    assert.equal(bulk.status, 401);
  });

  await t.test('signed in, those four answer with their own shape', async () => {
    await srv.reset();
    const api = srv.client();
    const email = 'reads-staff@example.test';
    await seedStaff(email);
    const token = await signInStaff(api, email);

    // Signing in is itself an audited action, so the activity feed is not
    // empty by the time it is read.
    const activity = await api.get('/api/admin/activity', { token });
    assert.equal(activity.status, 200, activity.text);
    assert.ok(Array.isArray(activity.body.data));

    const rejections = await api.get('/api/admin/security/token-rejections', { token });
    assert.equal(rejections.status, 200, rejections.text);

    const votes = await api.get('/api/admin/faq/votes', { token });
    assert.equal(votes.status, 200, votes.text);
    assert.ok(Array.isArray(votes.body.data.questions));

    const stats = await api.get('/api/admin/contact/stats', { token });
    assert.equal(stats.status, 200, stats.text);
    assert.equal(typeof stats.body.data, 'object');
  });

  await t.test('bulk review moderation validates, then actually moderates', async () => {
    await srv.reset();
    const api = srv.client();
    const email = 'bulk-staff@example.test';
    const staffId = await seedStaff(email);
    const token = await signInStaff(api, email);

    // Two reviews need two authors: reviews.user_id is UNIQUE (one per account).
    const secondId = await seedStaff('bulk-staff-2@example.test');
    await srv.query(
      `INSERT INTO reviews (user_id, user_name, rating, comment, status)
       VALUES (?, 'Staff', 5, 'Body one', 'pending'), (?, 'Staff', 4, 'Body two', 'pending')`,
      [staffId, secondId]
    );
    const pending = await srv.query("SELECT id FROM reviews WHERE status = 'pending'");
    const ids = pending.map((r) => r.id);
    assert.equal(ids.length, 2);

    // A status the schema does not allow is refused before any row is touched.
    const bad = await api.put('/api/admin/reviews/bulk', { ids, status: 'whatever' }, { token });
    assert.equal(bad.status, 400, bad.text);
    const untouched = await srv.query("SELECT COUNT(*) c FROM reviews WHERE status = 'pending'");
    assert.equal(Number(untouched[0].c), 2, 'a rejected request changes nothing');

    const good = await api.put('/api/admin/reviews/bulk', { ids, status: 'approved' }, { token });
    assert.equal(good.status, 200, good.text);
    assert.equal(good.body.data.affected, 2);

    const after = await srv.query("SELECT COUNT(*) c FROM reviews WHERE status = 'approved'");
    assert.equal(Number(after[0].c), 2);

    // It is an audited action: moderation has to be attributable.
    const logged = await srv.query(
      "SELECT COUNT(*) c FROM audit_logs WHERE action = 'review.bulk_moderated'"
    );
    assert.ok(Number(logged[0].c) >= 1, 'the bulk action is in the audit log');
  });

  // ---- the AI endpoints ----------------------------------------------------

  await t.test('the AI endpoints refuse a caller with no entitlement', async () => {
    await srv.reset();
    const api = srv.client();

    // No licence token at all: the plan resolves to Free, which has no AI.
    for (const [path, body] of [
      ['/api/ai/rename', { filename: 'a.mp4', url: 'https://example.test/a.mp4' }],
      ['/api/ai/command', { text: 'download this tonight' }],
    ]) {
      const res = await api.post(path, body);
      assert.equal(res.status, 403, `${path} answered ${res.status}: ${res.text}`);
      assert.equal(res.body.error.code, 'AI_NOT_ENTITLED', path);
    }

    // A forged bearer resolves to Free as well — never to an entitled plan.
    const forged = await api.post(
      '/api/ai/rename',
      { filename: 'a.mp4', url: 'https://example.test/a.mp4' },
      { headers: { authorization: 'Bearer not.a.real.token' } }
    );
    assert.equal(forged.status, 403, forged.text);
  });

  // ---- billing, while it is disabled ---------------------------------------

  await t.test('the three billing routes need a session, and then say billing is off', async () => {
    await srv.reset();
    const api = srv.client();
    const CALLS = [
      ['/api/subscription/checkout', { plan: 'pro', billingCycle: 'monthly' }],
      ['/api/subscription/coupon', { couponCode: 'SAVE10' }],
      ['/api/subscription/portal', {}],
    ];

    for (const [path, body] of CALLS) {
      assert.equal((await api.post(path, body)).status, 401, `${path} without a session`);
    }

    const user = await srv.makeUser(api);

    // The suite runs unhardened, where config picks the 'mock' Stripe so the
    // local billing flow can be exercised. Production picks 'disabled' — that
    // is the state being asserted here, so set it rather than assume it. The
    // routes read the flag per request, which is what makes this work.
    const was = config.isBillingDisabled;
    config.isBillingDisabled = true;
    try {
      for (const [path, body] of CALLS) {
        const res = await api.post(path, body, { token: user.token });
        // 503 is the honest answer with no Stripe keys. What must not happen
        // is a 500, or a 200 that pretends something was bought.
        assert.equal(res.status, 503, `${path} answered ${res.status}: ${res.text}`);
        assert.equal(res.body.ok, false);
        assert.equal(res.body.error.code, 'BILLING_UNAVAILABLE', path);
      }
    } finally {
      config.isBillingDisabled = was;
    }
  });

  // ---- the public changelog feed -------------------------------------------

  await t.test('the release history is public and hands out no download URLs', async () => {
    await srv.reset();
    const api = srv.client();
    await srv.query(
      `INSERT INTO releases (version, changelog, windows_url, linux_url, is_latest, published_at, download_count)
       VALUES ('2.0.0', 'Second', 'https://cdn.example.test/nexa-2.exe', 'https://cdn.example.test/nexa-2.deb', 1, UTC_TIMESTAMP(), 7)`
    );

    const res = await api.get('/api/releases/history');
    assert.equal(res.status, 200, res.text);
    const [latest] = res.body.data.releases;
    assert.equal(latest.version, '2.0.0');
    assert.equal(latest.isLatest, true);
    assert.equal(latest.hasWindows, true);
    assert.equal(latest.downloadCount, 7);

    // The URLs stay behind /download/:os so the counter cannot be bypassed —
    // H-06 is only true for as long as this stays true.
    assert.equal(res.text.includes('cdn.example.test'), false, 'no download URL in the changelog');
    assert.equal('windowsUrl' in latest, false);
    assert.equal('linuxUrl' in latest, false);
  });

  await srv.stop();
});
