'use strict';

/**
 * The one projection of a `users` row that may leave the server.
 *
 * This is an ALLOW-list on purpose. Every reader of a user row
 * (User.findById, findByEmail, the session lookups) is SELECT *, so a
 * deny-list — "strip password_hash and the refresh hashes" — is only ever as
 * complete as the last person who remembered to extend it. It silently
 * re-opened the moment totp_secret / totp_recovery were added to the table,
 * and the three copies of it (admin, root and user routes) had drifted three
 * different ways. With an allow-list a new column is private by default and
 * stays private until someone deliberately adds it below.
 *
 * The fields are what the admin SPA and the site actually read (grepped):
 * id, name, email, role, banned, email_verified, created_at, updated_at,
 * totp_enabled, avatar_url, trial_used. Never add anything ending in _hash,
 * nor totp_secret / totp_recovery, nor google_id — the site only needs to
 * know whether a Google identity is linked, which leaves as the boolean
 * hasGoogle.
 */
const PUBLIC_FIELDS = Object.freeze([
  'id', 'name', 'email', 'role', 'email_verified', 'banned',
  'avatar_url', 'trial_used', 'totp_enabled', 'created_at', 'updated_at',
]);

function publicUser(user) {
  if (!user) return null;
  const view = {};
  // Copy only what the row carries: User.list / listStaff select a narrower
  // column set than findById, and an absent column must stay absent rather
  // than turn into an `undefined` key.
  for (const field of PUBLIC_FIELDS) if (field in user) view[field] = user[field];
  // The site needs to know whether password sign-in is available for this
  // account without ever seeing the hash: a Google-created account shows
  // "Set a password" instead of "Change password". Both booleans are derived
  // only when the row fetched the column, so a narrow SELECT is never
  // reported as "this account has no password".
  if ('password_hash' in user) view.hasPassword = Boolean(user.password_hash);
  if ('google_id' in user) view.hasGoogle = Boolean(user.google_id);
  return view;
}

module.exports = { publicUser, PUBLIC_FIELDS };
