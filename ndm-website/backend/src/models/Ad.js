'use strict';

const { query, queryOne, insert, execute } = require('../config/db');
const { MAX_ADS_PER_RESPONSE, isServable } = require('../utils/ads');

// What one ad-event token is allowed to report. Sized against what the desktop
// client genuinely does: it rotates every 45 seconds and re-fetches (getting
// fresh tokens) every 30 minutes, so ~40 impressions of one ad per token is
// normal use and a handful of clicks is generous. See claimEventNonce.
const AD_EVENT_BUDGET = {
  impression: { minIntervalSeconds: 30, maxEvents: 80 },
  click: { minIntervalSeconds: 30, maxEvents: 5 },
};

// Columns update() may touch. The name is interpolated into the statement, so
// it must never come from user input; the route's Zod schema is .strict(), but
// this makes the guarantee live here rather than one schema edit away. Counters
// and audit columns are deliberately absent — they have their own methods.
const UPDATABLE_COLUMNS = new Set([
  'title', 'body', 'image_url', 'target_url', 'cta_label', 'placement',
  'active', 'weight', 'starts_at', 'ends_at',
]);

const Ad = {
  async findById(id) {
    return queryOne('SELECT * FROM ads WHERE id = ?', [id]);
  },

  async listAll() {
    return query('SELECT * FROM ads ORDER BY active DESC, weight DESC, created_at DESC');
  },

  /**
   * What the desktop app is allowed to see right now, heaviest first.
   *
   * SQL narrows to the placement; `utils/ads.js#isServable` decides whether an
   * ad is actually live. The window rule used to exist twice — once here as a
   * WHERE clause and once in that predicate — and only the SQL ever ran, so the
   * heavily-tested JS copy was free to drift away from real behaviour. The ads
   * table holds a handful of admin-written promos, so filtering the placement's
   * rows in JS costs nothing and leaves one rule.
   */
  async listServable(placement, limit = MAX_ADS_PER_RESPONSE) {
    const cap = Math.min(Math.max(Number(limit) || MAX_ADS_PER_RESPONSE, 1), MAX_ADS_PER_RESPONSE);
    const rows = await query(
      'SELECT * FROM ads WHERE placement = ? ORDER BY weight DESC, id ASC', [placement]
    );
    const now = new Date();
    return rows.filter((ad) => isServable(ad, now)).slice(0, cap);
  },

  async create(fields) {
    const {
      title, body, imageUrl, targetUrl, ctaLabel, placement,
      active, weight, startsAt, endsAt, createdBy,
    } = fields;
    const id = await insert(
      `INSERT INTO ads
         (title, body, image_url, target_url, cta_label, placement, active, weight,
          starts_at, ends_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [title, body || '', imageUrl || null, targetUrl, ctaLabel || 'Learn more',
       placement || 'app_banner', active === false ? 0 : 1, Number(weight) || 1,
       startsAt || null, endsAt || null, createdBy || null]
    );
    return Ad.findById(id);
  },

  async update(id, fields) {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      const col = k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
      if (!UPDATABLE_COLUMNS.has(col))
        throw new Error(`Ad.update: "${k}" is not an updatable column`);
      sets.push(`${col} = ?`);
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await execute(`UPDATE ads SET ${sets.join(', ')} WHERE id = ?`, vals);
  },

  async remove(id) {
    const result = await execute('DELETE FROM ads WHERE id = ?', [id]);
    return result.affectedRows || 0;
  },

  // Counters are bumped in SQL so concurrent clients can't lose increments.
  // Both return 0 for an id that no longer exists, which the route ignores —
  // a stale client reporting on a deleted ad is not an error worth surfacing.
  async recordImpression(id) {
    const result = await execute(
      'UPDATE ads SET impressions = impressions + 1 WHERE id = ? AND active = 1', [id]
    );
    return result.affectedRows || 0;
  },

  async recordClick(id) {
    const result = await execute(
      'UPDATE ads SET clicks = clicks + 1 WHERE id = ? AND active = 1', [id]
    );
    return result.affectedRows || 0;
  },

  /**
   * Decide whether an ad-event token may report one more event of this type.
   *
   * Deliberately a BUDGET, not single-use. The desktop client holds one token
   * per ad for the whole 30-minute refresh cycle and reports an impression
   * every time that ad comes back round in the 45-second rotation, then reuses
   * the very same token to report a click. Making the nonce strictly one-shot
   * would have counted one impression per client per half hour and dropped
   * clicks entirely — accurate against replay, useless as a metric.
   *
   * So each token gets roughly what an honest client would actually use: no
   * more than one event per MIN_INTERVAL seconds, and a hard ceiling per token.
   * A replayed token therefore buys no more than the client it was stolen from
   * would have reported anyway, which is the whole of the amplification.
   *
   * Two statements rather than one upsert, and no read-then-write anywhere.
   * The conditional UPDATE carries the whole budget rule in its WHERE, so
   * MySQL's row lock decides the winner between concurrent replays; the
   * INSERT IGNORE that follows is only reached the first time a token reports,
   * and the unique key decides that one. Neither ever needs to know whether the
   * row existed beforehand.
   *
   * Deliberately NOT the obvious `INSERT … ON DUPLICATE KEY UPDATE` with an
   * IF() in the SET list: that has to be read back through `affectedRows`, and
   * MySQL 8.4 answers 1 for an upsert whose conditions changed nothing — the
   * same value it gives a successful insert. A no-op therefore looked exactly
   * like a first-ever event, which is to say the replay counted.
   */
  async claimEventNonce(nonce, eventType, expiresAt) {
    const type = eventType === 'click' ? 'click' : 'impression';
    const { minIntervalSeconds, maxEvents } = AD_EVENT_BUDGET[type];
    // Module constants, never request data — MySQL will not take
    // `INTERVAL ? SECOND` as a placeholder, so they are inlined.
    const spend = await execute(
      `UPDATE ad_event_nonces
          SET events = events + 1, last_at = NOW()
        WHERE nonce = ? AND event_type = ?
          AND last_at <= NOW() - INTERVAL ${minIntervalSeconds} SECOND
          AND events < ${maxEvents}`,
      [String(nonce), type]
    );
    // The WHERE guarantees last_at actually moves, so a match is always a real
    // change — affectedRows cannot be inflated by matched-but-unchanged rows.
    const counted = (spend.affectedRows || 0) > 0
      ? true
      // No row, or over budget. INSERT IGNORE separates the two: it inserts
      // exactly once for a token that has never reported this event type, and
      // does nothing at all for one that has.
      : (await execute(
        `INSERT IGNORE INTO ad_event_nonces (nonce, event_type, events, last_at, expires_at)
              VALUES (?, ?, 1, NOW(), ?)`,
        [String(nonce), type, expiresAt]
      )).affectedRows > 0;
    if (Math.random() < 0.005) {
      // Bounded so a long-neglected table is cleared over several passes
      // instead of one long DELETE holding locks on the hot path.
      await execute('DELETE FROM ad_event_nonces WHERE expires_at < NOW() LIMIT 5000')
        // eslint-disable-next-line no-console
        .catch((err) => console.error('[ads] nonce prune failed:', err.message));
    }
    return counted;
  },

  // Roll-up for the admin dashboard tile.
  async stats() {
    const row = await queryOne(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(active = 1), 0) AS active,
              COALESCE(SUM(impressions), 0) AS impressions,
              COALESCE(SUM(clicks), 0) AS clicks
         FROM ads`
    );
    return {
      total: Number(row?.total || 0),
      active: Number(row?.active || 0),
      impressions: Number(row?.impressions || 0),
      clicks: Number(row?.clicks || 0),
    };
  },
};

module.exports = Ad;
