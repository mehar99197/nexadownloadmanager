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
 * The claim is about the limiter, not about where it keeps its counts, so this
 * runs against whichever store the environment gives it: the MySQL one when a
 * database is reachable (CI, and any machine running test/tools/testdb.sh),
 * and the in-memory fallback when it is not. Either way the limiter must count,
 * return 429 at the ceiling, and keep two accounts' budgets apart.
 *
 * Which of the two it got is not a detail the file can shrug at. It said for a
 * while that it tested the in-memory path — and on a developer machine with no
 * MYSQL_* in the environment that was true, so it read as correct for as long
 * as nobody ran it anywhere else. CI sets MYSQL_* for the whole job, so the
 * first run there silently exercised the other store instead. That is the same
 * shape as O-03: a test whose real subject depends on the environment tells you
 * less than it looks, and it tells you least on the machine you trust most.
 *
 * Taking the database path also opens a connection pool, and a pool with an
 * idle connection in it keeps the process alive. `node --test` waits for each
 * file's process to exit before it starts the next, so leaving the pool open
 * does not fail anything — it stops the run dead, after these tests have
 * printed `ok`. Hence the after() hook: it is load-bearing, not tidiness.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

delete process.env.RATE_LIMIT_DISABLED;   // exercise the real limiters
const express = require('express');
const { loginLimiter, twoFactorLimiter, loginKey } = require('../src/middleware/rateLimiter');
const { getPool, query } = require('../src/config/db');

// The in-memory fallback is a fresh Map in every process, but the MySQL store
// is a table, and a budget spent by the last run is still spent. Without this
// the suite passes once against a given database and then reports 429 where it
// asked for 200 — which looks like the limiter miscounting rather than like
// the test bringing its own leftovers.
test.before(async () => {
  try {
    await query('TRUNCATE TABLE rate_limits');
  } catch {
    /* no database, or no table: the memory store needs no reset */
  }
});

// The store creates the pool on its first hit, so this has to run whether or
// not a database turned out to be there. getPool() on a run that never touched
// one just builds an idle pool and closes it again, which costs nothing:
// mysql2 does not dial until a query.
test.after(async () => {
  try {
    await (await getPool()).end();
  } catch {
    /* already closed, or never opened */
  }
});

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
