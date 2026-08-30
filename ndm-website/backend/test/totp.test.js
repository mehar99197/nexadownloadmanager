'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const totp = require('../src/utils/totp');

test('base32 round-trips arbitrary bytes', () => {
  for (const len of [0, 1, 5, 7, 20, 33]) {
    const buf = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + 11) & 255));
    assert.deepEqual(totp.base32Decode(totp.base32Encode(buf)), buf);
  }
});

test('generateSecret is 32 base32 chars (160 bits) and unique', () => {
  const a = totp.generateSecret();
  const b = totp.generateSecret();
  assert.match(a, /^[A-Z2-7]{32}$/);
  assert.notEqual(a, b);
});

test('matches the RFC 6238 SHA-1 reference vectors', () => {
  // Secret "12345678901234567890" (RFC 6238 appendix B), 6 digits, 30 s step.
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];
  for (const [seconds, expected] of vectors) {
    assert.equal(totp.totpAt(secret, seconds * 1000).slice(-6), expected, `t=${seconds}`);
  }
});

test('verifyTotp accepts the current step and one step of drift, rejects further', () => {
  const secret = totp.generateSecret();
  const now = 1_700_000_000_000;
  assert.equal(totp.verifyTotp(secret, totp.totpAt(secret, now), { when: now }), true);
  assert.equal(totp.verifyTotp(secret, totp.totpAt(secret, now - 30_000), { when: now }), true);
  assert.equal(totp.verifyTotp(secret, totp.totpAt(secret, now + 30_000), { when: now }), true);
  // Two steps away is outside the ±1 window (unless codes coincidentally collide).
  const far = totp.totpAt(secret, now + 90_000);
  const nearby = [totp.totpAt(secret, now - 30_000), totp.totpAt(secret, now), totp.totpAt(secret, now + 30_000)];
  if (!nearby.includes(far)) assert.equal(totp.verifyTotp(secret, far, { when: now }), false);
  // Malformed input never verifies.
  for (const bad of ['', '12345', 'abcdef', '1234567', null, undefined, 123456]) {
    assert.equal(totp.verifyTotp(secret, bad, { when: now }), false, `bad=${bad}`);
  }
});

test('otpauth URL carries issuer, account, and the secret', () => {
  const url = totp.otpauthUrl({ secret: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', account: 'admin@example.com', issuer: 'Nexa Admin' });
  assert.ok(url.startsWith('otpauth://totp/Nexa%20Admin%3Aadmin%40example.com?'));
  const params = new URL(url).searchParams;
  assert.equal(params.get('secret'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
  assert.equal(params.get('issuer'), 'Nexa Admin');
  assert.equal(params.get('digits'), '6');
  assert.equal(params.get('period'), '30');
});

test('secrets are encrypted at rest and decrypt back; tampering fails closed', () => {
  const secret = totp.generateSecret();
  const stored = totp.encryptSecret(secret);
  assert.notEqual(stored, secret);
  assert.equal(stored.split('.').length, 3);
  assert.equal(totp.decryptSecret(stored), secret);
  // Same secret encrypts differently every time (random IV).
  assert.notEqual(totp.encryptSecret(secret), stored);
  // Flip a character in the ciphertext → GCM tag mismatch → null, never garbage.
  const [iv, tag, enc] = stored.split('.');
  const flipped = enc[0] === 'A' ? `B${enc.slice(1)}` : `A${enc.slice(1)}`;
  assert.equal(totp.decryptSecret(`${iv}.${tag}.${flipped}`), null);
  assert.equal(totp.decryptSecret('garbage'), null);
  assert.equal(totp.decryptSecret(null), null);
});

test('recovery codes: eight unique codes, each usable exactly once, case/dash-insensitive', () => {
  const { codes, hashes } = totp.generateRecoveryCodes();
  assert.equal(codes.length, totp.RECOVERY_COUNT);
  assert.equal(new Set(codes).size, codes.length);
  for (const c of codes) assert.match(c, /^[a-z0-9]{5}-[a-z0-9]{5}$/);

  const remaining = totp.consumeRecoveryCode(hashes, codes[2].toUpperCase().replace('-', ' '));
  assert.ok(remaining);
  assert.equal(remaining.length, hashes.length - 1);
  // Used once — gone.
  assert.equal(totp.consumeRecoveryCode(remaining, codes[2]), null);
  // The others still work.
  assert.ok(totp.consumeRecoveryCode(remaining, codes[0]));
  assert.equal(totp.consumeRecoveryCode(hashes, 'nope-nope'), null);
  assert.equal(totp.consumeRecoveryCode(null, codes[0]), null);
});
