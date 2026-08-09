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

function signEmailToken(user) {
  return jwt.sign({ sub: String(user.id), typ: 'verify-email' }, config.JWT_SECRET, { expiresIn: '1h' });
}

function signResetToken(user) {
  return jwt.sign({ sub: String(user.id), typ: 'reset' }, config.JWT_SECRET, { expiresIn: '1h' });
}

function signLicenseToken(payload) {
  return jwt.sign({ ...payload, typ: 'license' }, config.LICENSE_JWT_SECRET, { expiresIn: '24h' });
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
  signAccessToken, signAdminToken, signEmailToken, signResetToken, signLicenseToken,
  verifyAccess, verifyAdmin, verifyEmailToken, verifyResetToken, verifyLicense,
  generateRefreshToken, hashRefreshToken,
};
