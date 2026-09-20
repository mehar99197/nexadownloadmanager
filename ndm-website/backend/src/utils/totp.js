'use strict';

/**
 * TOTP (RFC 6238) for the control panels — no dependency, Node crypto only.
 *
 * The secret is stored encrypted (AES-256-GCM) so a database dump alone does
 * not let an attacker mint codes; the key is derived from TOTP_ENCRYPTION_KEY
 * (falls back to the admin JWT secret, which is already a deployment secret).
 * Recovery codes are stored as bcrypt hashes, like passwords: they are the one
 * credential here that a database dump would otherwise let an attacker grind
 * through offline. Rows enrolled before that change hold SHA-256; those still
 * verify until routes/twoFactor.js retires them (see consumeRecoveryCode).
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

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
 * either way (the usual ±30 s allowance), reporting WHICH step matched:
 * { ok:true, step } or { ok:false, step:null }. The caller remembers the step
 * so the same code cannot be spent twice — accepting ±1 step otherwise leaves
 * a code live for up to 90 seconds, which is long enough to replay one read
 * over a shoulder or captured by a phishing page (see routes/twoFactor.js).
 *
 * The window is walked oldest first and the first match wins, so if two
 * neighbouring steps happened to produce the same six digits (one chance in a
 * million) the OLDER step is reported — the answer a replay guard refuses
 * rather than the one it waves through.
 */
function verifyTotpStep(secretBase32, code, { when = Date.now(), window = 1 } = {}) {
  const given = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(given)) return { ok: false, step: null };
  const counter = Math.floor(when / 1000 / STEP_SECONDS);
  for (let i = -window; i <= window; i += 1) {
    const expected = hotp(secretBase32, counter + i);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given)))
      return { ok: true, step: counter + i };
  }
  return { ok: false, step: null };
}

/** The boolean form, for callers with no step to remember. */
function verifyTotp(secretBase32, code, opts) {
  return verifyTotpStep(secretBase32, code, opts).ok;
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
const RECOVERY_LENGTH = 10;
// Lower-case letters and digits: what a person reads off a printout and types
// back without wondering about case. Ten independent uniform picks from 36
// symbols carry log2(36^10) ≈ 51.7 bits — the full entropy of a code this shape.
const RECOVERY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
// Passwords use cost 12; recovery codes get 10 — the OWASP floor, and plenty
// for ~52 random bits that no dictionary helps with. The price is paid on a
// WRONG code, which bcrypt-compares against every stored entry in series:
// 0.1–0.2 s each on the machines measured, so one bad attempt costs the event
// loop 1–2 s. That is bounded rather than free — twoFactorLimiter allows ten
// attempts per address per quarter hour, and consumeRecoveryCode refuses
// anything that is not code-shaped before paying a single compare.
const RECOVERY_BCRYPT_COST = 10;
// Rows enrolled before recovery codes moved to bcrypt hold bare SHA-256 hex.
// bcrypt output always starts with "$2", so the two shapes cannot be confused.
// Legacy entries verify until routes/twoFactor.js retires them (the account's
// next authenticator sign-in, or a regenerate); this branch can go once no
// staff row holds one.
const LEGACY_SHA256_HEX = /^[0-9a-f]{64}$/;
// Exactly what bcryptjs parses: "$2", a revision letter, "$", a two-digit
// cost, "$", then 22 salt + 31 digest characters in bcrypt's own base64
// alphabet — 60 characters. Anything else in the column is corruption.
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/** Dashes, spaces and case are for humans; only the alphanumerics are the code. */
function normalizeRecoveryCode(code) {
  return String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** One plaintext code like "k7f3q-9x2mp". */
function randomRecoveryCode() {
  // One crypto.randomInt per character: uniform over the alphabet, with the
  // rejection sampling done inside Node, so there is no modulo bias to reason
  // about. The previous generator lower-cased base64url output instead, which
  // folded A-Z onto a-z and silently threw away a chunk of the 64 bits it
  // started from.
  let raw = '';
  for (let i = 0; i < RECOVERY_LENGTH; i += 1) {
    raw += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
  }
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** bcrypt hash of the normalised code — the only form that reaches the database. */
async function hashRecoveryCode(code) {
  return bcrypt.hash(normalizeRecoveryCode(code), RECOVERY_BCRYPT_COST);
}

/** Eight one-time codes; the caller shows `codes` once and stores `hashes`. */
async function generateRecoveryCodes() {
  const codes = Array.from({ length: RECOVERY_COUNT }, () => randomRecoveryCode());
  const hashes = await Promise.all(codes.map((code) => hashRecoveryCode(code)));
  return { codes, hashes };
}

/** Does one stored entry match the normalised code? Never throws on odd data. */
async function recoveryEntryMatches(entry, normalized) {
  const stored = typeof entry === 'string' ? entry : '';
  if (LEGACY_SHA256_HEX.test(stored)) {
    const digest = crypto.createHash('sha256').update(normalized).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(digest));
  }
  // A corrupted entry must fail itself — not the whole login request, and not
  // the valid entries after it. The shape check is the cheap part; the
  // try/catch is the guarantee, because bcryptjs reports a hash it cannot
  // parse by rejecting rather than returning false, and a 60-character entry
  // that starts with "$2" but carries a bad revision, cost or salt gets past
  // its own length check and throws from inside compare.
  if (!BCRYPT_HASH.test(stored)) return false;
  try {
    return await bcrypt.compare(normalized, stored);
  } catch {
    return false;
  }
}

/** Is this stored entry a pre-bcrypt SHA-256 one? routes/twoFactor.js retires those. */
function isLegacyRecoveryHash(entry) {
  return typeof entry === 'string' && LEGACY_SHA256_HEX.test(entry);
}

/**
 * Consume a recovery code: resolves to the remaining hashes when it matched,
 * or null when it did not. Each code works exactly once.
 */
async function consumeRecoveryCode(hashes, code) {
  const list = Array.isArray(hashes) ? hashes : [];
  const normalized = normalizeRecoveryCode(code);
  // Every code ever issued normalises to exactly RECOVERY_LENGTH characters
  // (the legacy generator padded to it too), so anything else — typically a
  // mistyped 6-digit TOTP that fell through to here — cannot match and is not
  // worth RECOVERY_COUNT bcrypt compares.
  if (normalized.length !== RECOVERY_LENGTH) return null;
  for (let i = 0; i < list.length; i += 1) {
    // Sequential on purpose: stop at the first match rather than pay for all
    // eight compares on every successful recovery login.
    if (await recoveryEntryMatches(list[i], normalized)) return list.filter((_, j) => j !== i);
  }
  return null;
}

module.exports = {
  generateSecret, totpAt, verifyTotp, verifyTotpStep, otpauthUrl,
  encryptSecret, decryptSecret,
  generateRecoveryCodes, consumeRecoveryCode, hashRecoveryCode, randomRecoveryCode, isLegacyRecoveryHash,
  base32Encode, base32Decode, STEP_SECONDS, DIGITS, ISSUER, RECOVERY_COUNT,
};
