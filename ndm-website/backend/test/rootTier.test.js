'use strict';

/**
 * The creator ("root") tier is what stops a staff admin from escalating, so its
 * two mechanisms are asserted directly here:
 *
 *   1. Token families are cryptographically separate — a staff token can never
 *      verify as a root token, whatever its payload claims.
 *   2. isRootUser requires the stored role AND the configured email to agree,
 *      so a database write alone cannot mint a creator.
 */

process.env.JWT_ADMIN_SECRET = 'test_admin_secret_value_long_enough_x2';
process.env.JWT_ROOT_SECRET = 'test_root_secret_value_long_enough_x9';
process.env.ROOT_ADMIN_EMAIL = 'Creator@Example.Test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { signAdminToken, signRootToken, verifyAdmin, verifyRoot } = require('../src/utils/jwt');
const { isRootUser } = require('../src/middleware/adminAuth');

const staff = { id: 7, email: 'staff@example.test', role: 'admin' };
const creator = { id: 1, email: 'creator@example.test', role: 'root' };
// The user_sessions row each token is bound to (H-08); only the id matters here.
const session = { id: 3 };

test('root and admin tokens are separate families', () => {
  assert.equal(verifyRoot(signRootToken(creator, session)).typ, 'root');
  assert.equal(verifyAdmin(signAdminToken(staff, session)).typ, 'admin');
});

test('a staff-admin token can never verify as a root token', () => {
  const adminToken = signAdminToken(staff, session);
  assert.throws(() => verifyRoot(adminToken));
});

test('a staff token claiming role=root still cannot verify as root', () => {
  // The role in the payload is decoration; the signing secret is the boundary.
  const forged = signAdminToken({ ...staff, role: 'root' }, session);
  assert.throws(() => verifyRoot(forged));
});

test('a root token cannot verify as an admin token', () => {
  assert.throws(() => verifyAdmin(signRootToken(creator, session)));
});

test('isRootUser requires BOTH the stored role and the configured email', () => {
  assert.equal(isRootUser(creator), true);

  // Right email, wrong role — a plain user row cannot claim the creator address.
  assert.equal(isRootUser({ ...creator, role: 'admin' }), false);
  assert.equal(isRootUser({ ...creator, role: 'user' }), false);

  // Right role, wrong email — this is the case a rogue UPDATE would produce.
  assert.equal(isRootUser({ ...creator, email: 'attacker@example.test' }), false);

  assert.equal(isRootUser(null), false);
  assert.equal(isRootUser(undefined), false);
  assert.equal(isRootUser({}), false);
});

test('the configured creator email is matched case-insensitively', () => {
  // ROOT_ADMIN_EMAIL is set with mixed case above; config lowercases it, and
  // the comparison lowercases the stored address.
  assert.equal(isRootUser({ ...creator, email: 'CREATOR@EXAMPLE.TEST' }), true);
});
