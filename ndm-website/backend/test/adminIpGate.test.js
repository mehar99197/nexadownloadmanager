'use strict';

/**
 * The IP gate in front of both control panels (middleware/adminAuth.js).
 *
 * Driven through the exported middleware rather than the helper behind it,
 * because the claim is about what a request gets — next() or 403 — and the two
 * panels reach the helper by different routes: the staff gate reads
 * ADMIN_ALLOWED_IPS, the creator gate reads ROOT_ALLOWED_IPS and falls back to
 * the staff list, deliberately, so the creator panel can never end up less
 * restricted than the staff one.
 *
 * The '*' case is the one with teeth. An empty list already meant "allow any"
 * here, but config/env.js refuses to start a hardened deployment on an empty
 * list, so that path is unreachable in production and only '*' can express it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config/env');
const { ipWhitelist, rootIpWhitelist } = require('../src/middleware/adminAuth');
const AdminIpRule = require('../src/models/AdminIpRule');
const { getPool } = require('../src/config/db');

// T-03, again, and from the same cause: effectiveList() reads the rules table,
// so on any machine where a database IS reachable — CI sets MYSQL_* for the
// whole job — it opens a pool, and an idle pooled connection keeps the process
// alive. node --test waits for each file to exit before starting the next, so
// leaving it open does not fail anything; it stops the run dead, after these
// tests have printed ok. Which is exactly what it did.
test.after(async () => {
  try {
    await (await getPool()).end();
  } catch {
    /* already closed, or never opened */
  }
});

// Enough of res for fail(): status() chains, json() records.
function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

// → 'next' when the request is let through, or the status it was refused with.
//
// Awaited: both gates read the panel-managed rules before deciding, so they
// are async. Calling one and reading the result on the next line answered
// "refused" for every request, whatever the list said — which is what a
// synchronous version of this helper did, and what it reported.
//
// There is no database here, and that is deliberate: effectiveList() falls
// back to the .env list alone when the query fails, so this file tests the
// matching rules on their own. The rows and their interaction with .env are
// covered against a real database in adminIpRules.integration.test.js.
async function run(middleware, ip) {
  const res = fakeRes();
  let passed = false;
  let failed = null;
  // Both gates are async functions that either call next() or return
  // fail(res, …), so awaiting the call is enough — by the time it settles the
  // decision has been made.
  await middleware({ ip }, res, (err) => { if (err) failed = err; else passed = true; });
  if (failed) throw failed;
  return passed ? 'next' : res.statusCode;
}

async function withLists({ admin, root }, work) {
  const savedAdmin = config.ADMIN_ALLOWED_IPS;
  const savedRoot = config.ROOT_ALLOWED_IPS;
  config.ADMIN_ALLOWED_IPS = admin;
  config.ROOT_ALLOWED_IPS = root === undefined ? [] : root;
  // effectiveList() caches, and the cache is keyed on nothing — a list left
  // over from the previous case would decide this one.
  AdminIpRule.dropCache();
  try {
    await work();
  } finally {
    config.ADMIN_ALLOWED_IPS = savedAdmin;
    config.ROOT_ALLOWED_IPS = savedRoot;
    AdminIpRule.dropCache();
  }
}

test('a listed address passes and an unlisted one is refused', async () => {
  await withLists({ admin: ['203.0.113.10'] }, async () => {
    assert.equal(await run(ipWhitelist, '203.0.113.10'), 'next');
    assert.equal(await run(ipWhitelist, '203.0.113.11'), 403);
    // The creator gate with no list of its own uses the staff list.
    assert.equal(await run(rootIpWhitelist, '203.0.113.10'), 'next');
    assert.equal(await run(rootIpWhitelist, '198.51.100.7'), 403);
  });
});

test('an IPv4-mapped IPv6 address matches its plain form', async () => {
  await withLists({ admin: ['203.0.113.10'] }, async () => {
    assert.equal(await run(ipWhitelist, '::ffff:203.0.113.10'), 'next');
    assert.equal(await run(ipWhitelist, '::ffff:203.0.113.11'), 403);
  });
});

test('* lets every address through, on both panels', async () => {
  await withLists({ admin: ['*'] }, async () => {
    for (const ip of ['203.0.113.10', '198.51.100.7', '::ffff:8.8.8.8', '2001:db8::1']) {
      assert.equal(await run(ipWhitelist, ip), 'next', ip);
      assert.equal(await run(rootIpWhitelist, ip), 'next', ip);
    }
  });
});

test('* among real addresses still opens the gate — it is not matched literally', async () => {
  // Someone appending '*' to an existing list means the same thing as '*'
  // alone. The alternative, treating it as an address that nothing equals,
  // would leave the operator locked out while the config claims otherwise.
  await withLists({ admin: ['203.0.113.10', '*'] }, async () => {
    assert.equal(await run(ipWhitelist, '198.51.100.7'), 'next');
  });
});

test('a ROOT list of its own still binds the creator panel, * or not', async () => {
  // The staff panel being open must not drag the creator panel open with it.
  await withLists({ admin: ['*'], root: ['203.0.113.10'] }, async () => {
    assert.equal(await run(ipWhitelist, '198.51.100.7'), 'next');
    assert.equal(await run(rootIpWhitelist, '198.51.100.7'), 403);
    assert.equal(await run(rootIpWhitelist, '203.0.113.10'), 'next');
  });
});
