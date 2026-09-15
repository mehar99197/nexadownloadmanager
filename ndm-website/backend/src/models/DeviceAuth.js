'use strict';

/**
 * Desktop-app account sign-in: device codes and device tokens.
 *
 * The shape is OAuth 2.0 device authorization (RFC 8628), sized for an app on
 * a machine that has a browser next to it:
 *
 *   1. the app asks for a code             → { deviceCode, userCode }   (createCode)
 *   2. the person approves it on the site  → status 'approved'          (approve)
 *   3. the app polls with deviceCode       → a device token, once       (consume)
 *   4. the app validates with that token   → the account's plan         (findLiveToken)
 *
 * Two secrets, two audiences. `deviceCode` is high-entropy and never leaves
 * the machine that asked for it; `userCode` is eight unambiguous characters
 * a person can read off one screen and type into another. Only hashes of the
 * device code and of the device token are stored, so a database read yields
 * nothing usable. The device token is bound to the fingerprint the code was
 * requested with — a token copied to another machine fails there and is
 * revoked (routes/license.js), so unlike a licence key it cannot be shared.
 */

const crypto = require('crypto');
const { query, queryOne, insert, execute } = require('../config/db');

const CODE_TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_SECONDS = 5;
// No 0/O, 1/I/L, 5/S, 8/B: a code read aloud or squinted at must not have two
// plausible spellings.
const USER_CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXYZ234679';
const TOKEN_PREFIX = 'ndt_';

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

function randomUserCode() {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** "abcd1234", "ABCD-1234", " abcd 1234 " → "ABCD-1234"; null when it is not a code. */
function normaliseUserCode(value) {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length !== 8) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function isDeviceToken(value) {
  return typeof value === 'string' && /^ndt_[A-Za-z0-9_-]{43}$/.test(value);
}

const DeviceAuth = {
  CODE_TTL_MS,
  POLL_INTERVAL_SECONDS,
  normaliseUserCode,
  isDeviceToken,
  hashToken: sha256,

  /** Start a sign-in attempt. Returns the secrets ONCE; only hashes are stored. */
  async createCode({ deviceFingerprint, deviceName = null, appVersion = null, ip = null }) {
    const deviceCode = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    // The user code is 27^8 ≈ 2.8e11 possibilities against a ten-minute
    // window and a rate-limited approve endpoint, so a collision with a live
    // code is the only realistic conflict — retry on the unique index.
    for (let attempt = 0; attempt < 5; attempt++) {
      const userCode = randomUserCode();
      try {
        const id = await insert(
          `INSERT INTO device_codes
             (device_code_hash, user_code, device_fingerprint, device_name, app_version, ip, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [sha256(deviceCode), userCode, deviceFingerprint, deviceName, appVersion, ip, expiresAt]
        );
        return { id, deviceCode, userCode, expiresAt };
      } catch (err) {
        if (!(err && err.code === 'ER_DUP_ENTRY')) throw err;
      }
    }
    throw new Error('could not allocate a device code');
  },

  /** The pending attempt behind a user code, for the approval page. Null when none/expired. */
  async findPendingByUserCode(userCode) {
    const code = normaliseUserCode(userCode);
    if (!code) return null;
    return queryOne(
      `SELECT * FROM device_codes
        WHERE user_code = ? AND status = 'pending' AND expires_at > NOW()`,
      [code]
    );
  },

  async approve(id, userId) {
    const result = await execute(
      `UPDATE device_codes SET status = 'approved', user_id = ?
        WHERE id = ? AND status = 'pending' AND expires_at > NOW()`,
      [userId, id]
    );
    return (result.affectedRows || 0) > 0;
  },

  async deny(id) {
    const result = await execute(
      `UPDATE device_codes SET status = 'denied' WHERE id = ? AND status = 'pending'`, [id]
    );
    return (result.affectedRows || 0) > 0;
  },

  /**
   * One poll from the app. Answers the flow state; on 'approved' it mints the
   * device token, hands it back exactly once and marks the code consumed.
   *
   *   pending   — nobody has decided yet
   *   approved  — { deviceToken, user }
   *   denied    — the person pressed Deny
   *   expired   — ten minutes passed, or the code was never ours / already used
   *   slow_down — polled again inside the interval (still pending)
   */
  async consume(deviceCode, deviceFingerprint) {
    const row = await queryOne(
      'SELECT * FROM device_codes WHERE device_code_hash = ?', [sha256(deviceCode)]
    );
    if (!row || row.status === 'consumed') return { status: 'expired' };
    if (new Date(row.expires_at).getTime() <= Date.now()) return { status: 'expired' };
    // The code is bound to the machine that asked for it. A different
    // fingerprint here is a copied device code — which should be impossible,
    // since it never leaves the app — so it is treated as spent.
    if (row.device_fingerprint !== deviceFingerprint) return { status: 'expired' };
    if (row.status === 'denied') return { status: 'denied' };

    if (row.status === 'pending') {
      const last = row.last_polled_at ? new Date(row.last_polled_at).getTime() : 0;
      await execute('UPDATE device_codes SET last_polled_at = NOW() WHERE id = ?', [row.id]);
      const tooSoon = Date.now() - last < (POLL_INTERVAL_SECONDS - 1) * 1000;
      return { status: tooSoon ? 'slow_down' : 'pending' };
    }

    // approved → mint the token inside the same claim that marks the code
    // consumed, so two racing polls cannot both be handed a token.
    const claimed = await execute(
      `UPDATE device_codes SET status = 'consumed' WHERE id = ? AND status = 'approved'`, [row.id]
    );
    if (!(claimed.affectedRows || 0)) return { status: 'expired' };
    const user = await queryOne(
      'SELECT id, name, email, banned FROM users WHERE id = ?', [row.user_id]
    );
    if (!user || user.banned) return { status: 'denied' };
    const { token } = await DeviceAuth.createToken({
      userId: user.id,
      deviceFingerprint,
      deviceName: row.device_name,
      appVersion: row.app_version,
    });
    return { status: 'approved', deviceToken: token, user, deviceName: row.device_name };
  },

  /** A fresh device token for (user, machine). Any earlier token for the same machine is retired. */
  async createToken({ userId, deviceFingerprint, deviceName = null, appVersion = null }) {
    await execute(
      `UPDATE device_tokens SET revoked_at = NOW(), revoked_reason = 'replaced'
        WHERE user_id = ? AND device_fingerprint = ? AND revoked_at IS NULL`,
      [userId, deviceFingerprint]
    );
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const id = await insert(
      `INSERT INTO device_tokens (user_id, token_hash, device_fingerprint, device_name, app_version)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, sha256(token), deviceFingerprint, deviceName, appVersion]
    );
    return { id, token };
  },

  /** The live token row (with its account) behind a presented token, or null. */
  async findLiveToken(token) {
    if (!isDeviceToken(token)) return null;
    return queryOne(
      `SELECT t.*, u.email AS user_email, u.name AS user_name, u.banned AS user_banned,
              u.email_verified AS user_email_verified, u.role AS user_role
         FROM device_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
      [sha256(token)]
    );
  },

  async touch(id, { deviceName = null, appVersion = null } = {}) {
    await execute(
      `UPDATE device_tokens
          SET last_seen_at = NOW(),
              device_name = COALESCE(?, device_name),
              app_version = COALESCE(?, app_version)
        WHERE id = ?`,
      [deviceName, appVersion, id]
    );
  },

  async revoke(id, reason = 'signed_out') {
    const result = await execute(
      `UPDATE device_tokens SET revoked_at = NOW(), revoked_reason = ?
        WHERE id = ? AND revoked_at IS NULL`,
      [String(reason).slice(0, 40), id]
    );
    return (result.affectedRows || 0) > 0;
  },

  /** Every live token for one machine on one account (the dashboard's "Sign out"). */
  async revokeForDevice(userId, deviceFingerprint, reason = 'dashboard') {
    const result = await execute(
      `UPDATE device_tokens SET revoked_at = NOW(), revoked_reason = ?
        WHERE user_id = ? AND device_fingerprint = ? AND revoked_at IS NULL`,
      [String(reason).slice(0, 40), userId, deviceFingerprint]
    );
    return result.affectedRows || 0;
  },

  async revokeAllForUser(userId, reason = 'account') {
    const result = await execute(
      `UPDATE device_tokens SET revoked_at = NOW(), revoked_reason = ?
        WHERE user_id = ? AND revoked_at IS NULL`,
      [String(reason).slice(0, 40), userId]
    );
    return result.affectedRows || 0;
  },

  /** Machines signed in to this account right now. */
  async listForUser(userId) {
    return query(
      `SELECT id, device_fingerprint, device_name, app_version, created_at, last_seen_at
         FROM device_tokens
        WHERE user_id = ? AND revoked_at IS NULL
        ORDER BY last_seen_at DESC, created_at DESC`,
      [userId]
    );
  },

  /** Spent codes and long-revoked tokens; run from utils/housekeeping.js. */
  async prune() {
    const codes = await execute(
      'DELETE FROM device_codes WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)'
    );
    const tokens = await execute(
      'DELETE FROM device_tokens WHERE revoked_at IS NOT NULL AND revoked_at < DATE_SUB(NOW(), INTERVAL 90 DAY)'
    );
    return (codes.affectedRows || 0) + (tokens.affectedRows || 0);
  },
};

module.exports = DeviceAuth;
