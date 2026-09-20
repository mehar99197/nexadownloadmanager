'use strict';

const { query, queryOne, insert, execute } = require('../config/db');

// Every column update() may touch. The column NAME is interpolated into the
// statement (only values are bound), so it must never come from user input —
// today every caller passes hardcoded keys or a Zod-stripped object, but that is
// a property of each caller's discipline, not of this function. An allowlist
// makes it a property of the code: an unknown key throws instead of becoming
// SQL. Keep in step with the users table in config/schema.js.
const UPDATABLE_COLUMNS = new Set([
  'name', 'email', 'password_hash', 'role', 'email_verified', 'banned',
  'google_id', 'avatar_url', 'refresh_token_hash', 'admin_refresh_token_hash',
  'root_refresh_token_hash', 'trial_used', 'totp_secret', 'totp_enabled',
  'totp_recovery', 'totp_last_step',
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
      if (!UPDATABLE_COLUMNS.has(col))
        throw new Error(`User.update: "${k}" is not an updatable column`);
      sets.push(`${col} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await execute(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals);
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

  async listAll({ q, role, banned, emailVerified } = {}) {
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
    return query(
      `SELECT id, name, email, role, email_verified, banned, created_at, updated_at
       FROM users${w} ORDER BY created_at DESC`,
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
