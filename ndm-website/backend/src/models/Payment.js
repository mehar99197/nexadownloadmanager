'use strict';

const { query, queryOne, insert } = require('../config/db');

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

  async listRecent(limit = 10) {
    const limitNumber = Math.min(200, Math.max(1, Number(limit) || 10));
    return query(
      `SELECT p.*, u.email AS userEmail, u.name AS userName
       FROM payments p JOIN users u ON u.id = p.user_id
       ORDER BY p.created_at DESC LIMIT ${limitNumber}`
    );
  },

  async revenueByMonth(months = 6) {
    const safeMonths = Math.min(24, Math.max(1, Number(months) || 6));
    return query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month,
              COALESCE(SUM(amount), 0) AS revenue,
              COUNT(*) AS payments
       FROM payments
       WHERE status = 'paid'
         AND created_at >= DATE_SUB(CURRENT_DATE, INTERVAL ${safeMonths} MONTH)
       GROUP BY DATE_FORMAT(created_at, '%Y-%m')
       ORDER BY month`
    );
  },
};

module.exports = Payment;
