'use strict';

/**
 * One place that decides which columns of a `users` row may leave the server.
 *
 * There used to be three copies of this — routes/admin.js, routes/root.js and
 * routes/user.js — each destructuring away the fields whoever wrote it happened
 * to remember. They had drifted: the admin copy stripped three hashes, so
 * `GET /api/admin/users/:id/details` (which reads a row with `SELECT *`) handed
 * a staff admin the *creator's* `totp_secret`, `totp_recovery` and
 * `root_refresh_token_hash`. The recovery codes are plain SHA-256 of a 10-char
 * alphanumeric, i.e. offline-crackable, so that single omission was a path from
 * staff to creator.
 *
 * A denylist is the wrong default for that reason: it fails open every time a
 * sensitive column is added. So this does both.
 *
 *  - `SENSITIVE_USER_FIELDS` names what we know about today.
 *  - `SENSITIVE_KEY_PATTERN` catches the naming conventions those follow, so a
 *    column added later (`webauthn_secret`, `sms_backup_hash`, …) is stripped
 *    before anyone remembers this file exists.
 *
 * Rows here are not always plain `users` rows — several queries join a plan or
 * a subscription onto them — which is why this stays a filter rather than an
 * allowlist that would silently drop those joined columns.
 */

const SENSITIVE_USER_FIELDS = [
  'password_hash',
  'refresh_token_hash',
  'admin_refresh_token_hash',
  'root_refresh_token_hash',
  'totp_secret',
  'totp_recovery',
  'totp_last_step',
  'token_version',
];

// Deliberately does NOT match `license_key`: a licence key is the customer's
// own property and both panels display it. It is not a server-side credential.
const SENSITIVE_KEY_PATTERN = /(password|secret|recovery|_hash$|token_version)/i;

function isSensitiveKey(key) {
  return SENSITIVE_USER_FIELDS.includes(key) || SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * Copy a row without any field that is a server-side credential.
 * Returns null for a null row so call sites can pass through a missing user.
 */
function stripSensitive(row) {
  if (!row) return null;
  const safe = {};
  for (const key of Object.keys(row)) {
    if (!isSensitiveKey(key)) safe[key] = row[key];
  }
  return safe;
}

module.exports = { stripSensitive, isSensitiveKey, SENSITIVE_USER_FIELDS, SENSITIVE_KEY_PATTERN };
