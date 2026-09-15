'use strict';

/**
 * The single filter every user row leaves through.
 *
 * There used to be three copies of this rule, and the one in routes/admin.js
 * had drifted: it stripped three password/refresh hashes and nothing else, so
 * GET /api/admin/users/:id/details — which reads the row with SELECT * — handed
 * a staff admin the creator's TOTP seed, the SHA-256 hashes of the creator's
 * recovery codes and the root refresh hash. That is a route from staff to
 * creator, not a cosmetic leak.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripSensitive, isSensitiveKey } = require('../src/utils/sanitize');

test('every known credential column is removed', () => {
  const row = {
    id: 7,
    name: 'Owner',
    email: 'owner@example.test',
    role: 'root',
    email_verified: 1,
    banned: 0,
    created_at: '2026-01-01',
    password_hash: '$2a$12$x',
    refresh_token_hash: 'aaa',
    admin_refresh_token_hash: 'bbb',
    root_refresh_token_hash: 'ccc',
    totp_secret: 'JBSWY3DPEHPK3PXP',
    totp_recovery: '["deadbeef"]',
    totp_last_step: 58_000_000,
    token_version: 4,
  };
  const safe = stripSensitive(row);

  assert.deepEqual(Object.keys(safe).sort(),
    ['banned', 'created_at', 'email', 'email_verified', 'id', 'name', 'role']);
  // Spelled out, because each of these was individually reachable before.
  for (const gone of ['password_hash', 'refresh_token_hash', 'admin_refresh_token_hash',
    'root_refresh_token_hash', 'totp_secret', 'totp_recovery', 'totp_last_step', 'token_version'])
    assert.equal(gone in safe, false, gone);
});

test('a credential column nobody has added yet is still caught', () => {
  // The reason this is a pattern and not only a list: the list is exactly what
  // failed. Anything named like a secret goes, whether or not this file knows
  // about it.
  for (const key of ['webauthn_secret', 'sms_backup_hash', 'recovery_codes',
    'api_secret', 'PASSWORD_HASH', 'session_token_version'])
    assert.equal(isSensitiveKey(key), true, key);
});

test('a licence key is not a server credential and must survive', () => {
  // Deliberately not stripped: it is the customer's own property, both panels
  // display it, and the user's dashboard is where they copy it from.
  const safe = stripSensitive({ license_key: 'NDM-AAAA-BBBB-CCCC', plan: 'pro', seats: 3 });
  assert.equal(safe.license_key, 'NDM-AAAA-BBBB-CCCC');
  assert.equal(safe.plan, 'pro');
  assert.equal(safe.seats, 3);
});

test('joined columns pass through, so this can stay a filter', () => {
  // The admin listing joins a plan onto each user; an allowlist would drop it.
  const safe = stripSensitive({ id: 1, email: 'a@b.test', plan: 'team', subscription: { id: 9 } });
  assert.equal(safe.plan, 'team');
  assert.deepEqual(safe.subscription, { id: 9 });
});

test('a missing row stays missing rather than becoming an empty object', () => {
  assert.equal(stripSensitive(null), null);
  assert.equal(stripSensitive(undefined), null);
});
