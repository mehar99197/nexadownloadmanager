'use strict';

// Rate limits are a security control, so they get their own file: this one does
// NOT set RATE_LIMIT_DISABLED, so the real limiters are in force.
const test = require('node:test');
const assert = require('node:assert/strict');
const srv = require('./helpers/testServer');

test('rate limiting', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();
  await srv.reset();
  const api = srv.client();

  await t.test('auth endpoints stop brute force after 5 attempts', async () => {
    const attempt = () =>
      api.post('/api/auth/login', { email: 'nobody@example.test', password: 'wrong-password' });

    const statuses = [];
    for (let i = 0; i < 7; i += 1) statuses.push((await attempt()).status);

    // The first five are ordinary failures; the rest must be refused outright.
    assert.equal(statuses.slice(0, 5).every((s) => s === 401 || s === 400), true,
      `expected auth failures first, got ${statuses}`);
    const limited = statuses.filter((s) => s === 429);
    assert.ok(limited.length >= 1, `expected a 429 after 5 tries, got ${statuses}`);

    const last = await attempt();
    assert.equal(last.status, 429);
    assert.equal(last.body.error.code, 'RATE_LIMITED');
  });

  await t.test('the licence endpoint is capped per source IP', async () => {
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
