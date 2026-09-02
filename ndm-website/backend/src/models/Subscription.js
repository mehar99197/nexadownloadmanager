'use strict';

const { query, queryOne, insert, execute, getPool, withTransaction } = require('../config/db');
const {
  generateLicenseKey, planSeats, planExpiry, TRIAL_PLAN, trialEndsAt, isTrialExpired,
  SEAT_LEASE_SECONDS,
} = require('../utils/license');

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

  /**
   * Take (or renew) one concurrent seat for a device.
   *
   * Seats are a "how many machines at a time" limit, not a permanent device
   * registration: a row only occupies a seat while `lease_expires_at` is in the
   * future. That is what lets a user move between machines — the old one's
   * lease simply lapses — without an admin revoking anything.
   *
   * The whole check runs inside one transaction with the subscription row
   * locked FOR UPDATE, so two clients racing for the last seat cannot both win.
   * The seat count is read with the same NOW() the lease is written against.
   */
  async acquireSeat(id, deviceFingerprint, { deviceName = null, leaseSeconds, renewOnly = false } = {}) {
    const ttl = Number(leaseSeconds) > 0 ? Number(leaseSeconds) : SEAT_LEASE_SECONDS;
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
      const seats = Math.max(1, Number(rows[0].seats) || 1);

      // Seats held by OTHER devices right now. Excluding this device is what
      // makes a renewal free — a returning client must never be counted twice.
      const [busyRows] = await connection.execute(
        `SELECT COUNT(*) AS count FROM license_activations
          WHERE subscription_id = ? AND device_fingerprint <> ?
            AND lease_expires_at IS NOT NULL AND lease_expires_at > NOW()`,
        [id, deviceFingerprint]
      );
      const busy = Number(busyRows[0].count) || 0;

      const [existing] = await connection.execute(
        `SELECT id, lease_expires_at, revoked_at FROM license_activations
          WHERE subscription_id = ? AND device_fingerprint = ? FOR UPDATE`,
        [id, deviceFingerprint]
      );
      const holdsLease = existing.length
        && existing[0].lease_expires_at
        && new Date(existing[0].lease_expires_at).getTime() > Date.now();

      // A heartbeat may RENEW a lease it already holds; it may not take a fresh
      // one after the seat was deliberately taken away. Without this, freeing a
      // seat from the admin panel was undone by the running client's very next
      // beat: `busy` counts only OTHER devices, so on a one-seat licence the
      // check below read 0 >= 1 as "a seat is free" and handed the same device a
      // new 15-minute lease. The admin action was a no-op within five minutes.
      //
      // A lease that merely lapsed (a laptop asleep past its 15 minutes) has no
      // revoked_at and still recovers here, which is the behaviour we want to
      // keep. Re-activating — the user pasting the key again, or the app calling
      // /validate on start — clears revoked_at below and takes a seat if one is
      // free.
      if (renewOnly && !holdsLease && existing.length && existing[0].revoked_at) {
        await connection.rollback();
        return { ok: false, reason: 'seat_revoked', seats, activeSeats: busy };
      }

      // Renewing an unexpired lease always succeeds. Taking a *new* one (first
      // run, or after this device's lease lapsed) needs a free seat.
      if (!holdsLease && busy >= seats) {
        await connection.rollback();
        return { ok: false, reason: 'seat_limit', seats, activeSeats: busy };
      }

      if (existing.length) {
        await connection.execute(
          `UPDATE license_activations
              SET lease_expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND),
                  last_seen_at = CURRENT_TIMESTAMP,
                  device_name = COALESCE(?, device_name),
                  revoked_at = NULL
            WHERE id = ?`,
          [ttl, deviceName, existing[0].id]
        );
      } else {
        await connection.execute(
          `INSERT INTO license_activations
             (subscription_id, device_fingerprint, device_name, lease_expires_at)
           VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
          [id, deviceFingerprint, deviceName, ttl]
        );
      }
      await connection.commit();
      return {
        ok: true,
        reason: holdsLease ? 'renewed' : 'acquired',
        seats,
        activeSeats: busy + 1,
        leaseSeconds: ttl,
      };
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  },

  /**
   * Give a seat back immediately (app shutdown / sign-out).
   *
   * The activation row is kept so the device stays visible in the user's device
   * list and can re-take a seat without re-registering; only the lease is
   * dropped. Idempotent — releasing twice is not an error.
   *
   * This is the device handing its OWN seat back on shutdown, so it is
   * deliberately not a revocation: revoked_at stays clear and the same device
   * can beat its way back in on the next run without re-activating.
   */
  async releaseSeat(id, deviceFingerprint) {
    const result = await execute(
      `UPDATE license_activations SET lease_expires_at = NULL
        WHERE subscription_id = ? AND device_fingerprint = ?`,
      [id, deviceFingerprint]
    );
    return { ok: true, released: (result.affectedRows || 0) > 0 };
  },

  /** Devices for a subscription, newest lease first, with live/idle state. */
  async listActivations(id) {
    return query(
      `SELECT id, device_fingerprint, device_name, lease_expires_at, created_at, last_seen_at,
              (lease_expires_at IS NOT NULL AND lease_expires_at > NOW()) AS active
         FROM license_activations
        WHERE subscription_id = ?
        ORDER BY active DESC, last_seen_at DESC`,
      [id]
    );
  },

  /** How many seats are occupied right now. */
  async activeSeatCount(id) {
    const row = await queryOne(
      `SELECT COUNT(*) AS count FROM license_activations
        WHERE subscription_id = ? AND lease_expires_at IS NOT NULL AND lease_expires_at > NOW()`,
      [id]
    );
    return row ? Number(row.count) || 0 : 0;
  },

  /**
   * Release one device by activation id, scoped to its subscription so a user
   * can only ever free a seat on a licence they actually own.
   *
   * Unlike releaseSeat() this is somebody taking the seat AWAY from a device
   * that may still be running, so it stamps revoked_at — that is what stops the
   * device's next heartbeat from quietly re-taking the seat.
   */
  async releaseSeatById(subscriptionId, activationId) {
    const result = await execute(
      `UPDATE license_activations SET lease_expires_at = NULL, revoked_at = NOW()
        WHERE id = ? AND subscription_id = ?`,
      [activationId, subscriptionId]
    );
    return (result.affectedRows || 0) > 0;
  },

  /**
   * Drop every lease for a subscription (admin "Free seats").
   *
   * Stamps revoked_at for the same reason as releaseSeatById: the machines being
   * freed are typically still running, and a plain lease drop would be undone by
   * their next heartbeat.
   */
  async releaseAllSeats(id) {
    const result = await execute(
      `UPDATE license_activations SET lease_expires_at = NULL, revoked_at = NOW()
        WHERE subscription_id = ?`,
      [id]
    );
    return result.affectedRows || 0;
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

  // Lazy trial expiry: when trial_ends_at has passed and the row is not a paid
  // Stripe subscription, downgrade to free/active. Returns the (possibly
  // refreshed) row; a non-trial or still-running trial is returned untouched.
  async expireTrialIfNeeded(sub) {
    if (!isTrialExpired(sub)) return sub;
    await execute(
      `UPDATE subscriptions
          SET plan = 'free', status = 'active', trial_ends_at = NULL, expiry_date = ?, seats = ?
        WHERE id = ? AND trial_ends_at IS NOT NULL AND stripe_subscription_id IS NULL`,
      [planExpiry('free'), planSeats('free'), sub.id]
    );
    return Subscription.findById(sub.id);
  },

  // Start the one-shot no-card Pro trial for a user in ONE transaction.
  // → { ok:true, subscription } | { ok:false, reason:'not_found'|'trial_used'|'paid_plan' }
  async startTrial(userId, now = new Date()) {
    return withTransaction(async (connection) => {
      const [users] = await connection.execute(
        'SELECT id, trial_used FROM users WHERE id = ? FOR UPDATE', [userId]
      );
      if (!users.length) return { ok: false, reason: 'not_found' };
      if (users[0].trial_used) return { ok: false, reason: 'trial_used' };

      const [subs] = await connection.execute(
        'SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
        [userId]
      );
      const current = subs[0] || null;
      if (current && (current.plan === 'pro' || current.plan === 'team') &&
          current.status === 'active' && !current.trial_ends_at)
        return { ok: false, reason: 'paid_plan' };

      const endsAt = trialEndsAt(now);
      let id;
      if (current) {
        id = current.id;
        // A trial is never a Stripe subscription; any stripe_subscription_id
        // left here belongs to a non-active (cancelled/expired) plan.
        await connection.execute(
          `UPDATE subscriptions
              SET plan = ?, status = 'active', seats = ?, start_date = ?, expiry_date = ?,
                  trial_ends_at = ?, stripe_subscription_id = NULL
            WHERE id = ?`,
          [TRIAL_PLAN, planSeats(TRIAL_PLAN), now, endsAt, endsAt, id]
        );
      } else {
        const [result] = await connection.execute(
          `INSERT INTO subscriptions
             (user_id, plan, status, license_key, seats, start_date, expiry_date, trial_ends_at)
           VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`,
          [userId, TRIAL_PLAN, generateLicenseKey(), planSeats(TRIAL_PLAN), now, endsAt, endsAt]
        );
        id = result.insertId;
      }
      await connection.execute('UPDATE users SET trial_used = 1 WHERE id = ?', [userId]);
      const [rows] = await connection.execute('SELECT * FROM subscriptions WHERE id = ?', [id]);
      return { ok: true, subscription: rows[0] };
    });
  },
};

module.exports = Subscription;
