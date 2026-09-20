'use strict';

const { query, queryOne, insert, execute } = require('../config/db');

const REALMS = Object.freeze(['site', 'admin', 'root']);

function assertRealm(realm) {
  if (!REALMS.includes(realm)) throw new Error(`UserSession: unknown realm "${realm}"`);
  return realm;
}

/**
 * Sessions — one row per signed-in browser, in every realm.
 *
 * A row is identified by the SHA-256 of the refresh token it was issued (the
 * token itself is only ever in the httpOnly cookie). Rotation on the realm's
 * /refresh swaps the hash IN PLACE, so the row — its id, and its created /
 * last-used timestamps — follows the same browser across renewals. That
 * stable id is what the bearer token carries as `sid`, and what the gates
 * look up on every request: no row, no access, whatever the JWT says.
 *
 * `realm` is which sign-in the row is: 'site' for the website, 'admin' for
 * the staff panel, 'root' for the creator panel. Every lookup that starts
 * from a cookie or a token names the realm it expects, so a staff-panel
 * cookie presented to /auth/refresh finds nothing, and a site session's id
 * inside a forged admin token finds nothing either.
 *
 * This replaces the three single-slot columns on users (refresh_token_hash,
 * admin_refresh_token_hash, root_refresh_token_hash). With one slot per
 * account, signing in on a second device silently signed the first one out,
 * and two tabs refreshing at the same moment raced for it; and a bearer
 * token could not be tied to anything that revocation could take away.
 */
const UserSession = {
  REALMS,

  async create({ userId, tokenHash, realm = 'site', userAgent = null, ip = null, expiresAt }) {
    const id = await insert(
      `INSERT INTO user_sessions (user_id, realm, token_hash, user_agent, ip, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, assertRealm(realm), tokenHash, userAgent ? String(userAgent).slice(0, 255) : null,
       ip ? String(ip).slice(0, 45) : null, expiresAt]
    );
    return UserSession.findById(id);
  },

  async findById(id) {
    return queryOne('SELECT * FROM user_sessions WHERE id = ?', [id]);
  },

  // Only a LIVE session resolves; an expired row is as good as absent. The
  // realm is part of the key: a cookie only ever means something on the
  // paths its realm issues it for.
  async findLiveByTokenHash(hash, realm = 'site') {
    return queryOne(
      'SELECT * FROM user_sessions WHERE token_hash = ? AND realm = ? AND expires_at > NOW()',
      [hash, assertRealm(realm)]
    );
  },

  /**
   * The live row a bearer token was minted for, or null.
   *
   * Every condition is in the WHERE on purpose: the id must exist, belong to
   * the account the token names, be of the realm the gate serves, and not
   * have expired. A token whose row fails any of those is refused by the
   * gate with the same answer, so nothing downstream ever has to reason about
   * which one it was. Primary-key lookup, so it costs the same as the
   * User.findById that was already on every authenticated request.
   */
  async findLiveForToken({ id, userId, realm }) {
    const sid = Number(id);
    if (!Number.isInteger(sid) || sid <= 0) return null;
    return queryOne(
      `SELECT * FROM user_sessions
        WHERE id = ? AND user_id = ? AND realm = ? AND expires_at > NOW()`,
      [sid, userId, assertRealm(realm)]
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

  // Sign a user out everywhere: password reset or change, ban, admin "revoke
  // sessions". Every realm at once by default — the account is the thing
  // being locked, not one of its doors. A realm narrows it for the one case
  // that wants only one door shut (demoting a staff admin ends their panel
  // session and nothing else).
  async removeAllForUser(userId, realm = null) {
    const result = realm === null
      ? await execute('DELETE FROM user_sessions WHERE user_id = ?', [userId])
      : await execute('DELETE FROM user_sessions WHERE user_id = ? AND realm = ?',
        [userId, assertRealm(realm)]);
    return result.affectedRows || 0;
  },

  async listForUser(userId, realm = 'site') {
    return query(
      `SELECT id, realm, user_agent, ip, created_at, last_used_at, expires_at
         FROM user_sessions
        WHERE user_id = ? AND realm = ? AND expires_at > NOW()
        ORDER BY last_used_at DESC`,
      [userId, assertRealm(realm)]
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
