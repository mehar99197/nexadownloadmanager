'use strict';

/**
 * The panel-managed half of the control-panel IP allow-list (AUDIT.md M-06).
 *
 * The effective list is the union of two sources:
 *
 *   1. ADMIN_ALLOWED_IPS from the server .env — the **break-glass**. It is
 *      only editable with a shell on the host, so no mistake made in the panel
 *      can take it away. That is the whole reason the union is a union and not
 *      an override: this is the one table whose rows decide who may edit the
 *      table.
 *   2. The enabled rows here — what the creator adds and removes at will.
 *
 * Reading it happens on EVERY panel request, so it is cached in process for a
 * few seconds and the cache is dropped on any write. A stale read can only
 * ever be a few seconds old, and a write by the person sitting in the panel
 * takes effect immediately for them because their own write clears it.
 *
 * The cache is per process. One machine runs this API (deploy/hostinger
 * run-api.sh holds a single instance with a pidfile), so there is nothing to
 * invalidate across nodes; if that changes, the TTL is the bound on staleness.
 */

const { query, insert, execute } = require('../config/db');
const config = require('../config/env');
const { isValidEntry } = require('../utils/ipMatch');

const CACHE_MS = 5000;

let cache = null;
let cachedAt = 0;

function dropCache() {
  cache = null;
  cachedAt = 0;
}

const AdminIpRule = {
  dropCache,

  /** Every rule, enabled or not, newest first — what the panel lists. */
  async list() {
    return query(
      `SELECT r.id, r.value, r.label, r.enabled, r.created_by, r.created_at, r.updated_at,
              u.email AS created_by_email
         FROM admin_ip_rules r
         LEFT JOIN users u ON u.id = r.created_by
        ORDER BY r.id DESC`
    );
  },

  async findById(id) {
    const rows = await query('SELECT * FROM admin_ip_rules WHERE id = ?', [id]);
    return rows[0] || null;
  },

  async findByValue(value) {
    const rows = await query('SELECT * FROM admin_ip_rules WHERE value = ?', [value]);
    return rows[0] || null;
  },

  /**
   * The list the gate actually compares against: the .env entries plus every
   * enabled row. Cached; see the note at the top.
   */
  async effectiveList() {
    const now = Date.now();
    if (cache && now - cachedAt < CACHE_MS) return cache;
    let rows = [];
    try {
      rows = await query('SELECT value FROM admin_ip_rules WHERE enabled = 1');
    } catch {
      // Before the first migration, or during one. The .env list alone is the
      // right answer then — it is the one that cannot be missing.
      rows = [];
    }
    cache = [...config.ADMIN_ALLOWED_IPS, ...rows.map((r) => r.value)];
    cachedAt = now;
    return cache;
  },

  async create({ value, label, createdBy }) {
    if (!isValidEntry(value)) throw new Error(`not a usable address or range: ${value}`);
    const id = await insert(
      'INSERT INTO admin_ip_rules (value, label, created_by) VALUES (?, ?, ?)',
      [value, label || null, createdBy || null]
    );
    dropCache();
    return id;
  },

  async setEnabled(id, enabled) {
    await execute('UPDATE admin_ip_rules SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);
    dropCache();
  },

  async remove(id) {
    await execute('DELETE FROM admin_ip_rules WHERE id = ?', [id]);
    dropCache();
  },
};

module.exports = AdminIpRule;
