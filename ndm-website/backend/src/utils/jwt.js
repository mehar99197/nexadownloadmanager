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

// A short fingerprint of the current password hash. Baked into every reset
// token so the token stops working the moment the password changes — a reset
// link is otherwise replayable for its whole hour, and anyone who saw it
// (mail forwarded, browser history, a shoulder) could reset the password a
// second time after the owner had already used it.
function passwordVersion(user) {
  return crypto.createHash('sha256')
    .update(String((user && user.password_hash) || ''))
    .digest('hex').slice(0, 16);
}

function signResetToken(user) {
  return jwt.sign(
    { sub: String(user.id), typ: 'reset', pv: passwordVersion(user) },
    config.JWT_SECRET, { expiresIn: '1h' }
  );
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
  passwordVersion,
  signAccessToken, signAdminToken, signRootToken, signEmailToken, signResetToken, signLicenseToken,
  verifyAccess, verifyAdmin, verifyRoot, verifyEmailToken, verifyResetToken, verifyLicense,
  generateRefreshToken, hashRefreshToken,
};
