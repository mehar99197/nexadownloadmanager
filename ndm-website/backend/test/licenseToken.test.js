'use strict';

/**
 * Licence tokens are the only token family the desktop client verifies for
 * itself, using a public key compiled into the binary. That makes forgery the
 * entire threat model, so every classic JWT attack gets an explicit test.
 *
 * The matching client-side verifier is tests/LicenseTokenTest.cpp — the two
 * must agree, so a change here that is not mirrored there should fail the C++
 * test rather than silently diverge.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ed25519Jwt = require('../src/utils/ed25519Jwt');
const licenseKeys = require('../src/config/licenseKeys');
const { signLicenseToken, verifyLicense } = require('../src/utils/jwt');

const CLAIMS = {
  sub: 'NDM-AAAA-BBBB-CCCC',
  plan: 'pro',
  device: 'a'.repeat(64),
  features: { aiRename: true, adFree: true },
};

test('a freshly signed licence token verifies and keeps its claims', () => {
  const payload = verifyLicense(signLicenseToken(CLAIMS));
  assert.equal(payload.plan, 'pro');
  assert.equal(payload.sub, CLAIMS.sub);
  assert.equal(payload.device, CLAIMS.device);
  assert.equal(payload.typ, 'license');
  assert.equal(payload.features.aiRename, true);
  assert.equal(typeof payload.exp, 'number');
  assert.equal(typeof payload.iat, 'number');
});

test('tokens are Ed25519, not an HMAC family', () => {
  const header = JSON.parse(
    Buffer.from(signLicenseToken(CLAIMS).split('.')[0], 'base64url').toString('utf8')
  );
  assert.equal(header.alg, 'EdDSA');
});

test('the signing key never leaves the server — the public half is 32 bytes', () => {
  assert.match(licenseKeys.publicKeyHex, /^[0-9a-f]{64}$/);
});

test('alg:none is refused', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = signLicenseToken(CLAIMS).split('.')[1];
  assert.throws(() => verifyLicense(`${header}.${payload}.`));
});

test('algorithm confusion — HS256 signed with the public key as the secret — is refused', () => {
  // This is the attack that makes publishing a verification key dangerous if
  // the verifier is flexible about algorithms. The public key is in every
  // copy of the app, so an attacker genuinely has these bytes.
  const forged = jwt.sign(
    { ...CLAIMS, typ: 'license', exp: Math.floor(Date.now() / 1000) + 3600 },
    Buffer.from(licenseKeys.publicKeyHex, 'hex')
  );
  assert.throws(() => verifyLicense(forged));
});

test('a tampered plan claim breaks the signature', () => {
  const token = signLicenseToken({ ...CLAIMS, plan: 'free' });
  const [header, body, signature] = token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  payload.plan = 'team';
  const rewritten = Buffer.from(JSON.stringify(payload)).toString('base64url');
  assert.throws(() => verifyLicense(`${header}.${rewritten}.${signature}`));
});

test('a token signed by a different Ed25519 key is refused', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const forged = ed25519Jwt.sign({ ...CLAIMS, typ: 'license' }, privateKey, 3600);
  assert.throws(() => verifyLicense(forged));
});

test('an expired token is refused', () => {
  const stale = ed25519Jwt.sign({ ...CLAIMS, typ: 'license' }, licenseKeys.privateKey, -3600);
  assert.throws(() => verifyLicense(stale), /expired/);
});

test('a token with no exp is refused rather than treated as eternal', () => {
  // Hand-built, because sign() always sets exp.
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ plan: 'pro', typ: 'license' })).toString('base64url');
  const signature = crypto
    .sign(null, Buffer.from(`${header}.${body}`, 'ascii'), licenseKeys.privateKey)
    .toString('base64url');
  assert.throws(() => verifyLicense(`${header}.${body}.${signature}`), /exp/);
});

test('a token of another type cannot pass as a licence', () => {
  const wrongType = ed25519Jwt.sign({ ...CLAIMS, typ: 'access' }, licenseKeys.privateKey, 3600);
  assert.throws(() => verifyLicense(wrongType), /token type/);
});

test('malformed input is refused, not crashed on', () => {
  for (const bad of ['', 'x', 'a.b', 'a.b.c.d', '...', null, undefined, 42, {}]) {
    assert.throws(() => verifyLicense(bad));
  }
});

test('a signature of the wrong length is refused', () => {
  const [header, body] = signLicenseToken(CLAIMS).split('.');
  const short = Buffer.alloc(32).toString('base64url');
  assert.throws(() => verifyLicense(`${header}.${body}.${short}`), /signature length/);
});

test('licence tokens are short-lived, matching the seat lease', () => {
  // A long-lived token means a revoked licence keeps working on plan-gated
  // endpoints until it lapses. It was 24h; /heartbeat re-issues every 5 minutes
  // now, so there is no reason for it to outlive the lease it represents.
  const { SEAT_LEASE_SECONDS } = require('../src/utils/license');
  const claims = verifyLicense(signLicenseToken(CLAIMS));
  const lifetime = claims.exp - claims.iat;

  assert.ok(lifetime > 0, 'a token has a positive lifetime');
  assert.ok(lifetime <= SEAT_LEASE_SECONDS,
    `token lifetime ${lifetime}s must not exceed the ${SEAT_LEASE_SECONDS}s seat lease`);
  // Three 5-minute beats of slack: enough that one or two dropped requests on a
  // flaky connection do not leave a paying user without a valid token.
  assert.ok(lifetime >= 10 * 60, `token lifetime ${lifetime}s leaves too little slack`);
});
