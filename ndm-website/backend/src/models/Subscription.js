'use strict';

const { query, queryOne, insert, execute, getPool, withTransaction } = require('../config/db');
const {
  generateLicenseKey, planSeats, planExpiry, TRIAL_PLAN, trialEndsAt, isTrialExpired,
  isPaidPlanLapsed, SEAT_LEASE_SECONDS,
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

  // Fallback link for a renewal invoice that names the customer but not the
  // subscription (older API shapes put the subscription only on the line item).
  async findByStripeCustomerId(id) {
    return queryOne(
      'SELECT * FROM subscriptions WHERE stripe_customer_id = ? ORDER BY created_at DESC LIMIT 1',
      [id]
    );
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
        'SELECT seats, plan FROM subscriptions WHERE id = ? FOR UPDATE', [id]
      );
      if (!rows.length) {
        await connection.rollback();
        return { ok: false, reason: 'not_found' };
      }
      const seats = Math.max(1, Number(rows[0].seats) || 1);
      // A seat is a unit of something paid for. The Free plan has nothing to
      // ration — every machine on it gets the same Free entitlements the app
      // defaults to anyway — so it never answers seat_limit: an account signed
      // in on a laptop and a desktop is not "sharing" anything. The row is
      // still written, so the device list stays truthful.
      const unlimited = rows[0].plan === 'free';

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

      // A heartbeat may not REGISTER a machine either. Refusing a revoked row
      // above but falling through to the INSERT below when there was no row at
      // all left the larger hole: a client that simply never calls /validate
      // could take a seat and collect a signed licence token from /heartbeat,
      // on the general API limiter instead of the strict licence one — and,
      // far worse, /validate is the ONLY place the key-sharing assessment and
      // auto-suspend run (routes/license.js). A key posted on a forum and used
      // by 500 people leaves 500 activation rows, and that all-time count is
      // the one signal seat limits cannot see; beating straight past
      // /validate meant the rows were still written but nothing ever read
      // them. Enforcement that a modified client can skip by choosing a
      // different endpoint is not enforcement.
      //
      // A legitimate client always has a row here: LicenseManager only starts
      // its heartbeat after a /validate that succeeded (which creates the row),
      // and nothing ever deletes one — releaseSeat and the admin's "free seat"
      // both keep the row and clear the lease.
      if (renewOnly && !existing.length) {
        await connection.rollback();
        return { ok: false, reason: 'seat_unknown_device', seats, activeSeats: busy };
      }

      // Renewing an unexpired lease always succeeds. Taking a *new* one (first
      // run, or after this device's lease lapsed) needs a free seat.
      if (!holdsLease && !unlimited && busy >= seats) {
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

  /**
   * How widely a licence has been activated: distinct machines all time, and
   * how many of those first appeared inside `windowDays`.
   *
   * Counts rows rather than live leases on purpose. A leaked key's users take
   * turns holding the seat, so the live count stays at the limit and looks
   * healthy; it is the accumulated rows that give it away. Activation rows are
   * never deleted (releaseSeat only clears the lease), so this is a true
   * all-time count.
   */
  async deviceSpread(id, windowDays = 7) {
    const days = Math.max(1, Math.min(365, Number(windowDays) || 7));
    const rows = await query(
      `SELECT COUNT(*) AS distinctDevices,
              SUM(created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)) AS newDevicesInWindow
         FROM license_activations
        WHERE subscription_id = ?`,
      [days, id]
    );
    const row = rows[0] || {};
    return {
      distinctDevices: Number(row.distinctDevices) || 0,
      newDevicesInWindow: Number(row.newDevicesInWindow) || 0,
    };
  },

  /**
   * Suspend a licence the sharing check judged beyond argument.
   *
   * Deliberately does NOT touch `status`. Setting it to 'cancelled' or
   * 'expired' would make the desktop client delete the stored key, turning a
   * reversible measure into a permanent one for anybody caught by a false
   * positive — and those two reasons are reserved for something a person
   * decided. The licence instead answers `seat_limit`, which the client already
   * treats as "close Nexa on another machine" and keeps the key for.
   *
   * Idempotent: re-suspending an already-suspended licence does not move the
   * timestamp, so the record keeps saying when it actually started.
   */
  async suspendForSharing(id, reason) {
    const result = await execute(
      `UPDATE subscriptions
          SET sharing_suspended_at = NOW(), sharing_level = 'suspected',
              sharing_reason = ?, sharing_checked_at = NOW()
        WHERE id = ? AND sharing_suspended_at IS NULL`,
      [reason ? String(reason).slice(0, 255) : null, id]
    );
    return { suspended: (result.affectedRows || 0) > 0 };
  },

  /**
   * Lift a sharing suspension (an admin deciding it was wrong, or the customer
   * being believed). Also resets the verdict to 'ok' so the same evidence does
   * not immediately re-suspend on the next new device — the device history is
   * still there, and without this reset the licence would bounce straight back.
   */
  async clearSharingSuspension(id) {
    const result = await execute(
      `UPDATE subscriptions
          SET sharing_suspended_at = NULL, sharing_level = 'ok',
              sharing_reason = NULL, sharing_checked_at = NOW(),
              sharing_exempt = 1
        WHERE id = ?`,
      [id]
    );
    return { cleared: (result.affectedRows || 0) > 0 };
  },

  /**
   * Put a licence back under automatic enforcement after it was exempted.
   * The counterpart to clearSharingSuspension, for when a customer turns out
   * to have been sharing after all.
   */
  async resumeSharingEnforcement(id) {
    const result = await execute(
      'UPDATE subscriptions SET sharing_exempt = 0 WHERE id = ?', [id]
    );
    return { resumed: (result.affectedRows || 0) > 0 };
  },

  /** Record what the sharing check concluded. Never changes `status`. */
  async recordSharingAssessment(id, { level, reason, distinctDevices }) {
    await execute(
      `UPDATE subscriptions
          SET sharing_level = ?, sharing_reason = ?, sharing_devices = ?,
              sharing_checked_at = NOW()
        WHERE id = ?`,
      [level, reason ? String(reason).slice(0, 255) : null, distinctDevices, id]
    );
  },

  /** Licences the sharing check has flagged, worst first — for the admin panel. */
  async listFlaggedForSharing({ limit = 100 } = {}) {
    const capped = Math.max(1, Math.min(500, Number(limit) || 100));
    return query(
      `SELECT s.id, s.license_key, s.plan, s.status, s.seats,
              s.sharing_level, s.sharing_devices, s.sharing_reason, s.sharing_checked_at,
              s.sharing_suspended_at, s.sharing_exempt,
              u.email
         FROM subscriptions s
         JOIN users u ON u.id = s.user_id
        WHERE s.sharing_level <> 'ok' OR s.sharing_suspended_at IS NOT NULL
        ORDER BY FIELD(s.sharing_level, 'suspected', 'watch'), s.sharing_devices DESC
        LIMIT ${capped}`
    );
  },

  /**
   * Issue a brand-new licence key for a subscription and cut every machine
   * currently using the old one loose.
   *
   * This is the remedy the product was missing. A Team member is handed the
   * OWNER's real licence key (routes/team.js#memberPayload), and removing them
   * from the roster does nothing to the copy already sitting in their desktop
   * app — nothing links an activation row back to the member who created it,
   * because /license/validate authenticates a key and a device, not a person.
   * So "remove from team" was cosmetic: the removed member kept a working Pro
   * seat for as long as the plan lived. The same is true of a key that leaked
   * any other way.
   *
   * Both halves have to happen together. A new key alone leaves the old
   * devices holding live leases against this subscription until they lapse; a
   * seat sweep alone lets them re-activate with the key they still have.
   * Activation ROWS are kept (only revoked + unleased) because they are the
   * all-time device history the sharing check reads — deleting them would
   * quietly launder a shared key's record.
   */
  async rotateLicenseKey(id) {
    return withTransaction(async (connection) => {
      const [rows] = await connection.execute(
        'SELECT id, license_key FROM subscriptions WHERE id = ? FOR UPDATE', [id]
      );
      if (!rows.length) return { ok: false, reason: 'not_found' };

      // The unique index on license_key makes a collision a failed INSERT
      // rather than a silent overwrite; retrying a few times covers it without
      // pretending 128 bits of randomness needs a loop.
      let licenseKey = null;
      for (let attempt = 0; attempt < 5 && !licenseKey; attempt += 1) {
        const candidate = generateLicenseKey();
        const [clash] = await connection.execute(
          'SELECT id FROM subscriptions WHERE license_key = ?', [candidate]
        );
        if (!clash.length) licenseKey = candidate;
      }
      if (!licenseKey) return { ok: false, reason: 'key_generation_failed' };

      await connection.execute(
        'UPDATE subscriptions SET license_key = ? WHERE id = ?', [licenseKey, id]
      );
      // revoked_at, not just a cleared lease: a machine still running with the
      // old key would otherwise renew straight through its next heartbeat.
      const [freed] = await connection.execute(
        `UPDATE license_activations SET lease_expires_at = NULL, revoked_at = NOW()
          WHERE subscription_id = ?`,
        [id]
      );
      return {
        ok: true,
        licenseKey,
        previousKey: rows[0].license_key,
        devicesRevoked: freed.affectedRows || 0,
      };
    });
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

  /**
   * Update the user's CURRENT subscription — the newest row, which is the one
   * every read path (`findByUserId()[0]`, `findActiveByUserId`) resolves to.
   * It used to write to every row the user had, so a second licence issued by
   * an admin silently moved in lockstep with the first.
   */
  async updateCurrentByUserId(userId, fields) {
    const current = (await Subscription.findByUserId(userId))[0] || null;
    if (!current) return null;
    await Subscription.update(current.id, fields);
    return Subscription.findById(current.id);
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

  /**
   * The row as it should be read RIGHT NOW: lazy trial expiry, then lazy paid
   * lapse. One call so no route has to remember both, and every read path in
   * the app agrees on what a subscription currently is.
   */
  async current(sub) {
    return Subscription.expireIfLapsed(await Subscription.expireTrialIfNeeded(sub));
  },

  /**
   * A paid plan whose period ended and was never renewed falls back to Free
   * rather than sitting there as an `active` row with a past date — which
   * /api/license/validate reported as `expired`, and the desktop client deletes
   * a key it is told is expired. See utils/license.js#isPaidPlanLapsed for the
   * grace period that keeps a slow renewal webhook from downgrading anyone.
   */
  async expireIfLapsed(sub) {
    if (!isPaidPlanLapsed(sub)) return sub;
    await execute(
      `UPDATE subscriptions
          SET plan = 'free', status = 'active', seats = ?, expiry_date = ?,
              cancel_at_period_end = 0
        WHERE id = ? AND plan IN ('pro', 'team') AND status = 'active'`,
      [planSeats('free'), planExpiry('free'), sub.id]
    );
    return Subscription.findById(sub.id);
  },

  /**
   * Retire every OTHER subscription a user holds, so issuing a new licence by
   * hand cannot leave the previous key still validating. Without this an admin
   * "upgrade" handed the customer two working licences.
   */
  async retireOthers(userId, keepId) {
    const result = await execute(
      `UPDATE subscriptions SET status = 'expired', cancel_at_period_end = 0
        WHERE user_id = ? AND id <> ? AND status <> 'expired'`,
      [userId, keepId]
    );
    return result.affectedRows || 0;
  },

  /**
   * What a finished trial looks like, written in ONE place: back to free/active,
   * no trial date left behind, the licence key untouched so the desktop app
   * keeps working on Free. Both the lazy expiry (the date passed) and the
   * customer ending it early go through here, so the two can never drift into
   * meaning different things.
   *
   * `status` deliberately stays `active`: `cancelled`/`expired` make the app
   * DELETE its stored key, and a finished trial is not a stopped licence.
   */
  async endTrial(sub) {
    if (!sub) return sub;
    await execute(
      `UPDATE subscriptions
          SET plan = 'free', status = 'active', trial_ends_at = NULL, expiry_date = ?, seats = ?,
              cancel_at_period_end = 0
        WHERE id = ? AND trial_ends_at IS NOT NULL AND stripe_subscription_id IS NULL`,
      [planExpiry('free'), planSeats('free'), sub.id]
    );
    return Subscription.findById(sub.id);
  },

  // Lazy trial expiry: when trial_ends_at has passed and the row is not a paid
  // Stripe subscription, downgrade to free/active. Returns the (possibly
  // refreshed) row; a non-trial or still-running trial is returned untouched.
  async expireTrialIfNeeded(sub) {
    if (!isTrialExpired(sub)) return sub;
    return Subscription.endTrial(sub);
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

      // `cancelled` and `expired` are the two states somebody CHOSE — an admin
      // stopping a licence, or a cancellation. Nothing that merely runs out
      // ever lands here (Subscription.current downgrades a lapsed plan to
      // free/active instead), so a row in one of these states is an
      // administrative decision. The trial used to overwrite it in place,
      // reusing the same subscription id and the same licence key, which turned
      // "stop this licence" into "seven days of Pro on the very key that was
      // stopped".
      if (current && (current.status === 'cancelled' || current.status === 'expired'))
        return { ok: false, reason: 'subscription_stopped' };

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
