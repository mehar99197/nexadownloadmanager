'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config/env');

function basePayload(user) {
  return {
    sub: String(user.id),
    email: user.email,
    role: user.role,
  };
}

function signAccessToken(user) {
  return jwt.sign({ ...basePayload(user), typ: 'access' }, config.JWT_SECRET, { expiresIn: '7d' });
}

function signAdminToken(user) {
  return jwt.sign({ ...basePayload(user), typ: 'admin' }, config.JWT_ADMIN_SECRET, { expiresIn: '8h' });
}

// Root/creator sessions are a distinct token family signed with their own
// secret, and expire sooner than the 8h staff session.
function signRootToken(user) {
  return jwt.sign({ ...basePayload(user), typ: 'root' }, config.JWT_ROOT_SECRET, { expiresIn: '4h' });
}

function signEmailToken(user) {
  return jwt.sign({ sub: String(user.id), typ: 'verify-email' }, config.JWT_SECRET, { expiresIn: '1h' });
}

// A reset link must die the moment it is spent — not an hour later. Binding the
// token to a value derived from the password hash it was minted against does
// that with no new column and no nonce table: the reset itself rewrites
// password_hash, so the link just used, and every older reset email still
// sitting in the inbox, stop matching in the same instant.
//
// What it does NOT do is retire an older link when a newer email is sent. Two
// links minted while the password is unchanged carry the same `pv` and are
// interchangeable, because the binding is to the hash and sending an email
// moves nothing. The guarantee is that the batch is collectively single-use:
// whichever link is spent first kills every other one still in the inbox.
// Superseding on send would need per-user state that changes on send (a
// token-version column); this deliberately does not claim to provide it.
//
// Only a prefix of the digest travels in the token. It is compared against the
// live row, never reversed, so 64 bits is plenty — and the real hash never
// leaves the database in something that is mailed as a URL.
function passwordVersion(user) {
  // password_hash is NULL on a Google-created account that has never set one.
  // Those accounts reach their first password THROUGH a reset link, so null
  // must fold to a stable value rather than be refused; setting the password
  // then moves the account off that value and kills the link like any other.
  return crypto.createHash('sha256').update(user?.password_hash || '').digest('hex').slice(0, 16);
}

function signResetToken(user) {
  return jwt.sign(
    { sub: String(user.id), typ: 'reset', pv: passwordVersion(user) },
    config.JWT_SECRET, { expiresIn: '1h' }
  );
}

// jwt.verify can only prove we minted the token and that it has not expired; it
// cannot know today's password hash. So the binding is checked here, against
// the freshly loaded row, and the route calls it immediately after the lookup.
// Exported as one function precisely so a caller cannot half-remember the rule:
// there is nothing to reimplement at the call site.
//
// It answers for the instant it is called and nothing more. A caller that does
// slow work between this check and the write it guards — bcrypt at cost 12 is
// ~300 ms — leaves a window in which a second request presenting the SAME link
// passes the same check, so the write itself has to re-assert the binding. See
// the conditional UPDATE in routes/auth.js.
//
// A token minted before this claim existed carries no `pv` and therefore never
// matches — deliberately. Reset emails in flight across the deploy expire early
// and the user asks for a new one; the alternative is honouring exactly the
// unbounded links this exists to kill.
function resetTokenMatches(payload, user) {
  if (!payload || !user) return false;
  if (String(payload.sub) !== String(user.id)) return false;
  return payload.pv === passwordVersion(user);
}

function signLicenseToken(payload) {
  return jwt.sign({ ...payload, typ: 'license' }, config.LICENSE_JWT_SECRET, { expiresIn: '24h' });
}

function verifyTyped(token, secret, type) {
  // SECURITY: ALWAYS verify token type to prevent token confusion attacks.
  // An access token must never be accepted where a reset token is expected.
  const payload = jwt.verify(token, secret);
  if (!payload || payload.typ !== type) {
    throw new jwt.JsonWebTokenError(`invalid token type: expected '${type}', got '${payload?.typ || 'none'}'`);
  }
  return payload;
}

function verifyAccess(token) {
  return verifyTyped(token, config.JWT_SECRET, 'access');
}

function verifyAdmin(token) {
  return verifyTyped(token, config.JWT_ADMIN_SECRET, 'admin');
}

function verifyRoot(token) {
  return verifyTyped(token, config.JWT_ROOT_SECRET, 'root');
}

function verifyEmailToken(token) {
  return verifyTyped(token, config.JWT_SECRET, 'verify-email');
}

function verifyResetToken(token) {
  return verifyTyped(token, config.JWT_SECRET, 'reset');
}

function verifyLicense(token) {
  return verifyTyped(token, config.LICENSE_JWT_SECRET, 'license');
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function generateRefreshToken() {
  const token = crypto.randomBytes(48).toString('hex');
  return { token, hash: hashRefreshToken(token) };
}

module.exports = {
  signAccessToken, signAdminToken, signRootToken, signEmailToken, signResetToken, signLicenseToken,
  verifyAccess, verifyAdmin, verifyRoot, verifyEmailToken, verifyResetToken, verifyLicense,
  resetTokenMatches,
  generateRefreshToken, hashRefreshToken,
};
