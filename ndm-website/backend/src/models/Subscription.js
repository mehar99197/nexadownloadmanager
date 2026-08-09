'use strict';

const { query, queryOne, insert, execute, getPool } = require('../config/db');

const Subscription = {
  async findById(id) {
    return queryOne('SELECT * FROM subscriptions WHERE id = ?', [id]);
  },

  async findByUserId(userId) {
    return query('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  },

  async findActiveByUserId(userId) {
    return queryOne(
      'SELECT * FROM subscriptions WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
      [userId, 'active']
    );
  },

  async findByLicenseKey(key) {
    return queryOne('SELECT * FROM subscriptions WHERE license_key = ?', [key]);
  },

  async findByStripeSubscriptionId(id) {
    return queryOne('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?', [id]);
  },

  async bindDeviceFingerprint(id, deviceFingerprint) {
    const pool = await getPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT seats FROM subscriptions WHERE id = ? FOR UPDATE', [id]
      );
      if (!rows.length) {
        await connection.rollback();
        return { ok: false, reason: 'not_found' };
      }
      const [existing] = await connection.execute(
        'SELECT id FROM license_activations WHERE subscription_id = ? AND device_fingerprint = ? FOR UPDATE',
        [id, deviceFingerprint]
      );
      if (existing.length) {
        await connection.execute(
          'UPDATE license_activations SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?',
          [existing[0].id]
        );
        await connection.commit();
        return { ok: true, reason: 'existing' };
      }
      const [countRows] = await connection.execute(
        'SELECT COUNT(*) AS count FROM license_activations WHERE subscription_id = ?', [id]
      );
      if (Number(countRows[0].count) >= Number(rows[0].seats)) {
        await connection.rollback();
        return { ok: false, reason: 'device_mismatch' };
      }
      await connection.execute(
        'INSERT INTO license_activations (subscription_id, device_fingerprint) VALUES (?, ?)',
        [id, deviceFingerprint]
      );
      await connection.commit();
      return { ok: true, reason: 'new' };
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  },

  async create({
    userId, plan, status, licenseKey, deviceFingerprint = null,
    seats = 1, startDate, expiryDate, stripeSubscriptionId = null,
    stripeCustomerId = null,
  }) {
    const id = await insert(
      `INSERT INTO subscriptions (user_id, plan, status, license_key, device_fingerprint, seats, start_date, expiry_date, stripe_subscription_id, stripe_customer_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, plan, status || 'active', licenseKey, deviceFingerprint, seats,
       startDate || new Date(), expiryDate || null, stripeSubscriptionId, stripeCustomerId]
    );
    return Subscription.findById(id);
  },

  async update(id, fields) {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      const col = k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
      sets.push(`${col} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await execute(`UPDATE subscriptions SET ${sets.join(', ')} WHERE id = ?`, vals);
  },

  async updateByUserId(userId, fields) {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      const col = k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
      sets.push(`${col} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    vals.push(userId);
    await execute(`UPDATE subscriptions SET ${sets.join(', ')} WHERE user_id = ?`, vals);
  },

  async count(filter = {}) {
    const where = [];
    const vals = [];
    if (filter.status) { where.push('status = ?'); vals.push(filter.status); }
    if (filter.plan) { where.push('plan = ?'); vals.push(filter.plan); }
    const sql = `SELECT COUNT(*) AS cnt FROM subscriptions${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
    const r = await queryOne(sql, vals);
    return r ? r.cnt : 0;
  },

  async countActive() {
    return Subscription.count({ status: 'active' });
  },

  async countByPlan() {
    return query('SELECT plan, COUNT(*) AS count FROM subscriptions GROUP BY plan ORDER BY plan');
  },

  async findPaidActive() {
    return query(
      "SELECT * FROM subscriptions WHERE status = 'active' AND plan IN ('pro', 'team')"
    );
  },

  async list({ page = 1, limit = 20, status, plan, q } = {}) {
    const where = [];
    const vals = [];
    if (q) { where.push('(u.name LIKE ? OR u.email LIKE ?)'); vals.push(`%${q}%`, `%${q}%`); }
    if (status) { where.push('s.status = ?'); vals.push(status); }
    if (plan) { where.push('s.plan = ?'); vals.push(plan); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const pageNumber = Math.max(1, Number(page) || 1);
    const limitNumber = Math.min(200, Math.max(1, Number(limit) || 20));
    const offset = (pageNumber - 1) * limitNumber;
    const rows = await query(
      `SELECT s.*, u.email AS userEmail, u.name AS userName
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       ${w}
       ORDER BY s.created_at DESC LIMIT ${limitNumber} OFFSET ${offset}`,
      vals
    );
    const total = await queryOne(
      `SELECT COUNT(*) AS cnt FROM subscriptions s JOIN users u ON u.id = s.user_id ${w}`,
      vals
    );
    return { subscriptions: rows, totalCount: total ? total.cnt : 0 };
  },

  async findByUserIds(userIds) {
    if (!userIds.length) return [];
    const placeholders = userIds.map(() => '?').join(',');
    return query(
      `SELECT * FROM subscriptions WHERE user_id IN (${placeholders}) ORDER BY created_at DESC`,
      userIds
    );
  },
};

module.exports = Subscription;
