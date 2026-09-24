'use strict';

const { query, queryOne, insert, execute } = require('../config/db');

// Columns update() may touch. Credentials and session state are here because
// the auth routes rotate them through update(); the counters that only ever
// move through their own atomic UPDATEs (trial_used, token_version) are not.
const UPDATABLE_COLUMNS = new Set([
  'name', 'email', 'password_hash', 'role', 'banned', 'email_verified',
  'google_id', 'avatar_url',
  'refresh_token_hash', 'admin_refresh_token_hash', 'root_refresh_token_hash',
  'totp_secret', 'totp_enabled', 'totp_recovery', 'totp_last_step',
  'failed_logins', 'locked_until', 'lock_level', 'lock_notified_at',
]);

const User = {
  async findById(id) {
    return queryOne('SELECT * FROM users WHERE id = ?', [id]);
  },

  async findByEmail(email) {
    return queryOne('SELECT * FROM users WHERE email = ?', [String(email).toLowerCase()]);
  },

  // Google's immutable subject claim, not the email — a user who changes their
  // Google address must still land on the same Nexa account.
  async findByGoogleId(googleId) {
    return queryOne('SELECT * FROM users WHERE google_id = ?', [String(googleId)]);
  },

  async findByRefreshTokenHash(hash) {
    return queryOne('SELECT * FROM users WHERE refresh_token_hash = ?', [hash]);
  },

  // Admin SPA session cookie (ndm_admin_refresh) — separate from the user refresh token.
  async findByAdminRefreshTokenHash(hash) {
    return queryOne('SELECT * FROM users WHERE admin_refresh_token_hash = ?', [hash]);
  },

  // Root SPA session cookie (ndm_root_refresh) — a third, separate token store
  // so a staff session and a creator session can never be mistaken for each other.
  async findByRootRefreshTokenHash(hash) {
    return queryOne('SELECT * FROM users WHERE root_refresh_token_hash = ?', [hash]);
  },

  // Every account that can reach a control panel, for the creator's admin screen.
  async listStaff() {
    return query(
      `SELECT id, name, email, role, email_verified, banned, totp_enabled, created_at, updated_at
       FROM users WHERE role IN ('admin', 'root') ORDER BY role DESC, created_at ASC`
    );
  },

  async remove(id) {
    await execute('DELETE FROM users WHERE id = ?', [id]);
  },

  /**
   * End every live session for this account.
   *
   * Incremented in SQL rather than read-modify-written, so two concurrent
   * revocations cannot land on the same number. Clearing the three refresh
   * hashes at the same time is what stops a new token being minted from a
   * cookie; the bump is what kills the access tokens already out there.
   * Returns the new value.
   */
  async revokeSessions(id) {
    await execute(
      `UPDATE users
          SET token_version = token_version + 1,
              refresh_token_hash = NULL,
              admin_refresh_token_hash = NULL,
              root_refresh_token_hash = NULL
        WHERE id = ?`,
      [id]
    );
    // Every browser session too (models/UserSession.js) — the bump above
    // kills the access tokens, this stops the refresh cookies re-minting them.
    await execute(
      'UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL',
      [id]
    );
    const row = await queryOne('SELECT token_version FROM users WHERE id = ?', [id]);
    return row ? Number(row.token_version) || 0 : 0;
  },

  /**
   * Spend a TOTP step: raise users.totp_last_step to `step`, but only from
   * something lower — or from NULL, an account that has never used a code.
   * Resolves true when THIS call is the one that took it, false when another
   * request got there first (or the row is gone).
   *
   * It has to be one statement rather than a read, a comparison in JS and an
   * update(). Every await in routes/twoFactor.js yields the event loop, so two
   * /login/2fa requests carrying the same six digits both read the row before
   * either writes, both see an unspent step, and a blind UPDATE lets both
   * through — the replay the column exists to stop. A real-time phishing proxy
   * relays the victim's code and fires its own login alongside it by
   * construction, and behind pm2/cluster the two requests are in different
   * processes where no JS-side guard could see each other at all. The row is
   * the only place the check and the write happen together.
   *
   * affectedRows answers "did the condition hold", not "did the value move":
   * mysql2 connects with CLIENT_FOUND_ROWS in its default flag set, so the
   * count that comes back is MATCHED rows. Nothing here leans on that — when
   * the WHERE matches, `step` is strictly greater than what was stored, so the
   * row changes too and either of MySQL's two counts says the same thing.
   */
  async spendTotpStep(id, step) {
    const result = await execute(
      `UPDATE users SET totp_last_step = ?
       WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)`,
      [step, id, step]
    );
    return result.affectedRows > 0;
  },

  /**
   * Replace the stored recovery-code set, but only while it still holds
   * `expected` — the exact column text the caller matched the offered code
   * against. Resolves true when this call is the one that took it.
   *
   * Same race as spendTotpStep, one credential over: two logins offering the
   * same recovery code each find it in their own snapshot of the row, and two
   * blind writes of "the set minus that code" would admit both. `<=>` is
   * MySQL's NULL-safe equality, so a row with no codes yet compares as equal
   * to null instead of never matching. affectedRows is the matched count here
   * (see spendTotpStep), and callers only ever pass a `next` that differs from
   * `expected` in any case, so it reads as "the condition held" whichever of
   * the two counts the driver is configured for.
   */
  async swapRecoveryCodes(id, expected, next) {
    const result = await execute(
      'UPDATE users SET totp_recovery = ? WHERE id = ? AND totp_recovery <=> ?',
      [next, id, expected === undefined ? null : expected]
    );
    return result.affectedRows > 0;
  },

  /**
   * Redeem a password-reset link: set the new password — and mark the address
   * verified, since the link reached that inbox — but only while token_version
   * still holds the generation the link was minted with. Resolves true when
   * THIS call is the one that used the link.
   *
   * The same race as spendTotpStep. The route checks the link's generation
   * against the row, then spends a few hundred milliseconds in bcrypt before
   * writing, so two requests carrying one link both pass that check and both
   * set a password — the later write wins and the earlier caller is told it
   * succeeded. Moving token_version on in the same statement is what makes the
   * link single use under concurrency: the second UPDATE finds the generation
   * already gone and matches nothing.
   */
  async redeemReset(id, linkVersion, passwordHash) {
    const result = await execute(
      `UPDATE users
          SET password_hash = ?, email_verified = 1, token_version = token_version + 1
        WHERE id = ? AND token_version = ?`,
      [passwordHash, id, linkVersion]
    );
    return result.affectedRows > 0;
  },

  async create({ name, email, passwordHash, role, emailVerified, googleId, avatarUrl }) {
    const id = await insert(
      `INSERT INTO users (name, email, password_hash, role, email_verified, google_id, avatar_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, String(email).toLowerCase(), passwordHash || null, role || 'user',
       emailVerified ? 1 : 0, googleId || null, avatarUrl || null]
    );
    return User.findById(id);
  },

  async update(id, fields) {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      const col = k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
      // The column name is interpolated into the statement, so it must never
      // be anything but one of ours — same rule as Release.update. Every caller
      // builds `fields` from validated input, and this is what keeps it so.
      if (!UPDATABLE_COLUMNS.has(col))
        throw new Error(`User.update: "${k}" is not an updatable column`);
      sets.push(`${col} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await execute(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals);
  },

  async count(filter = {}) {
    const where = [];
    const vals = [];
    if (filter.banned !== undefined) { where.push('banned = ?'); vals.push(filter.banned ? 1 : 0); }
    if (filter.emailVerified !== undefined) { where.push('email_verified = ?'); vals.push(filter.emailVerified ? 1 : 0); }
    if (filter.role) { where.push('role = ?'); vals.push(filter.role); }
    const sql = `SELECT COUNT(*) AS cnt FROM users${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
    const r = await queryOne(sql, vals);
    return r ? r.cnt : 0;
  },

  async list({ page = 1, limit = 20, q, role, banned, emailVerified } = {}) {
    const where = [];
    const vals = [];
    if (q) {
      where.push('(name LIKE ? OR email LIKE ?)');
      vals.push(`%${q}%`, `%${q}%`);
    }
    if (role) { where.push('role = ?'); vals.push(role); }
    if (banned !== undefined) { where.push('banned = ?'); vals.push(banned ? 1 : 0); }
    if (emailVerified !== undefined) { where.push('email_verified = ?'); vals.push(emailVerified ? 1 : 0); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const pageNumber = Math.max(1, Number(page) || 1);
    const limitNumber = Math.min(200, Math.max(1, Number(limit) || 20));
    const offset = (pageNumber - 1) * limitNumber;
    const rows = await query(
      `SELECT id, name, email, role, email_verified, banned, created_at, updated_at FROM users ${w} ORDER BY created_at DESC LIMIT ${limitNumber} OFFSET ${offset}`,
      vals
    );
    const total = await queryOne(
      `SELECT COUNT(*) AS cnt FROM users ${w}`,
      vals
    );
    return { users: rows, totalCount: total ? total.cnt : 0 };
  },

  // `limit` is not optional in practice: this feeds the CSV export, and an
  // uncapped SELECT over every user is a memory event waiting for growth.
  async listAll({ q, role, banned, emailVerified, limit = 5000 } = {}) {
    const where = [];
    const vals = [];
    if (q) {
      where.push('(name LIKE ? OR email LIKE ?)');
      vals.push(`%${q}%`, `%${q}%`);
    }
    if (role) { where.push('role = ?'); vals.push(role); }
    if (banned !== undefined) { where.push('banned = ?'); vals.push(banned ? 1 : 0); }
    if (emailVerified !== undefined) { where.push('email_verified = ?'); vals.push(emailVerified ? 1 : 0); }
    const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const cap = Math.min(50000, Math.max(1, Number(limit) || 5000));
    return query(
      `SELECT id, name, email, role, email_verified, banned, created_at, updated_at
       FROM users${w} ORDER BY created_at DESC LIMIT ${cap}`,
      vals
    );
  },

  async signupAgg(days = 30) {
    const safeDays = Math.min(365, Math.max(1, Number(days) || 30));
    return query(
      `SELECT DATE(created_at) AS date, COUNT(*) AS count FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${safeDays} DAY) GROUP BY DATE(created_at) ORDER BY date`
    );
  },
};

module.exports = User;
