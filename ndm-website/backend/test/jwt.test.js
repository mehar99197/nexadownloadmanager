'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  signAccessToken, signAdminToken, signEmailToken, signResetToken, signLicenseToken,
  verifyAccess, verifyAdmin, verifyEmailToken, verifyResetToken, verifyLicense,
  resetTokenMatches,
} = require('../src/utils/jwt');

const user = { id: 42, email: 'user@example.test', role: 'user' };

test('accepts every token only for its intended purpose', () => {
  assert.equal(verifyAccess(signAccessToken(user)).typ, 'access');
  assert.equal(verifyAdmin(signAdminToken({ ...user, role: 'admin' })).typ, 'admin');
  assert.equal(verifyEmailToken(signEmailToken(user)).typ, 'verify-email');
  assert.equal(verifyResetToken(signResetToken(user)).typ, 'reset');
  assert.equal(verifyLicense(signLicenseToken({ sub: 'NDM-TEST-TEST-TEST' })).typ, 'license');
});

test('rejects cross-purpose tokens sharing the user JWT secret', () => {
  const access = signAccessToken(user);
  const verifyEmail = signEmailToken(user);
  const reset = signResetToken(user);

  assert.throws(() => verifyAccess(reset), /invalid token type/);
  assert.throws(() => verifyAccess(verifyEmail), /invalid token type/);
  assert.throws(() => verifyEmailToken(access), /invalid token type/);
  assert.throws(() => verifyEmailToken(reset), /invalid token type/);
  assert.throws(() => verifyResetToken(access), /invalid token type/);
  assert.throws(() => verifyResetToken(verifyEmail), /invalid token type/);
});

test('rejects tokens signed with another token-family secret', () => {
  assert.throws(() => verifyAccess(signAdminToken({ ...user, role: 'admin' })));
  assert.throws(() => verifyAccess(signLicenseToken({ sub: 'NDM-TEST-TEST-TEST' })));
});

// M-02: a reset link is bound to the password hash it was minted against, so
// spending it kills it immediately. jwt.verify cannot see that — only a
// comparison against the freshly loaded row can — which is why every case below
// goes through resetTokenMatches.
//
// Note what the binding does NOT do, because the route repeats the claim and
// getting it wrong is how a phantom guarantee spreads: sending a second reset
// email does not retire the first link. Both carry the same `pv`. What holds is
// that the batch is collectively single-use — see the last test below, and
// test/authResetBan.integration.test.js for the same property end to end.
const withPassword = { ...user, password_hash: '$2a$12$oldhasholdhasholdhasholdhash' };

test('a reset token matches the user it was minted for', () => {
  const payload = verifyResetToken(signResetToken(withPassword));
  assert.equal(resetTokenMatches(payload, withPassword), true);
});

test('a reset token stops matching once the password changes', () => {
  const payload = verifyResetToken(signResetToken(withPassword));
  const afterReset = { ...withPassword, password_hash: '$2a$12$newhashnewhashnewhashnewhash' };

  // Still a structurally valid, unexpired, correctly typed 'reset' token — the
  // whole point is that verification alone is no longer enough to accept it.
  assert.equal(verifyResetToken(signResetToken(withPassword)).typ, 'reset');
  assert.equal(resetTokenMatches(payload, afterReset), false);
});

test('a reset token is refused for a different account', () => {
  const payload = verifyResetToken(signResetToken(withPassword));
  assert.equal(resetTokenMatches(payload, { ...withPassword, id: 43 }), false);
});

test('a passwordless account can set its first password from a reset link', () => {
  // Google-created: password_hash is NULL and the reset link is the only way in.
  const google = { ...user, password_hash: null };
  const payload = verifyResetToken(signResetToken(google));
  assert.equal(resetTokenMatches(payload, google), true);

  // ...and that link dies the moment the first password lands, like any other.
  assert.equal(resetTokenMatches(payload, { ...google, password_hash: '$2a$12$firstpasswordfirstpassword' }), false);
});

test('outstanding links are interchangeable until one of them is spent', () => {
  // Two reset emails, requested minutes apart, neither used yet. They are the
  // same token as far as the binding is concerned, so the older one still
  // works — the newer email superseded nothing. This is asserted rather than
  // left implied: it is the half of M-02 the hash binding does not close.
  const first = verifyResetToken(signResetToken(withPassword));
  const second = verifyResetToken(signResetToken(withPassword));
  assert.equal(first.pv, second.pv);
  assert.equal(resetTokenMatches(first, withPassword), true);
  assert.equal(resetTokenMatches(second, withPassword), true);

  // ...and spending either one retires BOTH, which is the guarantee that makes
  // the interchangeability harmless: a batch of links is still one use in total.
  const afterReset = { ...withPassword, password_hash: '$2a$12$spentspentspentspentspent' };
  assert.equal(resetTokenMatches(first, afterReset), false);
  assert.equal(resetTokenMatches(second, afterReset), false);
});

test('a reset token minted before the binding existed never matches', () => {
  // No `pv` claim at all: an email in flight across the deploy is exactly the
  // unbounded link this binding exists to retire, so it is not grandfathered.
  assert.equal(resetTokenMatches({ sub: '42', typ: 'reset' }, withPassword), false);
});
