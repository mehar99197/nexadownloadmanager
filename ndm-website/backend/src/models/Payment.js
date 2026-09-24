'use strict';

const { query, queryOne, insert, execute } = require('../config/db');
const { lastMonths } = require('../utils/revenue');

const Payment = {
  async findByUserId(userId, { page = 1, limit = 20 } = {}) {
    const pageNumber = Math.max(1, Number(page) || 1);
    const limitNumber = Math.min(200, Math.max(1, Number(limit) || 20));
    const offset = (pageNumber - 1) * limitNumber;
    return query(
      `SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT ${limitNumber} OFFSET ${offset}`,
      [userId]
    );
  },

  async create({ userId, amount, currency, plan, billingCycle, stripePaymentId, status }) {
    const id = await insert(
      `INSERT INTO payments (user_id, amount, currency, plan, billing_cycle, stripe_payment_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      [userId, amount, currency || 'usd', plan, billingCycle, stripePaymentId || null, status || 'paid']
    );
    return queryOne('SELECT * FROM payments WHERE id = ?', [id]);
  },

  /**
   * Mark a charge refunded. `payments.status` has always had this value and
   * nothing ever wrote it, so a refunded month kept counting toward the revenue
   * chart (`revenueByMonth` filters on status='paid') and the MRR tile.
   * Returns true when a row was actually updated.
   */
  async markRefunded(stripePaymentId) {
    const result = await execute(
      "UPDATE payments SET status = 'refunded' WHERE stripe_payment_id = ? AND status <> 'refunded'",
      [stripePaymentId]
    );
    return (result.affectedRows || 0) > 0;
  },

  async listRecent(limit = 10) {
    const limitNumber = Math.min(200, Math.max(1, Number(limit) || 10));
    // LEFT JOIN: a payment outlives a deleted account (user_id is set NULL,
    // not cascaded), and it still belongs in the list and in the totals.
    return query(
      `SELECT p.*, u.email AS userEmail,
              CASE WHEN u.id IS NULL THEN 'Deleted account' ELSE u.name END AS userName
       FROM payments p LEFT JOIN users u ON u.id = p.user_id
       ORDER BY p.created_at DESC LIMIT ${limitNumber}`
    );
  },

  /**
   * Paid revenue for exactly the last `months` calendar months, the current one
   * included, oldest first — one bucket per month, zero-filled.
   *
   * The window used to start `months` months before TODAY, which is partway
   * through a month: six months asked for came back as up to seven buckets,
   * the first holding only the tail end of its month, and a month with no
   * payments had no bucket at all, so the bars no longer lined up with months.
   */
  async revenueByMonth(months = 6, now = new Date()) {
    const safeMonths = Math.min(24, Math.max(1, Number(months) || 6));
    const keys = lastMonths(safeMonths, now);
    const rows = await query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month,
              COALESCE(SUM(amount), 0) AS revenue,
              COUNT(*) AS payments
       FROM payments
       WHERE status = 'paid'
         AND created_at >= ?
       GROUP BY DATE_FORMAT(created_at, '%Y-%m')
       ORDER BY month`,
      [`${keys[0]}-01 00:00:00`]
    );
    const byMonth = new Map(rows.map((r) => [r.month, r]));
    return keys.map((month) => {
      const row = byMonth.get(month);
      return {
        month,
        revenue: row ? Number(row.revenue) || 0 : 0,
        payments: row ? Number(row.payments) || 0 : 0,
      };
    });
  },
};

module.exports = Payment;
