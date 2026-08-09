'use strict';

const { query, queryOne, insert, execute } = require('../config/db');

const User = {
  async findById(id) {
    return queryOne('SELECT * FROM users WHERE id = ?', [id]);
  },

  async findByEmail(email) {
    return queryOne('SELECT * FROM users WHERE email = ?', [String(email).toLowerCase()]);
  },

  async findByRefreshTokenHash(hash) {
    return queryOne('SELECT * FROM users WHERE refresh_token_hash = ?', [hash]);
  },

  async create({ name, email, passwordHash, role, emailVerified }) {
    const id = await insert(
      'INSERT INTO users (name, email, password_hash, role, email_verified) VALUES (?, ?, ?, ?, ?)',
      [name, String(email).toLowerCase(), passwordHash, role || 'user', emailVerified ? 1 : 0]
    );
    return User.findById(id);
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
    await execute(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals);
  },

  async count(filter = {}) {
    const where = [];
    const vals = [];
    if (filter.banned !== undefined) { where.push('banned = ?'); vals.push(filter.banned ? 1 : 0); }
    if (filter.emailVerified !== undefined) { where.push('email_verified = ?'); vals.push(filter.emailVerified ? 1 : 0); }
    if (filter.role) { where.push('role = ?'); vals.push(filter.role); }
    const sql = `SELECT COUNT(*) AS cnt FROM users${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
    const r = await queryOne(sql, vals);
    return r ? r.cnt : 0;
  },

  async list({ page = 1, limit = 20, q, role, banned, emailVerified } = {}) {
    const where = [];
    const vals = [];
    if (q) {
      where.push('(name LIKE ? OR email LIKE ?)');
      vals.push(`%${q}%`, `%${q}%`);
    }
    if (role) { where.push('role = ?'); vals.push(role); }
    if (banned !== undefined) { where.push('banned = ?'); vals.push(banned ? 1 : 0); }
    if (emailVerified !== undefined) { where.push('email_verified = ?'); vals.push(emailVerified ? 1 : 0); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const pageNumber = Math.max(1, Number(page) || 1);
    const limitNumber = Math.min(200, Math.max(1, Number(limit) || 20));
    const offset = (pageNumber - 1) * limitNumber;
    const rows = await query(
      `SELECT id, name, email, role, email_verified, banned, created_at, updated_at FROM users ${w} ORDER BY created_at DESC LIMIT ${limitNumber} OFFSET ${offset}`,
      vals
    );
    const total = await queryOne(
      `SELECT COUNT(*) AS cnt FROM users ${w}`,
      vals
    );
    return { users: rows, totalCount: total ? total.cnt : 0 };
  },

  async listAll({ q, role, banned, emailVerified } = {}) {
    const where = [];
    const vals = [];
    if (q) {
      where.push('(name LIKE ? OR email LIKE ?)');
      vals.push(`%${q}%`, `%${q}%`);
    }
    if (role) { where.push('role = ?'); vals.push(role); }
    if (banned !== undefined) { where.push('banned = ?'); vals.push(banned ? 1 : 0); }
    if (emailVerified !== undefined) { where.push('email_verified = ?'); vals.push(emailVerified ? 1 : 0); }
    const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
    return query(
      `SELECT id, name, email, role, email_verified, banned, created_at, updated_at
       FROM users${w} ORDER BY created_at DESC`,
      vals
    );
  },

  async signupAgg(days = 30) {
    const safeDays = Math.min(365, Math.max(1, Number(days) || 30));
    return query(
      `SELECT DATE(created_at) AS date, COUNT(*) AS count FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${safeDays} DAY) GROUP BY DATE(created_at) ORDER BY date`
    );
  },
};

module.exports = User;
