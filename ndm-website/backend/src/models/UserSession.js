'use strict';

/**
 * Customer sessions — one row per browser, rotated on every refresh.
 *
 * users.refresh_token_hash held ONE refresh token per account, so signing in
 * on a second device silently ended the first one at its next refresh, and
 * that single slot could not tell "the cookie was stolen" from "the cookie
 * was used". This table gives every sign-in its own row — a *family* that
 * survives rotations — and remembers the hash each rotation replaced:
 *
 *   refresh with the current hash   → rotate: the row takes a new hash, the
 *                                     old one moves to prev_token_hash.
 *   refresh with prev_token_hash    → the token that was JUST replaced is being
 *                                     presented again. Inside REUSE_GRACE_MS of
 *                                     the rotation that is two tabs racing on
 *                                     one cookie jar (the jar ends up with the
 *                                     newest cookie either way), so the row is
 *                                     rotated again. Beyond it, somebody else
 *                                     has a copy of the cookie: the whole
 *                                     family is revoked and the owner's other
 *                                     sessions are untouched.
 *   anything else                   → not a session.
 *
 * Only SHA-256 hashes are stored; the token itself lives in the httpOnly
 * cookie and nowhere else. Expiry slides with use, like the cookie's maxAge.
 */

const crypto = require('crypto');
const { query, queryOne, insert, execute } = require('../config/db');

const REUSE_GRACE_MS = 30 * 1000;

function clip(value, max) {
  if (value === undefined || value === null) return null;
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

const UserSession = {
  REUSE_GRACE_MS,

  async create({ userId, tokenHash, userAgent, ip, ttlMs }) {
    const family = crypto.randomBytes(16).toString('hex');
    const id = await insert(
      `INSERT INTO user_sessions (user_id, family, token_hash, user_agent, ip, expires_at)
       VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
      [userId, family, tokenHash, clip(userAgent, 255), clip(ip, 45), Math.floor(ttlMs / 1000)]
    );
    return UserSession.findById(id);
  },

  async findById(id) {
    return queryOne('SELECT * FROM user_sessions WHERE id = ?', [id]);
  },

  /** The live row a presented cookie belongs to, or null. */
  async findLive(tokenHash) {
    return queryOne(
      `SELECT * FROM user_sessions
        WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > NOW()`,
      [tokenHash]
    );
  },

  /**
   * The row whose PREVIOUS hash is being presented — a token that was already
   * rotated away. Resolves { session, withinGrace } or null.
   */
  async findReplaced(tokenHash) {
    const row = await queryOne(
      `SELECT *, TIMESTAMPDIFF(MICROSECOND, rotated_at, NOW()) / 1000 AS since_rotation_ms
         FROM user_sessions
        WHERE prev_token_hash = ? AND revoked_at IS NULL AND expires_at > NOW()`,
      [tokenHash]
    );
    if (!row) return null;
    const since = Number(row.since_rotation_ms);
    return { session: row, withinGrace: Number.isFinite(since) && since >= 0 && since < REUSE_GRACE_MS };
  },

  /**
   * Replace the row's hash. The WHERE on the old hash makes two concurrent
   * refreshes of the same row race safely: only one wins, the other finds
   * its hash already moved to prev_token_hash and takes the grace path.
   * Returns true when this call did the rotation.
   */
  async rotate(id, fromHash, toHash, ttlMs) {
    const result = await execute(
      `UPDATE user_sessions
          SET prev_token_hash = token_hash,
              token_hash = ?,
              rotated_at = NOW(),
              last_used_at = NOW(),
              expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
        WHERE id = ? AND token_hash = ? AND revoked_at IS NULL`,
      [toHash, Math.floor(ttlMs / 1000), id, fromHash]
    );
    return (result.affectedRows || 0) > 0;
  },

  async revokeFamily(family) {
    const result = await execute(
      'UPDATE user_sessions SET revoked_at = NOW() WHERE family = ? AND revoked_at IS NULL',
      [family]
    );
    return result.affectedRows || 0;
  },

  async revokeById(id, userId) {
    const result = await execute(
      'UPDATE user_sessions SET revoked_at = NOW() WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      [id, userId]
    );
    return (result.affectedRows || 0) > 0;
  },

  async revokeAllForUser(userId) {
    const result = await execute(
      'UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL',
      [userId]
    );
    return result.affectedRows || 0;
  },

  /** Live sessions for the account page, newest activity first. */
  async listForUser(userId) {
    return query(
      `SELECT id, family, user_agent, ip, created_at, last_used_at, expires_at
         FROM user_sessions
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > NOW()
        ORDER BY last_used_at DESC`,
      [userId]
    );
  },

  /** Rows nobody can use any more; run from the daily maintenance job. */
  async pruneDead() {
    const result = await execute(
      `DELETE FROM user_sessions
        WHERE expires_at <= NOW()
           OR revoked_at < DATE_SUB(NOW(), INTERVAL 30 DAY)`
    );
    return result.affectedRows || 0;
  },
};

module.exports = UserSession;
