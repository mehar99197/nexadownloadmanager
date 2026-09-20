'use strict';

/**
 * Rate limits are a security control, so they get their own file: this one does
 * NOT set RATE_LIMIT_DISABLED, so the real limiters are in force.
 *
 * WP-08 split the old shared 5-per-15-minutes auth bucket into two keys that
 * do different jobs (middleware/rateLimiter.js):
 *
 *   per IP     → REFUSES. Sign-in is 30 per 15 minutes per address — sized for
 *                an office or a campus behind one egress, not for one person.
 *   per email  → DELAYS, never refuses. Consecutive failures against one
 *                account buy an increasing wait (100 → 250 → 500 → 1000 →
 *                2000 ms) before the next attempt is even looked at, and a
 *                successful sign-in clears it. An attacker can make one
 *                account slow; they cannot lock its owner out.
 *
 * Both halves are asserted here, against the real middleware. The waits are
 * checked as LOWER bounds on wall-clock time only: an upper bound would turn
 * a slow CI box into a failure, while a request that came back sooner than
 * the delay it had earned is the one thing that must never happen.
 */

// 'loopback' so Express honours the X-Forwarded-For these tests set: the
// per-IP budget is 30 attempts, and the per-account delay would otherwise
// make one address's 31 attempts take most of a minute. Each subtest is its
// own address, so none spends another's budget.
process.env.TRUST_PROXY = process.env.TRUST_PROXY || 'loopback';

const test = require('node:test');
const assert = require('node:assert/strict');
const srv = require('./helpers/testServer');
// Same process as the server, so this reads the live failure table.
const { loginDelayFor } = require('../src/middleware/rateLimiter');

const LOGIN_BUDGET_PER_IP = 30;

test('rate limiting', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();
  await srv.reset();

  const from = (ip) => ({ headers: { 'x-forwarded-for': ip } });

  await t.test('one address gets a fixed sign-in budget, then a 429', async () => {
    const api = srv.client();
    const ip = '198.51.100.1';
    // Distinct addresses so the per-ACCOUNT slowdown never engages: this is
    // the per-IP half on its own.
    const attempt = (i) => api.post('/api/auth/login',
      { email: `guess${i}@example.test`, password: 'wrong-password' }, from(ip));

    for (let i = 0; i < LOGIN_BUDGET_PER_IP; i += 1) {
      const res = await attempt(i);
      assert.equal(res.status, 401, `attempt ${i + 1} inside the budget is an ordinary failure: ${res.text}`);
    }

    const refused = await attempt(LOGIN_BUDGET_PER_IP);
    assert.equal(refused.status, 429, `attempt ${LOGIN_BUDGET_PER_IP + 1} is refused: ${refused.text}`);
    assert.equal(refused.body.error.code, 'RATE_LIMITED');
    // The budget is per address: a neighbour is untouched.
    const neighbour = await api.post('/api/auth/login',
      { email: 'guess0@example.test', password: 'wrong-password' }, from('198.51.100.2'));
    assert.equal(neighbour.status, 401, 'another address still has its own budget');
  });

  await t.test('a request that fails validation spends no budget', async () => {
    // Every auth limiter is mounted AFTER validate(), so malformed bodies —
    // the cheapest thing a script can send — cannot exhaust a shared address.
    const api = srv.client();
    const ip = '198.51.100.3';
    for (let i = 0; i < LOGIN_BUDGET_PER_IP + 5; i += 1) {
      const res = await api.post('/api/auth/login', { email: 'not-an-address', password: '' }, from(ip));
      assert.equal(res.status, 400, `malformed attempt ${i + 1} is a 400, not a 429`);
    }
    const real = await api.post('/api/auth/login',
      { email: 'someone@example.test', password: 'wrong-password' }, from(ip));
    assert.equal(real.status, 401, 'the budget is intact after the malformed burst');
  });

  await t.test('repeated failures against one account are slowed, not refused', async () => {
    const api = srv.client();
    const ip = '198.51.100.4';
    // An address nobody owns: no bcrypt to muddy the timing, and the failure
    // is still counted so the delay cannot itself reveal which addresses exist.
    const email = 'slowed@example.test';
    const attempt = () => api.post('/api/auth/login', { email, password: 'wrong-password' }, from(ip));
    const timed = async () => {
      const started = Date.now();
      const res = await attempt();
      return { res, elapsed: Date.now() - started };
    };

    // The first three are free; that is how a fat-fingered owner never waits.
    for (let i = 0; i < 3; i += 1) assert.equal((await attempt()).status, 401);
    assert.equal(loginDelayFor(email), 100, 'three failures earn a 100 ms wait');

    const fourth = await timed();
    assert.equal(fourth.res.status, 401, 'still a 401 — delayed, never refused');
    assert.ok(fourth.elapsed >= 100, `the fourth attempt waited ${fourth.elapsed} ms, expected ≥ 100`);
    assert.equal(loginDelayFor(email), 250);

    const fifth = await timed();
    assert.equal(fifth.res.status, 401);
    assert.ok(fifth.elapsed >= 250, `the fifth attempt waited ${fifth.elapsed} ms, expected ≥ 250`);
    assert.equal(loginDelayFor(email), 500);
  });

  await t.test('a successful sign-in clears the account slowdown', async () => {
    const api = srv.client();
    const ip = '198.51.100.5';
    const email = 'owner@example.test';
    const password = 'the-real-password';
    assert.equal((await api.post('/api/auth/register',
      { name: 'Owner', email, password }, from(ip))).status, 201);

    for (let i = 0; i < 4; i += 1) {
      assert.equal((await api.post('/api/auth/login',
        { email, password: 'wrong-password' }, from(ip))).status, 401);
    }
    assert.equal(loginDelayFor(email), 250, 'four failures earned a wait');

    // The owner signs in through the wait — it slows them, it does not stop
    // them — and the slate is wiped.
    const ok = await api.post('/api/auth/login', { email, password }, from(ip));
    assert.equal(ok.status, 200, ok.text);
    assert.equal(loginDelayFor(email), 0, 'proof of ownership clears the counter');
  });

  await t.test('the licence endpoint is capped per source IP', async () => {
    const api = srv.client();
    const body = { license_key: 'NDM-AAAA-BBBB-CCCC', device_fingerprint: 'f'.repeat(64) };
    let sawLimit = false;
    for (let i = 0; i < 12; i += 1) {
      const res = await api.post('/api/license/validate', body);
      if (res.status === 429) { sawLimit = true; break; }
      // Until the cap, an unknown key still answers 200 with valid:false.
      assert.equal(res.status, 200);
    }
    assert.ok(sawLimit, 'licence validation should be capped at 10/hour per IP');
  });

  await srv.stop();
});
