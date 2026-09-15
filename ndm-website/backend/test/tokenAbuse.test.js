'use strict';

/**
 * Classification of rejected licence tokens.
 *
 * The point of this telemetry is to tell "somebody is forging tokens" apart
 * from "a client's clock is wrong", so the classification is the part worth
 * testing: getting it backwards would either bury a real attack in noise or
 * raise an alarm every time a laptop wakes from sleep.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const { classifyRejection, isAttackReason, REASONS } = require('../src/utils/tokenAbuse');
const { planFromAuthHeader } = require('../src/utils/ads');
const { verifyLicense, signLicenseToken } = require('../src/utils/jwt');
const licenseKeys = require('../src/config/licenseKeys');
const ed25519Jwt = require('../src/utils/ed25519Jwt');

// Classify by running a real forgery through the real verifier, rather than
// asserting against hand-written error strings that could drift.
function reasonFor(token) {
  try {
    verifyLicense(token);
    return null;
  } catch (err) {
    return classifyRejection(err);
  }
}

test('a forged signature is classified as an attack', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const forged = ed25519Jwt.sign({ plan: 'pro', typ: 'license' }, privateKey, 3600);
  const reason = reasonFor(forged);
  assert.equal(reason, 'bad_signature');
  assert.ok(isAttackReason(reason));
});

test('algorithm confusion is classified as an attack, distinctly', () => {
  const forged = jwt.sign(
    { plan: 'pro', typ: 'license', exp: Math.floor(Date.now() / 1000) + 3600 },
    Buffer.from(licenseKeys.publicKeyHex, 'hex')
  );
  const reason = reasonFor(forged);
  assert.equal(reason, 'bad_algorithm');
  assert.ok(isAttackReason(reason));
});

test('a tampered payload reads as a bad signature', () => {
  const [header, body, signature] = signLicenseToken({ plan: 'free' }).split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  payload.plan = 'team';
  const rewritten = Buffer.from(JSON.stringify(payload)).toString('base64url');
  assert.equal(reasonFor(`${header}.${rewritten}.${signature}`), 'bad_signature');
});

test('an expired token is NOT treated as an attack', () => {
  // A laptop that slept through its heartbeats produces this honestly, and
  // alerting on it would bury the signals that matter.
  const stale = ed25519Jwt.sign({ plan: 'pro', typ: 'license' }, licenseKeys.privateKey, -3600);
  const reason = reasonFor(stale);
  assert.equal(reason, 'expired');
  assert.equal(isAttackReason(reason), false);
});

test('a token of the wrong family is an attack', () => {
  const wrongType = ed25519Jwt.sign({ plan: 'pro', typ: 'access' }, licenseKeys.privateKey, 3600);
  assert.equal(reasonFor(wrongType), 'wrong_type');
});

test('every classification is a known reason code', () => {
  for (const junk of ['', 'x', 'a.b', 'a.b.c', '...', 'not.a.token']) {
    const reason = reasonFor(junk);
    if (reason !== null) assert.ok(REASONS.includes(reason), `${junk} -> ${reason}`);
  }
  assert.ok(REASONS.includes(classifyRejection(new Error('something unheard of'))));
  assert.ok(REASONS.includes(classifyRejection(null)));
  assert.ok(REASONS.includes(classifyRejection(undefined)));
});

// --- the gate must be unaffected by the telemetry ---------------------------

test('a rejected token still resolves to free, and reports why', () => {
  let seen = null;
  const plan = planFromAuthHeader('Bearer garbage', verifyLicense, (err) => {
    seen = classifyRejection(err);
  });
  assert.equal(plan, 'free');
  assert.ok(seen, 'the callback was told why');
});

test('a callback that throws cannot break the entitlement gate', () => {
  // Telemetry failing must never turn ads off for someone who has not paid,
  // nor 500 the endpoint.
  const plan = planFromAuthHeader('Bearer garbage', verifyLicense, () => {
    throw new Error('telemetry exploded');
  });
  assert.equal(plan, 'free');
});

test('a valid paid token is unaffected and fires no rejection', () => {
  let fired = false;
  const token = signLicenseToken({ sub: 'NDM-AAAA-BBBB-CCCC', plan: 'pro', device: 'd' });
  const plan = planFromAuthHeader(`Bearer ${token}`, verifyLicense, () => { fired = true; });
  assert.equal(plan, 'pro');
  assert.equal(fired, false, 'a good token must not be counted as a rejection');
});

test('no Authorization header is not a rejection', () => {
  // Free installs simply have no token; counting those would drown the signal.
  let fired = false;
  for (const header of [undefined, '', 'Basic abc', 'Bearer']) {
    planFromAuthHeader(header, verifyLicense, () => { fired = true; });
  }
  assert.equal(fired, false);
});
