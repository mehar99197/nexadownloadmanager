'use strict';

const { query, queryOne, insert, execute } = require('../config/db');
const { MAX_ADS_PER_RESPONSE } = require('../utils/ads');

const Ad = {
  async findById(id) {
    return queryOne('SELECT * FROM ads WHERE id = ?', [id]);
  },

  async listAll() {
    return query('SELECT * FROM ads ORDER BY active DESC, weight DESC, created_at DESC');
  },

  // What the desktop app is allowed to see right now: switched on and inside
  // its schedule. Ordered so the heaviest ad is first, which is also the one a
  // client that only renders one will show.
  async listServable(placement, limit = MAX_ADS_PER_RESPONSE) {
    // MariaDB does not accept bound parameters for LIMIT, so it is clamped to a
    // number and interpolated (same as Review/Payment/User listings).
    const cap = Math.min(Math.max(Number(limit) || MAX_ADS_PER_RESPONSE, 1), MAX_ADS_PER_RESPONSE);
    return query(
      `SELECT * FROM ads
        WHERE active = 1
          AND placement = ?
          AND (starts_at IS NULL OR starts_at <= UTC_TIMESTAMP())
          AND (ends_at   IS NULL OR ends_at   >  UTC_TIMESTAMP())
        ORDER BY weight DESC, id ASC
        LIMIT ${cap}`,
      [placement]
    );
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
