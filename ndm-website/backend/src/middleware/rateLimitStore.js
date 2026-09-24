'use strict';

/**
 * A MySQL-backed store for express-rate-limit.
 *
 * The library's default store lives in process memory, which loses every count
 * on restart — and `run-api.sh` restarts the API from cron whenever it looks
 * hung, so a brute-force attempt was handed a fresh budget for free. Memory
 * also does not span processes, so a second worker would double every limit.
 *
 * Only the security-critical limiters use this: login, admin login, 2FA codes,
 * licence validation, the contact form and team invites. Those see a handful of
 * requests each, so one indexed upsert per attempt is nothing. The high-volume
 * limiters (`apiLimiter` on all of /api, ads, downloads) deliberately stay in
 * memory — a database round-trip on every API request would cost far more than
 * the counter is worth, and losing those counts on a restart is harmless.
 *
 * Falls back to counting in memory if the database is unreachable: a limiter
 * must never be the reason a request fails.
 */

const crypto = require('crypto');
const { query, execute } = require('../config/db');

const TABLE = 'rate_limits';

class MySqlRateLimitStore {
  constructor({ prefix = 'rl' } = {}) {
    this.prefix = prefix;
    this.windowMs = 60_000;
    // Used only while the database is unreachable.
    this.fallback = new Map();
  }

  // express-rate-limit calls this once with the limiter's resolved options.
  init(options) {
    this.windowMs = options.windowMs;
  }

  /**
   * The row id: the limiter's prefix, then a SHA-256 of the caller's key.
   *
   * The key used to be stored as it came, but rate_limits.id is VARCHAR(191)
   * and a sign-in key is "<ip>|<email>" with up to 190 characters of email. A
   * long address overflowed the column, the INSERT failed (ER_DATA_TOO_LONG in
   * strict mode — silent truncation, so two accounts sharing one count,
   * outside it) and the limiter fell back to process memory, where a restart
   * handed out a fresh budget. A digest is 64 characters whatever the key, and
   * it keeps raw emails, addresses and licence keys out of the table as well.
   *
   * Rows written under the old scheme are never looked up again; they age out
   * through the ordinary expires_at sweep, so a deploy costs at most one
   * window's worth of counts and needs no schema change.
   */
  key(key) {
    const digest = crypto.createHash('sha256').update(String(key)).digest('hex');
    return `${this.prefix}:${digest}`;
  }

  memoryHit(key) {
    const now = Date.now();
    const existing = this.fallback.get(key);
    if (!existing || existing.resetTime <= now) {
      const fresh = { totalHits: 1, resetTime: now + this.windowMs };
      this.fallback.set(key, fresh);
      return { totalHits: 1, resetTime: new Date(fresh.resetTime) };
    }
    existing.totalHits += 1;
    return { totalHits: existing.totalHits, resetTime: new Date(existing.resetTime) };
  }

  async increment(key) {
    const id = this.key(key);
    const seconds = Math.ceil(this.windowMs / 1000);
    try {
      // One statement, so two racing requests cannot both read "0 so far".
      // A row whose window has already passed is restarted rather than counted
      // on: `hits = IF(expires_at <= NOW(), 1, hits + 1)`.
      await execute(
        `INSERT INTO ${TABLE} (id, hits, expires_at)
         VALUES (?, 1, DATE_ADD(NOW(), INTERVAL ? SECOND))
         ON DUPLICATE KEY UPDATE
           hits = IF(expires_at <= NOW(), 1, hits + 1),
           expires_at = IF(expires_at <= NOW(), DATE_ADD(NOW(), INTERVAL ? SECOND), expires_at)`,
        [id, seconds, seconds]
      );
      const rows = await query(`SELECT hits, expires_at FROM ${TABLE} WHERE id = ?`, [id]);
      if (!rows.length) return this.memoryHit(id);
      return {
        totalHits: Number(rows[0].hits) || 1,
        resetTime: new Date(rows[0].expires_at),
      };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ratelimit] store unavailable, counting in memory:', err.message);
      return this.memoryHit(id);
    }
  }

  async decrement(key) {
    try {
      await execute(`UPDATE ${TABLE} SET hits = GREATEST(hits - 1, 0) WHERE id = ?`, [this.key(key)]);
    } catch { /* best effort */ }
  }

  async resetKey(key) {
    this.fallback.delete(this.key(key));
    try {
      await execute(`DELETE FROM ${TABLE} WHERE id = ?`, [this.key(key)]);
    } catch { /* best effort */ }
  }
}

/**
 * Drop rows whose window closed. Called opportunistically rather than on a
 * timer, so nothing has to be scheduled for it; the table stays tiny either way.
 */
async function sweepExpired() {
  try {
    const result = await execute(`DELETE FROM ${TABLE} WHERE expires_at <= NOW()`);
    return result.affectedRows || 0;
  } catch {
    return 0;
  }
}

module.exports = { MySqlRateLimitStore, sweepExpired, TABLE };
