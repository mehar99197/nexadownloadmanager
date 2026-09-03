'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const licenseKeys = require('../config/licenseKeys');
const ed25519Jwt = require('./ed25519Jwt');

function basePayload(user) {
  return {
    sub: String(user.id),
    email: user.email,
    role: user.role,
    // Session generation — see User.revokeSessions. A token whose `tv` no
    // longer matches the stored users.token_version is refused by
    // middleware/auth.js, which is what makes a password change, a reset or an
    // admin revocation take effect immediately instead of in up to seven days.
    tv: Number(user.token_version) || 0,
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

// Carries the session generation so the link is SINGLE USE: completing a reset
// bumps token_version, which makes this token — and any other reset link
// outstanding for the account — stop verifying. Without it a reset link stayed
// usable for its full hour, so anyone who read the mail once could keep
// changing the password after the owner had already used it.
function signResetToken(user) {
  return jwt.sign(
    { sub: String(user.id), typ: 'reset', tv: Number(user.token_version) || 0 },
    config.JWT_SECRET, { expiresIn: '1h' }
  );
}

// Licence tokens are the one family the desktop app verifies for itself, so
// they are signed with Ed25519 rather than an HMAC secret: the app ships the
// public key, which cannot mint a licence. See config/licenseKeys.js, and
// utils/ed25519Jwt.js for why this does not go through `jsonwebtoken`.
// Matches SEAT_LEASE_SECONDS deliberately: the token represents a held seat, so
// it should not outlive one. The desktop app beats every 5 minutes and gets a
// fresh token each time, giving three beats of slack before a token lapses —
// the same tolerance the lease itself has for a flaky connection.
//
// It was 24 hours, which meant a token captured from a revoked licence stayed
// usable on plan-gated endpoints for a day. Shortening it was only possible
// once /heartbeat started re-issuing tokens; without that the client, which
// re-validates every six hours, would have spent most of its time holding an
// expired one.
const LICENSE_TOKEN_TTL_SECONDS = 15 * 60;

function signLicenseToken(payload) {
  return ed25519Jwt.sign({ ...payload, typ: 'license' },
    licenseKeys.privateKey, LICENSE_TOKEN_TTL_SECONDS);
}

function verifyTyped(token, secret, type) {
  const payload = jwt.verify(token, secret);
  if (!payload || payload.typ !== type)
    throw new jwt.JsonWebTokenError('invalid token type');
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

// The licence public key is embedded in every copy of the desktop app, so it is
// public knowledge. That is safe only because verification accepts exactly one
// algorithm — see the header comment in utils/ed25519Jwt.js. A verifier that
// also accepted HS256 would let anyone sign a token using those published key
// bytes as the HMAC secret.
function verifyLicense(token) {
  const payload = ed25519Jwt.verify(token, licenseKeys.publicKey);
  if (!payload || payload.typ !== 'license')
    throw new jwt.JsonWebTokenError('invalid token type');
  return payload;
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
  generateRefreshToken, hashRefreshToken,
};
