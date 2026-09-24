'use strict';

const { query, queryOne, insert, execute } = require('../config/db');

const Review = {
  async findById(id) {
    return queryOne('SELECT * FROM reviews WHERE id = ?', [id]);
  },

  async findByUserId(userId) {
    return queryOne('SELECT * FROM reviews WHERE user_id = ?', [userId]);
  },

  async create({ userId, userName, rating, comment, status }) {
    const id = await insert(
      'INSERT INTO reviews (user_id, user_name, rating, comment, status) VALUES (?, ?, ?, ?, ?)',
      [userId, userName, rating, comment, status || 'pending']
    );
    return Review.findById(id);
  },

  // One review per account, decided by the database: reviews.user_id is
  // UNIQUE (uq_reviews_user, config/schema.js), so this single statement either
  // creates the row or edits the existing one. The old find-then-insert let two
  // requests in flight together both insert, and the public average then
  // counted that person twice. An edit goes back to moderation.
  async upsertByUserId(userId, { userName, rating, comment }) {
    await execute(
      `INSERT INTO reviews (user_id, user_name, rating, comment, status) VALUES (?, ?, ?, ?, 'pending')
       ON DUPLICATE KEY UPDATE user_name = VALUES(user_name), rating = VALUES(rating),
                               comment = VALUES(comment), status = 'pending'`,
      [userId, userName, rating, comment]
    );
    return Review.findByUserId(userId);
  },

  async listApproved({ page = 1, limit = 10, rating } = {}) {
    const where = ["status = 'approved'"];
    const vals = [];
    if (rating !== undefined) { where.push('rating = ?'); vals.push(rating); }
    const offset = (page - 1) * limit;
    const rows = await query(
      // MariaDB does not accept bound parameters for LIMIT/OFFSET.
      `SELECT * FROM reviews WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
      vals
    );
    return rows;
  },

  async count(filter = {}) {
    const where = [];
    const vals = [];
    if (filter.status) { where.push('status = ?'); vals.push(filter.status); }
    if (filter.rating !== undefined) { where.push('rating = ?'); vals.push(filter.rating); }
    const sql = `SELECT COUNT(*) AS cnt FROM reviews${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
    const r = await queryOne(sql, vals);
    return r ? r.cnt : 0;
  },

  async avgRating() {
    const r = await queryOne("SELECT AVG(rating) AS avg FROM reviews WHERE status = 'approved'");
    return r && r.avg !== null ? Number(r.avg) : 0;
  },

  async ratingBreakdown() {
    const rows = await query(
      "SELECT rating, COUNT(*) AS count FROM reviews WHERE status = 'approved' GROUP BY rating"
    );
    const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of rows) {
      if (r.rating >= 1 && r.rating <= 5) breakdown[r.rating] = r.count;
    }
    return breakdown;
  },

  async listPending() {
    return query("SELECT * FROM reviews WHERE status = 'pending' ORDER BY created_at DESC");
  },

  async list({ page = 1, limit = 20, status, rating } = {}) {
    const where = [];
    const vals = [];
    if (status) { where.push('status = ?'); vals.push(status); }
    if (rating !== undefined) { where.push('rating = ?'); vals.push(rating); }
    const pageNumber = Math.max(1, Number(page) || 1);
    const limitNumber = Math.min(200, Math.max(1, Number(limit) || 20));
    const offset = (pageNumber - 1) * limitNumber;
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const reviews = await query(
      `SELECT * FROM reviews${clause} ORDER BY created_at DESC LIMIT ${limitNumber} OFFSET ${offset}`,
      vals
    );
    const countRows = await query(`SELECT COUNT(*) AS count FROM reviews${clause}`, vals);
    return { reviews, totalCount: Number(countRows[0]?.count || 0) };
  },

  async listByUserId(userId) {
    return query('SELECT * FROM reviews WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  },

  async updateMany(ids, status) {
    if (!ids.length) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const result = await execute(
      `UPDATE reviews SET status = ? WHERE id IN (${placeholders})`,
      [status, ...ids]
    );
    return result.affectedRows || 0;
  },

  async updateStatus(id, status) {
    await execute('UPDATE reviews SET status = ? WHERE id = ?', [status, id]);
    return Review.findById(id);
  },
};

module.exports = Review;
