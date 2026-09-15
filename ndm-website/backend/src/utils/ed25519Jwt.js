'use strict';

// A deliberately tiny, single-algorithm JWT implementation for licence tokens.
//
// Why not jsonwebtoken: it does not support EdDSA (its algorithm enum stops at
// ES512/HS512), and Ed25519 is the algorithm that makes the desktop client's
// verifier simple enough to trust — one OpenSSL call, no hashing step, no DER
// signature unpacking. Getting an ECDSA raw-vs-DER conversion subtly wrong in
// C++ is a far more likely bug than anything in the 40 lines below.
//
// The dangerous parts of JWT are all in *verification*, and every one of them
// comes from flexibility this module does not have:
//   * `alg: none`            — rejected: alg must be exactly 'EdDSA'.
//   * algorithm confusion    — impossible: there is one code path, and it is
//                              Ed25519 public-key verification. The key is
//                              never used as an HMAC secret because HMAC is
//                              not implemented here at all.
//   * key confusion / `jku`  — the key is a module argument, never read from
//                              the token.
//   * unsigned tamper        — the signature covers the exact received bytes.

const crypto = require('crypto');

const ALG = 'EdDSA';
const ED25519_SIGNATURE_BYTES = 64;

function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

function encodeJson(value) {
  return b64u(JSON.stringify(value));
}

/**
 * Sign `claims` as an Ed25519 JWT.
 * @param {object} claims       payload claims; `exp`/`iat` are added here
 * @param {crypto.KeyObject} privateKey  Ed25519 private key
 * @param {number} ttlSeconds   lifetime; becomes `exp`
 */
function sign(claims, privateKey, ttlSeconds) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = { alg: ALG, typ: 'JWT' };
  const payload = { ...claims, iat: issuedAt, exp: issuedAt + ttlSeconds };
  const signingInput = `${encodeJson(header)}.${encodeJson(payload)}`;
  // `null` digest is correct for Ed25519: it hashes internally (PureEdDSA).
  const signature = crypto.sign(null, Buffer.from(signingInput, 'ascii'), privateKey);
  return `${signingInput}.${b64u(signature)}`;
}

/**
 * Verify an Ed25519 JWT and return its claims.
 * Throws on any failure — callers treat a throw as "not entitled".
 *
 * @param {string} token
 * @param {crypto.KeyObject} publicKey  Ed25519 public key
 * @param {number} clockToleranceSeconds  slack for a skewed client clock
 */
function verify(token, publicKey, { clockToleranceSeconds = 60 } = {}) {
  if (typeof token !== 'string')
    throw new Error('token must be a string');

  const parts = token.split('.');
  if (parts.length !== 3)
    throw new Error('malformed token');
  const [headerB64, payloadB64, signatureB64] = parts;
  if (!headerB64 || !payloadB64 || !signatureB64)
    throw new Error('malformed token');

  let header;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  } catch {
    throw new Error('malformed header');
  }
  // The single most important line in this file.
  if (!header || header.alg !== ALG)
    throw new Error(`unexpected algorithm ${header && header.alg}`);

  const signature = Buffer.from(signatureB64, 'base64url');
  if (signature.length !== ED25519_SIGNATURE_BYTES)
    throw new Error('bad signature length');

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'ascii');
  if (!crypto.verify(null, signingInput, publicKey, signature))
    throw new Error('signature does not verify');

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new Error('malformed payload');
  }
  if (!payload || typeof payload !== 'object')
    throw new Error('malformed payload');

  // An unexpiring licence token is not something this system ever issues, so a
  // token without `exp` is treated as forged rather than as eternal.
  if (typeof payload.exp !== 'number')
    throw new Error('missing exp');
  const now = Math.floor(Date.now() / 1000);
  if (now > payload.exp + clockToleranceSeconds)
    throw new Error('token expired');

  return payload;
}

module.exports = { sign, verify, ALG };
