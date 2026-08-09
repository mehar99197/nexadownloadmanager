'use strict';

const crypto = require('crypto');
const { getPool } = require('../config/db');

const STALE_AFTER_MS = 5 * 60 * 1000;

function payloadHash(raw) {
  const body = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ''), 'utf8');
  return crypto.createHash('sha256').update(body).digest('hex');
}

const StripeEvent = {
  async claim(event, raw) {
    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        `SELECT event_id, status, payload_sha256, updated_at
           FROM stripe_webhook_events WHERE event_id = ? FOR UPDATE`,
        [event.id]
      );
      const hash = payloadHash(raw);
      if (!rows.length) {
        await conn.execute(
          `INSERT INTO stripe_webhook_events
             (event_id, event_type, payload_sha256, status, attempts)
           VALUES (?, ?, ?, 'processing', 1)`,
          [event.id, event.type || 'unknown', hash]
        );
        await conn.commit();
        return 'claimed';
      }

      const existing = rows[0];
      if (existing.payload_sha256 !== hash)
        throw new Error(`Stripe event ${event.id} payload changed between deliveries`);
      if (existing.status === 'processed') {
        await conn.commit();
        return 'processed';
      }

      const updatedAt = new Date(existing.updated_at).getTime();
      if (existing.status === 'processing' && Date.now() - updatedAt < STALE_AFTER_MS) {
        await conn.commit();
        return 'in_progress';
      }

      await conn.execute(
        `UPDATE stripe_webhook_events
            SET event_type = ?, payload_sha256 = ?, status = 'processing',
                attempts = attempts + 1, last_error = NULL
          WHERE event_id = ?`,
        [event.type || 'unknown', hash, event.id]
      );
      await conn.commit();
      return 'claimed';
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  async markProcessed(eventId) {
    const pool = await getPool();
    await pool.execute(
      `UPDATE stripe_webhook_events
          SET status = 'processed', processed_at = CURRENT_TIMESTAMP, last_error = NULL
        WHERE event_id = ?`,
      [eventId]
    );
  },

  async markFailed(eventId, error) {
    const pool = await getPool();
    await pool.execute(
      `UPDATE stripe_webhook_events SET status = 'failed', last_error = ? WHERE event_id = ?`,
      [String(error && error.message ? error.message : error).slice(0, 500), eventId]
    );
  },
};

module.exports = StripeEvent;