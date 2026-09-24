'use strict';

const { getPool } = require('../config/db');

const LicenseEmailDelivery = {
  async claim(eventId, userId, licenseKey, plan) {
    const pool = await getPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      // A plain INSERT, and the duplicate-key error is what says "this event
      // was claimed before". It used to be `INSERT … ON DUPLICATE KEY UPDATE
      // event_id = event_id` checked for affectedRows === 1 — but mysql2
      // connects with CLIENT_FOUND_ROWS, so the no-op update of an existing
      // row ALSO reports 1. Every redelivery was "claimed", the sent /
      // in-progress branches below were unreachable, and a retried event
      // mailed the licence again. INSERT IGNORE would report 0 correctly, but
      // it also downgrades every other error (a bad user_id, say) to a
      // warning; catching exactly ER_DUP_ENTRY does not.
      let inserted = false;
      try {
        await connection.execute(
          `INSERT INTO license_email_deliveries
             (event_id, user_id, license_key, plan, status, attempts)
           VALUES (?, ?, ?, ?, 'processing', 1)`,
          [eventId, userId, licenseKey, plan]
        );
        inserted = true;
      } catch (err) {
        if (!err || err.code !== 'ER_DUP_ENTRY') throw err;
      }
      if (inserted) {
        await connection.commit();
        return 'claimed';
      }
      const [rows] = await connection.execute(
        'SELECT status, updated_at FROM license_email_deliveries WHERE event_id = ? FOR UPDATE',
        [eventId]
      );
      const row = rows[0];
      if (row.status === 'sent') {
        await connection.commit();
        return 'sent';
      }
      const updatedAt = new Date(row.updated_at).getTime();
      if (row.status === 'processing' && Date.now() - updatedAt < 5 * 60 * 1000) {
        await connection.commit();
        return 'in_progress';
      }
      await connection.execute(
        `UPDATE license_email_deliveries
            SET status = 'processing', attempts = attempts + 1, last_error = NULL,
                license_key = ?, plan = ?
          WHERE event_id = ?`,
        [licenseKey, plan, eventId]
      );
      await connection.commit();
      return 'claimed';
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  },

  /**
   * Has this event's licence email already gone out? The grant is committed
   * BEFORE the email is claimed, so "sent" also means "this event's grant is
   * already in the database" — which lets a redelivery skip re-running it.
   */
  async wasSent(eventId) {
    const pool = await getPool();
    const [rows] = await pool.execute(
      'SELECT status FROM license_email_deliveries WHERE event_id = ?', [eventId]
    );
    return Boolean(rows[0] && rows[0].status === 'sent');
  },

  async markSent(eventId) {
    const pool = await getPool();
    await pool.execute(
      `UPDATE license_email_deliveries
          SET status = 'sent', sent_at = CURRENT_TIMESTAMP, last_error = NULL
        WHERE event_id = ?`, [eventId]
    );
  },

  async markFailed(eventId, error) {
    const pool = await getPool();
    await pool.execute(
      'UPDATE license_email_deliveries SET status = \'failed\', last_error = ? WHERE event_id = ?',
      [String(error && error.message ? error.message : error).slice(0, 500), eventId]
    );
  },
};

module.exports = LicenseEmailDelivery;