'use strict';

/**
 * TOTP (RFC 6238) for the control panels — no dependency, Node crypto only.
 *
 * The secret is stored encrypted (AES-256-GCM) so a database dump alone does
 * not let an attacker mint codes; the key is derived from TOTP_ENCRYPTION_KEY
 * (falls back to the admin JWT secret, which is already a deployment secret).
 * Recovery codes are stored as SHA-256 hashes, like refresh tokens.
 */

const crypto = require('crypto');
const config = require('../config/env');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;
const ISSUER = 'Nexa Admin';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh 160-bit secret, base32 (what authenticator apps expect). */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The code for a moment in time (defaults to now). */
function totpAt(secretBase32, when = Date.now()) {
  return hotp(secretBase32, Math.floor(when / 1000 / STEP_SECONDS));
}

/**
 * Constant-time check of a 6-digit code, accepting one step of clock drift
 * either way (the usual ±30 s allowance).
 */
function verifyTotp(secretBase32, code, { when = Date.now(), window = 1 } = {}) {
  const given = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(given)) return false;
  const counter = Math.floor(when / 1000 / STEP_SECONDS);
  for (let i = -window; i <= window; i += 1) {
    const expected = hotp(secretBase32, counter + i);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return true;
  }
  return false;
}

function otpauthUrl({ secret, account, issuer = ISSUER }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ------------------------------------------------------------ at rest */

function encryptionKey() {
  const material = config.TOTP_ENCRYPTION_KEY || config.JWT_ADMIN_SECRET;
  return crypto.createHash('sha256').update(String(material)).digest();
}

/** "iv.tag.ciphertext" (base64url) — opaque in the database. */
function encryptSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString('base64url')).join('.');
}

function decryptSecret(stored) {
  const parts = String(stored || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const [iv, tag, enc] = parts.map((p) => Buffer.from(p, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/* --------------------------------------------------------- recovery */

const RECOVERY_COUNT = 8;

function hashRecoveryCode(code) {
  const normalized = String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/** Eight one-time codes like "k7f3q-9x2mp"; only their hashes are stored. */
function generateRecoveryCodes() {
  const codes = [];
  for (let i = 0; i < RECOVERY_COUNT; i += 1) {
    const raw = crypto.randomBytes(8).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10)
      .padEnd(10, '0');
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

/**
 * Consume a recovery code: returns the remaining hashes when it matched, or
 * null when it did not. Each code works exactly once.
 */
function consumeRecoveryCode(hashes, code) {
  const list = Array.isArray(hashes) ? hashes : [];
  const target = hashRecoveryCode(code);
  const index = list.findIndex((h) => h.length === target.length
    && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(target)));
  if (index === -1) return null;
  return list.filter((_, i) => i !== index);
}

module.exports = {
  generateSecret, totpAt, verifyTotp, otpauthUrl,
  encryptSecret, decryptSecret,
  generateRecoveryCodes, consumeRecoveryCode, hashRecoveryCode,
  base32Encode, base32Decode, STEP_SECONDS, DIGITS, ISSUER, RECOVERY_COUNT,
};
