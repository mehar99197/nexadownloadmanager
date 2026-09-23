'use strict';

/**
 * AUDIT.md M-05 — a sign-in form must not be a stopwatch test for which
 * addresses exist.
 *
 * The property is "every branch pays a real bcrypt compare", so that is what
 * this measures: how long the no-hash branch takes next to a genuine one. It
 * does NOT assert that the two are within some percentage of each other —
 * that would be a flaky test on a shared CI box, and it is not the claim.
 * The claim is that the cheap branch is gone: a wrong password against a real
 * hash and a sign-in against no hash at all are both hundreds of times slower
 * than an early return, and within the same order of magnitude as each other.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { passwordMatches, dummyHash, BCRYPT_COST } = require('../src/utils/passwordCheck');

function millis(fn) {
  return (async () => {
    const started = process.hrtime.bigint();
    const value = await fn();
    return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 };
  })();
}

test('a correct password matches, a wrong one does not', async () => {
  const hash = await bcrypt.hash('correct horse battery staple', 4);
  assert.equal(await passwordMatches('correct horse battery staple', hash), true);
  assert.equal(await passwordMatches('Correct Horse Battery Staple', hash), false);
  assert.equal(await passwordMatches('', hash), false);
});

test('a missing hash is "no", not a throw — bcryptjs rejects a null hash', async () => {
  // A Google-created account has no password_hash. Every panel used to hand
  // that column straight to bcrypt.compare, which answered 500 rather than 401.
  for (const hash of [null, undefined, '', 0, false, {}]) {
    await assert.doesNotReject(passwordMatches('anything', hash), String(hash));
    assert.equal(await passwordMatches('anything', hash), false, String(hash));
  }
  for (const password of [null, undefined, 42, {}]) {
    assert.equal(await passwordMatches(password, await bcrypt.hash('x', 4)), false, String(password));
  }
});

test('the no-hash branch costs a real compare, not an early return', async () => {
  const real = await bcrypt.hash('a-real-password', BCRYPT_COST);
  // Warm the lazy dummy hash first: generating it is a one-off cost that
  // belongs to neither branch.
  dummyHash();

  const known = await millis(() => passwordMatches('wrong-guess', real));
  const unknown = await millis(() => passwordMatches('wrong-guess', null));
  assert.equal(known.value, false);
  assert.equal(unknown.value, false);

  // An early return is microseconds; a cost-12 compare is ~100–600 ms on the
  // machines this runs on. A floor of 10 ms separates those two worlds by two
  // orders of magnitude without pinning the test to any particular hardware.
  assert.ok(unknown.ms > 10, `the unknown-account branch took ${unknown.ms.toFixed(1)} ms — it is not comparing anything`);
  // And it is the same order of magnitude as the genuine one. Ten times is a
  // deliberately loose bound: it fails the shape this finding is about (1.8 ms
  // against 580 ms) and survives a loaded CI runner.
  const ratio = known.ms / unknown.ms;
  assert.ok(ratio < 10 && ratio > 0.1,
    `known ${known.ms.toFixed(1)} ms vs unknown ${unknown.ms.toFixed(1)} ms — the two branches are not comparable work`);
});

test('the dummy hash is a real bcrypt hash of something unguessable', async () => {
  const hash = dummyHash();
  assert.match(hash, /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/);
  assert.equal(bcrypt.getRounds(hash), BCRYPT_COST);
  // Stable within a process (it is compared against on every passwordless
  // sign-in) and never equal to a hash of something a caller could send.
  assert.equal(dummyHash(), hash);
  for (const guess of ['', 'password', 'admin', hash]) {
    assert.equal(await bcrypt.compare(guess, hash), false, guess);
  }
});
