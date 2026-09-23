'use strict';
/**
 * utils/passwordPolicy.js — the value rules on top of the length rule, with
 * Have I Been Pwned stood in for by a fake fetch so nothing leaves the box.
 */
process.env.NODE_ENV = 'test';
process.env.PASSWORD_BREACH_CHECK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { passwordProblem, breachedCount, containsEmailLocalPart } = require('../src/utils/passwordPolicy');

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex').toUpperCase();

/** A fake HIBP range endpoint that knows exactly the passwords it is given. */
function fakeHibp(breached, { status = 200, delayMs = 0 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const prefix = url.slice(-5);
    const lines = breached
      .map((pw) => sha1(pw))
      .filter((h) => h.startsWith(prefix))
      .map((h) => `${h.slice(5)}:${7}`);
    // Padding lines, like the real API sends when Add-Padding is on.
    lines.push('0000000000000000000000000000000000A:0');
    return { ok: status === 200, status, text: async () => lines.join('\r\n') };
  };
  return { fetchImpl, calls };
}

test('only the first five hex characters of the SHA-1 leave the server', async () => {
  const { fetchImpl, calls } = fakeHibp([]);
  await breachedCount('correct horse battery staple', { fetchImpl });
  assert.equal(calls.length, 1);
  const sent = calls[0].url.split('/').pop();
  assert.equal(sent.length, 5);
  assert.equal(sent, sha1('correct horse battery staple').slice(0, 5));
  assert.equal(calls[0].opts.headers['Add-Padding'], 'true');
  assert.ok(!JSON.stringify(calls[0]).includes('correct horse'), 'the password itself is never sent');
});

test('a breached password is refused with a message that names the reason', async () => {
  const { fetchImpl } = fakeHibp(['Password123!']);
  const problem = await passwordProblem('Password123!', { email: 'someone@example.test', fetchImpl });
  assert.match(problem, /data breach/i);
});

test('an unbreached password passes', async () => {
  const { fetchImpl } = fakeHibp(['Password123!']);
  assert.equal(await passwordProblem('Password123!x', { email: 'someone@example.test', fetchImpl }), null);
});

test('a password containing the email local-part is refused before HIBP is asked', async () => {
  const { fetchImpl, calls } = fakeHibp([]);
  const problem = await passwordProblem('ahmad.nawaz2026', { email: 'Ahmad.Nawaz@example.test', fetchImpl });
  assert.match(problem, /email address/i);
  assert.equal(calls.length, 0);
  // Short local-parts ("me@", "ab@") would forbid too much — they are ignored.
  assert.equal(containsEmailLocalPart('me-and-my-password', 'me@example.test'), false);
  assert.equal(containsEmailLocalPart('xxjohnnyxx', 'johnny@example.test'), true);
});

test('the check fails open when HIBP is down or slow', async () => {
  const down = fakeHibp(['Password123!'], { status: 503 });
  assert.equal(await passwordProblem('Password123!', { email: 'a@example.test', fetchImpl: down.fetchImpl }), null);

  // A fetch that answers only when it is aborted. AbortSignal.timeout()'s
  // timer is deliberately unref'd — it does not hold the event loop open — so
  // a promise whose only exit is that abort can leave the runner with nothing
  // to wait on and nothing to run: node then reports "Promise resolution is
  // still pending but the event loop has already resolved" and cancels the
  // test. It did exactly that on CI while passing here, because whether the
  // loop drains first is a race. The ref'd timer below is what keeps the
  // process alive long enough for the abort to arrive, and it fails loudly
  // rather than hanging if the abort never comes at all.
  const slow = { fetchImpl: (url, opts) => new Promise((_, reject) => {
    const keepAlive = setTimeout(
      () => reject(new Error('the breach check never aborted its request')), 2000
    );
    opts.signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(new Error('aborted'));
    });
  }) };
  process.env.PASSWORD_BREACH_TIMEOUT_MS = '500';
  const config = require('../src/config/env');
  config.PASSWORD_BREACH_TIMEOUT_MS = 50;
  assert.equal(await passwordProblem('Password123!', { email: 'a@example.test', fetchImpl: slow.fetchImpl }), null);
});

test('PASSWORD_BREACH_CHECK=false skips HIBP entirely', async () => {
  const config = require('../src/config/env');
  const was = config.PASSWORD_BREACH_CHECK;
  config.PASSWORD_BREACH_CHECK = false;
  try {
    const { fetchImpl, calls } = fakeHibp(['Password123!']);
    assert.equal(await passwordProblem('Password123!', { email: 'a@example.test', fetchImpl }), null);
    assert.equal(calls.length, 0);
  } finally {
    config.PASSWORD_BREACH_CHECK = was;
  }
});
