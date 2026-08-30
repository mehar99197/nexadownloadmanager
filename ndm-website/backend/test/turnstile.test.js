'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config/env');
const { requireTurnstile, verifyToken, isEnabled, VERIFY_URL } = require('../src/middleware/turnstile');

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function run(req) {
  return new Promise((resolve) => {
    const res = fakeRes();
    requireTurnstile(req, res, (err) => resolve({ next: true, err, res }));
    // fail() answers synchronously or after the verify promise; poll once.
    setTimeout(() => resolve({ next: false, res }), 30);
  });
}

test('with no secret configured the gate is off and the token is stripped from the body', async () => {
  const saved = config.TURNSTILE_SECRET_KEY;
  config.TURNSTILE_SECRET_KEY = '';
  try {
    assert.equal(isEnabled(), false);
    const req = { body: { email: 'a@b.co', turnstileToken: 'xyz' }, ip: '127.0.0.1' };
    const out = await run(req);
    assert.equal(out.next, true);
    assert.equal('turnstileToken' in req.body, false, 'token must not reach the .strict() schema');
    assert.equal(req.body.email, 'a@b.co');
  } finally {
    config.TURNSTILE_SECRET_KEY = saved;
  }
});

test('verifyToken posts secret + response (+ ip) to Cloudflare and reads success', async () => {
  const saved = config.TURNSTILE_SECRET_KEY;
  config.TURNSTILE_SECRET_KEY = 'secret-1';
  try {
    let seen = null;
    const fetchImpl = async (url, init) => {
      seen = { url, body: Object.fromEntries(init.body.entries()) };
      return { json: async () => ({ success: true }) };
    };
    const ok = await verifyToken('tok', '1.2.3.4', fetchImpl);
    assert.deepEqual(ok, { success: true });
    assert.equal(seen.url, VERIFY_URL);
    assert.deepEqual(seen.body, { secret: 'secret-1', response: 'tok', remoteip: '1.2.3.4' });

    const bad = await verifyToken('tok', null, async () => ({ json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) }));
    assert.equal(bad.success, false);
    assert.equal(bad.reason, 'invalid-input-response');

    const missing = await verifyToken('', null, fetchImpl);
    assert.equal(missing.success, false);
    assert.equal(missing.reason, 'missing-input-response');
  } finally {
    config.TURNSTILE_SECRET_KEY = saved;
  }
});

test('a Cloudflare outage degrades open rather than blocking sign-up', async () => {
  const saved = config.TURNSTILE_SECRET_KEY;
  config.TURNSTILE_SECRET_KEY = 'secret-1';
  const savedError = console.error;
  console.error = () => {};
  try {
    const out = await verifyToken('tok', null, async () => { throw new Error('ECONNRESET'); });
    assert.equal(out.success, true);
    assert.equal(out.degraded, true);
  } finally {
    console.error = savedError;
    config.TURNSTILE_SECRET_KEY = saved;
  }
});

test('with a secret configured and no token the request is refused with CAPTCHA_FAILED', async () => {
  const saved = config.TURNSTILE_SECRET_KEY;
  const savedFetch = globalThis.fetch;
  config.TURNSTILE_SECRET_KEY = 'secret-1';
  // No token → short-circuits before any network call, but guard anyway.
  globalThis.fetch = async () => { throw new Error('must not be called'); };
  try {
    const out = await run({ body: { email: 'a@b.co' }, ip: '127.0.0.1' });
    assert.equal(out.next, false);
    assert.equal(out.res.statusCode, 400);
    assert.equal(out.res.body.error.code, 'CAPTCHA_FAILED');
  } finally {
    globalThis.fetch = savedFetch;
    config.TURNSTILE_SECRET_KEY = saved;
  }
});
