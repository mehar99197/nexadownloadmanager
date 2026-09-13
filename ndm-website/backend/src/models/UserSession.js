'use strict';

const { query, queryOne, insert, execute } = require('../config/db');

/**
 * Site sessions — one row per signed-in browser.
 *
 * A row is identified by the SHA-256 of the refresh token it was issued (the
 * token itself is only ever in the httpOnly cookie). Rotation on /auth/refresh
 * swaps the hash IN PLACE, so the row — and its created/last-used timestamps —
 * follow the same browser across renewals.
 *
 * This replaces the single users.refresh_token_hash slot. With one slot per
 * account, signing in on a second device silently signed the first one out,
 * and two tabs refreshing at the same moment raced for it.
 */
const UserSession = {
  async create({ userId, tokenHash, userAgent = null, ip = null, expiresAt }) {
    const id = await insert(
      `INSERT INTO user_sessions (user_id, token_hash, user_agent, ip, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, tokenHash, userAgent ? String(userAgent).slice(0, 255) : null,
       ip ? String(ip).slice(0, 45) : null, expiresAt]
    );
    return UserSession.findById(id);
  },

  async findById(id) {
    return queryOne('SELECT * FROM user_sessions WHERE id = ?', [id]);
  },

  // Only a LIVE session resolves; an expired row is as good as absent.
  async findLiveByTokenHash(hash) {
    return queryOne(
      'SELECT * FROM user_sessions WHERE token_hash = ? AND expires_at > NOW()',
      [hash]
    );
  },

  // Rotate the token in place. The WHERE clause carries the OLD hash so that
  // two concurrent refreshes with the same cookie cannot both succeed: the
  // second one finds no row to update and is told to sign in again, instead of
  // silently invalidating whichever tab lost the race.
  async rotate(id, oldHash, newHash, expiresAt) {
    const result = await execute(
      `UPDATE user_sessions
          SET token_hash = ?, expires_at = ?, last_used_at = NOW()
        WHERE id = ? AND token_hash = ?`,
      [newHash, expiresAt, id, oldHash]
    );
    return (result.affectedRows || 0) > 0;
  },

  async removeByTokenHash(hash) {
    const result = await execute('DELETE FROM user_sessions WHERE token_hash = ?', [hash]);
    return (result.affectedRows || 0) > 0;
  },

  // Sign a user out everywhere: password reset, ban, admin "sign out".
  async removeAllForUser(userId) {
    const result = await execute('DELETE FROM user_sessions WHERE user_id = ?', [userId]);
    return result.affectedRows || 0;
  },

  async listForUser(userId) {
    return query(
      `SELECT id, user_agent, ip, created_at, last_used_at, expires_at
         FROM user_sessions
        WHERE user_id = ? AND expires_at > NOW()
        ORDER BY last_used_at DESC`,
      [userId]
    );
  },

  // Housekeeping; safe to run any time. Expired rows are already ignored by
  // every lookup, so this only keeps the table from growing without bound.
  async pruneExpired() {
    const result = await execute('DELETE FROM user_sessions WHERE expires_at <= NOW()');
    return result.affectedRows || 0;
  },
};

module.exports = UserSession;
