'use strict';

/**
 * publicUser is the only projection of a users row that reaches a client, so
 * this pins both halves of the contract: every secret column stays behind and
 * every field the admin SPA and the site read survives. The fake row carries
 * EVERY column of the users table (the CREATE TABLE in config/schema.js plus
 * the later addColumnIfMissing calls) with sentinel values, so a leak shows up
 * as a recognisable string rather than a vague mismatch.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { publicUser, PUBLIC_FIELDS } = require('../src/utils/userView');

const SECRET_COLUMNS = [
  'password_hash', 'refresh_token_hash', 'admin_refresh_token_hash',
  'root_refresh_token_hash', 'totp_secret', 'totp_recovery', 'google_id',
  'token_version', 'totp_last_step',
  'failed_logins', 'locked_until', 'lock_level', 'lock_notified_at',
];

const fullRow = Object.freeze({
  id: 42,
  name: 'Ada Lovelace',
  email: 'ada@example.test',
  password_hash: 'SENTINEL_password_hash',
  role: 'root',
  email_verified: 1,
  banned: 0,
  google_id: 'SENTINEL_google_id',
  avatar_url: 'https://cdn.example.test/ada.png',
  refresh_token_hash: 'SENTINEL_refresh_token_hash',
  admin_refresh_token_hash: 'SENTINEL_admin_refresh_token_hash',
  root_refresh_token_hash: 'SENTINEL_root_refresh_token_hash',
  trial_used: 1,
  token_version: 7,
  created_at: new Date('2024-01-02T03:04:05Z'),
  updated_at: new Date('2024-06-07T08:09:10Z'),
  totp_secret: 'SENTINEL_totp_secret',
  totp_enabled: 1,
  totp_recovery: '["SENTINEL_totp_recovery"]',
  totp_last_step: 59876543,
  failed_logins: 3,
  locked_until: new Date('2024-06-07T09:00:00Z'),
  lock_level: 2,
  lock_notified_at: new Date('2024-06-07T08:30:00Z'),
});

test('no credential, second-factor or lockout column survives the projection', () => {
  const view = publicUser(fullRow);
  for (const column of SECRET_COLUMNS)
    assert.equal(column in view, false, `${column} must not leave the server`);
  // Whatever the allow-list becomes, a sentinel must not be reachable through
  // any key, and no key may look like a hash column.
  assert.doesNotMatch(JSON.stringify(view), /SENTINEL_/);
  for (const key of Object.keys(view)) assert.doesNotMatch(key, /_hash$|^lock|^failed|version$/);
});

test('the allow-list itself never names a secret column', () => {
  for (const field of PUBLIC_FIELDS) {
    assert.doesNotMatch(field, /_hash$/);
    assert.equal(SECRET_COLUMNS.includes(field), false, `${field} is a secret column`);
  }
});

test('every field the UIs read survives with its value', () => {
  assert.deepEqual(publicUser(fullRow), {
    id: 42,
    name: 'Ada Lovelace',
    email: 'ada@example.test',
    role: 'root',
    email_verified: 1,
    banned: 0,
    avatar_url: 'https://cdn.example.test/ada.png',
    trial_used: 1,
    totp_enabled: 1,
    created_at: fullRow.created_at,
    updated_at: fullRow.updated_at,
    hasPassword: true,
    hasGoogle: true,
    emailVerified: true,
    createdAt: '2024-01-02T03:04:05.000Z',
    updatedAt: '2024-06-07T08:09:10.000Z',
  });
});

test('a column added to the table later is private by default', () => {
  const view = publicUser({ ...fullRow, future_column: 'SENTINEL_future' });
  assert.equal('future_column' in view, false);
});

test('hasPassword and hasGoogle derive from the columns without exposing them', () => {
  assert.equal(publicUser(fullRow).hasPassword, true);
  assert.equal(publicUser(fullRow).hasGoogle, true);
  // A Google-created account has no password yet; a classic account has no
  // Google identity. Both columns are NULL in the database for that case.
  const googleOnly = publicUser({ ...fullRow, password_hash: null });
  assert.equal(googleOnly.hasPassword, false);
  assert.equal(googleOnly.hasGoogle, true);
  const passwordOnly = publicUser({ ...fullRow, google_id: null });
  assert.equal(passwordOnly.hasPassword, true);
  assert.equal(passwordOnly.hasGoogle, false);
});

test('a narrow row (User.list / listStaff shape) does not invent the booleans', () => {
  // These queries never select password_hash or google_id, so the projection
  // must not claim "no password" about an account it knows nothing about.
  const view = publicUser({
    id: 7, name: 'Staff', email: 'staff@example.test', role: 'admin',
    email_verified: 1, banned: 0, totp_enabled: 0,
    created_at: fullRow.created_at, updated_at: fullRow.updated_at,
  });
  assert.equal('hasPassword' in view, false);
  assert.equal('hasGoogle' in view, false);
  assert.equal('avatar_url' in view, false);
  assert.equal(view.totp_enabled, 0);
});

test('the camelCase timestamps are ISO strings, or null when the column is empty', () => {
  assert.equal(publicUser({ ...fullRow, created_at: null }).createdAt, null);
  assert.equal(publicUser({ ...fullRow, updated_at: 'not a date' }).updatedAt, null);
  assert.equal(publicUser({ ...fullRow, created_at: '2024-01-02 03:04:05' }).createdAt, new Date('2024-01-02 03:04:05').toISOString());
});

test('null and undefined input project to null', () => {
  assert.equal(publicUser(null), null);
  assert.equal(publicUser(undefined), null);
});
