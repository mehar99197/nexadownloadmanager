'use strict';

/**
 * The per-route budgets on the public auth and licence endpoints, against the
 * real app and the durable (MySQL) store. Like rateLimit.integration.test.js,
 * this file does NOT set RATE_LIMIT_DISABLED: the real limiters are the
 * subject.
 *
 * Every request here comes from 127.0.0.1, which is exactly the situation the
 * bugs were about: many honest people behind one address (a campus NAT, an
 * office, a mobile carrier's CGNAT) must not be refused because somebody else
 * on that address used a different route, or activated a different licence.
 *
 * Bodies are deliberately invalid wherever the route would otherwise do real
 * work (verify a Google credential over the network, send mail): a limiter
 * runs before validation, so an invalid request is counted exactly like a
 * valid one and answers 400 instead of 429 until the budget is spent.
 */

delete process.env.RATE_LIMIT_DISABLED;

const test = require('node:test');
const assert = require('node:assert/strict');
const srv = require('./helpers/testServer');
const { MySqlRateLimitStore } = require('../src/middleware/rateLimitStore');

test('auth and licence budgets', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();
  await srv.reset();
  const api = srv.client();

  await t.test('Google sign-in does not share a budget with the other auth routes', async () => {
    // Spend forgot-password's whole budget from this address…
    const forgot = [];
    for (let i = 0; i < 6; i += 1) forgot.push((await api.post('/api/auth/forgot-password', {})).status);
    assert.deepEqual(forgot, [400, 400, 400, 400, 400, 429],
      'forgot-password keeps its own 5-per-15-min cap');

    // …and neither Google sign-in nor any other auth route is refused for it.
    const google = await api.post('/api/auth/google', {});
    assert.notEqual(google.status, 429, 'Google sign-in must not inherit forgot-password\'s budget');
    assert.equal(google.status, 400);
    for (const path of ['/api/auth/register', '/api/auth/verify-email',
      '/api/auth/resend-verification', '/api/auth/reset-password']) {
      const res = await api.post(path, {});
      assert.notEqual(res.status, 429, `${path} must have its own budget`);
    }
  });

  await t.test('Google sign-in allows many people behind one address', async () => {
    // One campus or office NAT: far more than five Google sign-ins in a
    // quarter of an hour must go through.
    const statuses = [];
    for (let i = 0; i < 40; i += 1) statuses.push((await api.post('/api/auth/google', {})).status);
    assert.equal(statuses.filter((s) => s === 429).length, 0, `got ${statuses}`);
  });

  await t.test('…but Google sign-in is still bounded per address', async () => {
    let limitedAt = null;
    for (let i = 0; i < 200 && limitedAt === null; i += 1) {
      const res = await api.post('/api/auth/google', {});
      if (res.status === 429) {
        limitedAt = i;
        assert.equal(res.body.error.code, 'RATE_LIMITED');
      }
    }
    assert.ok(limitedAt !== null, 'a script on one address must eventually be refused');
  });

  const licence = (key) => api.post('/api/license/validate', {
    license_key: key, device_fingerprint: 'f'.repeat(64),
  });

  await t.test('licence validation is budgeted per key, so one NAT can activate many copies', async () => {
    // One key hammered from one address is still capped at 10 an hour.
    for (let i = 0; i < 10; i += 1) {
      const res = await licence('NDM-AAAA-AAAA-AAAA');
      assert.equal(res.status, 200, `attempt ${i + 1}: ${JSON.stringify(res.body)}`);
    }
    assert.equal((await licence('NDM-AAAA-AAAA-AAAA')).status, 429, 'the same key\'s eleventh call is refused');

    // A colleague behind the same office NAT activating their own key is not.
    const other = await licence('NDM-BBBB-BBBB-BBBB');
    assert.equal(other.status, 200, 'a different key from the same address has its own budget');
  });

  await t.test('…while one address cycling through keys still hits an address-wide ceiling', async () => {
    let limited = false;
    // 12 calls are already spent from this address. Walk fresh keys until the
    // address-wide cap answers; it must, well before this loop runs out.
    for (let i = 0; i < 300 && !limited; i += 1) {
      const key = `NDM-C${String(i).padStart(3, '0')}-CCCC-CCCC`;
      const res = await licence(key);
      if (res.status === 429) limited = true;
      else assert.equal(res.status, 200);
    }
    assert.ok(limited, 'enumerating keys from one address must be capped');
  });

  await t.test('a rate-limit key longer than the id column is still counted durably', async () => {
    // loginKey is "<ip>|<email>" with the email kept up to 190 characters,
    // which overflowed rate_limits.id (VARCHAR(191)). The insert failed, the
    // store fell back to process memory, and a restart handed the guesser a
    // fresh budget.
    const longEmail = `${'a'.repeat(170)}@example.test`;
    const key = `203.0.113.7|${longEmail}`;
    const first = new MySqlRateLimitStore({ prefix: 'login' });
    first.init({ windowMs: 15 * 60 * 1000 });
    assert.equal((await first.increment(key)).totalHits, 1);
    assert.equal((await first.increment(key)).totalHits, 2);

    // A new store instance is what a process restart looks like.
    const restarted = new MySqlRateLimitStore({ prefix: 'login' });
    restarted.init({ windowMs: 15 * 60 * 1000 });
    assert.equal((await restarted.increment(key)).totalHits, 3, 'the count survived the restart');

    // Two keys that differ only past the old column width are still two keys.
    const sibling = `${key.slice(0, -1)}X`;
    assert.equal((await restarted.increment(sibling)).totalHits, 1);

    await restarted.resetKey(key);
    assert.equal((await first.increment(key)).totalHits, 1, 'resetKey clears the hashed row');
  });

  await srv.stop();
});
