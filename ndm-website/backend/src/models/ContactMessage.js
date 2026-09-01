'use strict';

const { query, queryOne, insert, execute } = require('../config/db');

/**
 * A message from the website's contact form, plus the admin replies to it.
 *
 * The row is written BEFORE the notification email is attempted, so a message
 * is never lost to an SMTP outage — `email_delivered` records whether the
 * support inbox actually got the notification.
 */
const ContactMessage = {
  async findById(id) {
    return queryOne('SELECT * FROM contact_messages WHERE id = ?', [id]);
  },

  async create({ userId, name, email, topic, message, ip, userAgent }) {
    const id = await insert(
      `INSERT INTO contact_messages (user_id, name, email, topic, message, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId || null, name || '', String(email).toLowerCase(), topic || 'general',
       message, ip || null, userAgent || null]
    );
    return ContactMessage.findById(id);
  },

  async markEmailDelivered(id, delivered) {
    await execute('UPDATE contact_messages SET email_delivered = ? WHERE id = ?',
      [delivered ? 1 : 0, id]);
  },

  async updateStatus(id, status) {
    await execute('UPDATE contact_messages SET status = ? WHERE id = ?', [status, id]);
    return ContactMessage.findById(id);
  },

  /**
   * Stamp a thread as replied. `status` only moves forward to 'replied' when the
   * thread is not already closed — an admin who deliberately closed a thread and
   * then sent a parting note should not see it jump back into the open queue.
   */
  async markReplied(id, adminUserId) {
    await execute(
      `UPDATE contact_messages
          SET status = IF(status = 'closed', 'closed', 'replied'),
              replied_at = UTC_TIMESTAMP(), replied_by = ?
        WHERE id = ?`,
      [adminUserId || null, id]
    );
    return ContactMessage.findById(id);
  },

  async remove(id) {
    const result = await execute('DELETE FROM contact_messages WHERE id = ?', [id]);
    return result.affectedRows || 0;
  },

  async list({ page = 1, limit = 20, status, topic, q } = {}) {
    const where = [];
    const vals = [];
    if (status) { where.push('m.status = ?'); vals.push(status); }
    if (topic) { where.push('m.topic = ?'); vals.push(topic); }
    if (q) {
      where.push('(m.name LIKE ? OR m.email LIKE ? OR m.message LIKE ?)');
      vals.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const pageNumber = Math.max(1, Number(page) || 1);
    const limitNumber = Math.min(200, Math.max(1, Number(limit) || 20));
    const offset = (pageNumber - 1) * limitNumber;
    // MariaDB does not accept bound parameters for LIMIT/OFFSET, so both are
    // clamped to numbers and interpolated (same pattern as Review/User).
    const messages = await query(
      `SELECT m.*, u.name AS replied_by_name,
              (SELECT COUNT(*) FROM contact_replies r WHERE r.message_id = m.id) AS reply_count
         FROM contact_messages m
         LEFT JOIN users u ON u.id = m.replied_by
         ${clause}
        ORDER BY m.created_at DESC
        LIMIT ${limitNumber} OFFSET ${offset}`,
      vals
    );
    const countRow = await queryOne(
      `SELECT COUNT(*) AS cnt FROM contact_messages m${clause}`, vals
    );
    return { messages, totalCount: Number(countRow?.cnt || 0) };
  },

  async count(filter = {}) {
    const where = [];
    const vals = [];
    if (filter.status) { where.push('status = ?'); vals.push(filter.status); }
    if (filter.topic) { where.push('topic = ?'); vals.push(filter.topic); }
    const sql = `SELECT COUNT(*) AS cnt FROM contact_messages${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
    const row = await queryOne(sql, vals);
    return Number(row?.cnt || 0);
  },

  /** Roll-up for the admin dashboard tile: how much is waiting for an answer. */
  async stats() {
    const row = await queryOne(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(status = 'new'), 0) AS unread,
              COALESCE(SUM(status IN ('new', 'open')), 0) AS awaiting,
              COALESCE(SUM(status = 'replied'), 0) AS replied
         FROM contact_messages`
    );
    return {
      total: Number(row?.total || 0),
      unread: Number(row?.unread || 0),
      awaiting: Number(row?.awaiting || 0),
      replied: Number(row?.replied || 0),
    };
  },

  async listReplies(messageId) {
    return query(
      `SELECT id, message_id, admin_user_id, admin_name, body, delivered, delivery_error, created_at
         FROM contact_replies WHERE message_id = ? ORDER BY created_at ASC`,
      [messageId]
    );
  },

  async addReply({ messageId, adminUserId, adminName, body, delivered, deliveryError }) {
    const id = await insert(
      `INSERT INTO contact_replies
         (message_id, admin_user_id, admin_name, body, delivered, delivery_error)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [messageId, adminUserId || null, adminName || '', body,
       delivered ? 1 : 0, deliveryError ? String(deliveryError).slice(0, 255) : null]
    );
    return queryOne('SELECT * FROM contact_replies WHERE id = ?', [id]);
  },
};

module.exports = ContactMessage;
