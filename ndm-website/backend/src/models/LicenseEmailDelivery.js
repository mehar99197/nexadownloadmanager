'use strict';

const { getPool } = require('../config/db');

const LicenseEmailDelivery = {
  async claim(eventId, userId, licenseKey, plan) {
    const pool = await getPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [insertResult] = await connection.execute(
        `INSERT INTO license_email_deliveries
           (event_id, user_id, license_key, plan, status, attempts)
         VALUES (?, ?, ?, ?, 'processing', 1)
         ON DUPLICATE KEY UPDATE event_id = event_id`,
        [eventId, userId, licenseKey, plan]
      );
      if (insertResult.affectedRows === 1) {
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