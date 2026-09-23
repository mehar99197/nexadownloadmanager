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

// Enough of res for fail(): status() chains, json() records.
function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

// → 'next' when the request is let through, or the status it was refused with.
function run(middleware, ip) {
  const res = fakeRes();
  let passed = false;
  middleware({ ip }, res, () => { passed = true; });
  return passed ? 'next' : res.statusCode;
}

function withLists({ admin, root }, work) {
  const savedAdmin = config.ADMIN_ALLOWED_IPS;
  const savedRoot = config.ROOT_ALLOWED_IPS;
  config.ADMIN_ALLOWED_IPS = admin;
  config.ROOT_ALLOWED_IPS = root === undefined ? [] : root;
  try {
    work();
  } finally {
    config.ADMIN_ALLOWED_IPS = savedAdmin;
    config.ROOT_ALLOWED_IPS = savedRoot;
  }
}

test('a listed address passes and an unlisted one is refused', () => {
  withLists({ admin: ['203.0.113.10'] }, () => {
    assert.equal(run(ipWhitelist, '203.0.113.10'), 'next');
    assert.equal(run(ipWhitelist, '203.0.113.11'), 403);
    // The creator gate with no list of its own uses the staff list.
    assert.equal(run(rootIpWhitelist, '203.0.113.10'), 'next');
    assert.equal(run(rootIpWhitelist, '198.51.100.7'), 403);
  });
});

test('an IPv4-mapped IPv6 address matches its plain form', () => {
  withLists({ admin: ['203.0.113.10'] }, () => {
    assert.equal(run(ipWhitelist, '::ffff:203.0.113.10'), 'next');
    assert.equal(run(ipWhitelist, '::ffff:203.0.113.11'), 403);
  });
});

test('* lets every address through, on both panels', () => {
  withLists({ admin: ['*'] }, () => {
    for (const ip of ['203.0.113.10', '198.51.100.7', '::ffff:8.8.8.8', '2001:db8::1']) {
      assert.equal(run(ipWhitelist, ip), 'next', ip);
      assert.equal(run(rootIpWhitelist, ip), 'next', ip);
    }
  });
});

test('* among real addresses still opens the gate — it is not matched literally', () => {
  // Someone appending '*' to an existing list means the same thing as '*'
  // alone. The alternative, treating it as an address that nothing equals,
  // would leave the operator locked out while the config claims otherwise.
  withLists({ admin: ['203.0.113.10', '*'] }, () => {
    assert.equal(run(ipWhitelist, '198.51.100.7'), 'next');
  });
});

test('a ROOT list of its own still binds the creator panel, * or not', () => {
  // The staff panel being open must not drag the creator panel open with it.
  withLists({ admin: ['*'], root: ['203.0.113.10'] }, () => {
    assert.equal(run(ipWhitelist, '198.51.100.7'), 'next');
    assert.equal(run(rootIpWhitelist, '198.51.100.7'), 403);
    assert.equal(run(rootIpWhitelist, '203.0.113.10'), 'next');
  });
});
