'use strict';

const { query, insert } = require('../config/db');

function parseMetadata(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return value; }
}

const AuditLog = {
  async create({ adminUserId, action, entityType, entityId = null, summary, metadata = null }) {
    const id = await insert(
      `INSERT INTO audit_logs (admin_user_id, action, entity_type, entity_id, summary, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [adminUserId || null, action, entityType, entityId, summary, metadata ? JSON.stringify(metadata) : null]
    );
    return id;
  },

  async listRecent(limit = 25) {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
    const rows = await query(
      `SELECT a.*, u.name AS admin_name, u.email AS admin_email
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.admin_user_id
       ORDER BY a.created_at DESC LIMIT ${safeLimit}`
    );
    return rows.map((row) => ({ ...row, metadata: parseMetadata(row.metadata) }));
  },
};

module.exports = AuditLog;
