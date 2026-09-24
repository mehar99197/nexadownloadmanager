'use strict';

/**
 * The one projection of a users row that may leave the server.
 *
 * An ALLOW-list, on purpose. Every earlier shape of this — the three-column
 * strip in admin.js, its cousin in root.js, sanitizeUser in user.js, and then
 * the pattern-based stripSensitive() that replaced them — was a deny-list: it
 * named what to remove, and a column it did not know about went out by
 * default. That is how a staff admin came to read the creator's TOTP seed and
 * recovery codes from GET /admin/users/:id/details (AUDIT.md H-01), and how
 * google_id — Google's stable subject id for the account — still rode along
 * after the pattern strip. Here a column the table grows tomorrow is private
 * until somebody adds it to PUBLIC_FIELDS, and test/userView.test.js pins
 * that with a row carrying every column the table has.
 *
 * PUBLIC_FIELDS is exactly what the admin SPA and the site read (grep them for
 * `user.` before adding anything): identity, role, verified/banned flags, the
 * avatar, the trial flag, the second-factor switch and the timestamps. Two
 * booleans say whether a password / a Google account exist without shipping
 * either credential, and the timestamps are also given as the camelCase ISO
 * strings CONTRACT.md documents (the site reads `createdAt`).
 *
 * Not here, and never to be added: any `*_hash`, `totp_secret`,
 * `totp_recovery`, `token_version`, `google_id`, or the lockout bookkeeping
 * (`failed_logins`, `locked_until`, `lock_level`, `lock_notified_at`, and the
 * second-factor `totp_failures`, `totp_locked_until`, `totp_lock_level`) — the
 * sign-in form is deliberately told nothing about locks, so the profile must
 * not become the place that leaks from.
 */

const PUBLIC_FIELDS = Object.freeze([
  'id', 'name', 'email', 'role', 'email_verified', 'banned',
  'avatar_url', 'trial_used', 'totp_enabled', 'created_at', 'updated_at',
]);

function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function publicUser(user) {
  if (!user) return null;
  const view = {};
  for (const field of PUBLIC_FIELDS) {
    if (field in user) view[field] = user[field];
  }
  // Presence only, never the value. A Google-created account shows
  // "Set a password" instead of "Change password" on the strength of this.
  if ('password_hash' in user) view.hasPassword = Boolean(user.password_hash);
  if ('google_id' in user) view.hasGoogle = Boolean(user.google_id);
  if ('email_verified' in user) view.emailVerified = Boolean(user.email_verified);
  if ('created_at' in user) view.createdAt = toIso(user.created_at);
  if ('updated_at' in user) view.updatedAt = toIso(user.updated_at);
  return view;
}

module.exports = { publicUser, PUBLIC_FIELDS };
