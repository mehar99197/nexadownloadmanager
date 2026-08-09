'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  signAccessToken, signAdminToken, signEmailToken, signResetToken, signLicenseToken,
  verifyAccess, verifyAdmin, verifyEmailToken, verifyResetToken, verifyLicense,
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