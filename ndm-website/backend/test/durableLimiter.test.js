'use strict';

/**
 * The security-critical limiters, exercised through real HTTP.
 *
 * These are the ones that matter — sign-in, admin sign-in, 2FA codes — and they
 * are also the ones with the most machinery behind them: a custom MySQL store
 * and, for sign-in, a custom key that counts per (IP, email) rather than per IP.
 * The integration suite covers them against a live database and skips itself
 * without one, which means on a machine with no MySQL nothing checked them at
 * all. A dependency bump could quietly change the Store contract or reject the
 * key generator, and the first sign of it would be production.
 *
 * With no database reachable the store falls back to counting in memory, which
 * is a documented path and the one under test here: the limiter must still
 * count, still return 429 at the ceiling, and still keep two accounts' budgets
 * apart.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

delete process.env.RATE_LIMIT_DISABLED;   // exercise the real limiters
const express = require('express');
const { loginLimiter, twoFactorLimiter, loginKey } = require('../src/middleware/rateLimiter');

function serve() {
  const app = express();
  // A specific hop count, not `true`: the library rightly warns that trusting
  // every proxy lets a client spoof its own address, and the real app sets
  // TRUST_PROXY for the same reason.
  app.set('trust proxy', 1);
  app.use(express.json());
  app.post('/login', loginLimiter, (req, res) => res.status(200).json({ ok: true }));
  app.post('/2fa', twoFactorLimiter, (req, res) => res.status(200).json({ ok: true }));
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function post(server, path, body, forwardedFor) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
    },
    body: JSON.stringify(body),
  });
  await res.text();
  return res.status;
}

test('the durable limiters count, cut off, and keep separate budgets apart', async (t) => {
  const server = await serve();
  try {
    await t.test('sign-in is capped, and the cap is per account, not per address', async () => {
      const ip = '203.0.113.7';
      // Five are allowed; the sixth is refused.
      for (let i = 0; i < 5; i += 1) {
        assert.equal(await post(server, '/login', { email: 'a@example.test' }, ip), 200,
          `attempt ${i + 1} should be allowed`);
      }
      assert.equal(await post(server, '/login', { email: 'a@example.test' }, ip), 429,
        'the sixth attempt for this account is refused');

      // A different account from the SAME address still has its own budget.
      // This is the whole reason loginKey exists: one person mistyping their
      // password must not lock out everybody behind the same office NAT.
      assert.equal(await post(server, '/login', { email: 'b@example.test' }, ip), 200,
        'another account from the same address is unaffected');
    });

    await t.test('a limiter with no custom key still counts', async () => {
      const ip = '203.0.113.9';
      for (let i = 0; i < 10; i += 1) {
        assert.equal(await post(server, '/2fa', {}, ip), 200, `code attempt ${i + 1}`);
      }
      assert.equal(await post(server, '/2fa', {}, ip), 429, 'the eleventh code attempt is refused');
    });
  } finally {
    server.close();
  }
});

test('loginKey separates accounts and normalises the address', () => {
  // Case and surrounding whitespace must not buy a second budget.
  assert.equal(
    loginKey({ ip: '203.0.113.7', body: { email: '  A@Example.TEST ' } }),
    loginKey({ ip: '203.0.113.7', body: { email: 'a@example.test' } })
  );
  assert.notEqual(
    loginKey({ ip: '203.0.113.7', body: { email: 'a@example.test' } }),
    loginKey({ ip: '203.0.113.7', body: { email: 'b@example.test' } })
  );
  // A request with no body at all must still produce a usable key rather than
  // throwing inside the limiter, which would 500 the sign-in route.
  assert.equal(typeof loginKey({ ip: '203.0.113.7' }), 'string');

  // IPv4 keys are the address itself: nothing about existing clients changed.
  assert.ok(loginKey({ ip: '203.0.113.7', body: { email: 'a@b.test' } }).startsWith('203.0.113.7|'));

  // IPv6 is collapsed to its prefix. An ISP hands one customer a whole block,
  // so keying on the full address let an attacker step to the next one after
  // every fifth guess and the limit counted nothing.
  const six = (addr) => loginKey({ ip: addr, body: { email: 'a@b.test' } });
  assert.equal(
    six('2001:db8:1234:5678:9abc:def0:1234:5678'),
    six('2001:db8:1234:5678:ffff:ffff:ffff:ffff'),
    'two addresses in the same block share one budget'
  );
  assert.notEqual(
    six('2001:db8:1234:5678::1'),
    six('2001:db8:9999:5678::1'),
    'genuinely different blocks still get their own'
  );
});
