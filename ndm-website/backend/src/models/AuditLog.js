'use strict';

const { query, insert } = require('../config/db');

function parseMetadata(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return value; }
}

// The columns these go into are VARCHAR(80)/VARCHAR(50)/VARCHAR(255). MySQL in
// STRICT mode rejects an over-long value outright, and every audit line is
// written AFTER the thing it records — so a 200-character filename or a long
// email address turned a completed admin action into a 500, with the action
// done and no record of it. Truncating here is the right trade: an audit line
// that is slightly short still says who did what, while a missing one says
// nothing at all.
function clamp(value, max) {
  const text = value === null || value === undefined ? '' : String(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}

const AuditLog = {
  MAX_LIMIT: 200,

  async create({ adminUserId, action, entityType, entityId = null, summary, metadata = null }) {
    const id = await insert(
      `INSERT INTO audit_logs (admin_user_id, action, entity_type, entity_id, summary, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [adminUserId || null, clamp(action, 80), clamp(entityType, 50), entityId,
       clamp(summary, 255), metadata ? JSON.stringify(metadata) : null]
    );
    return id;
  },

  // The ceiling matches the schemas in front of it (limitQuerySchema and the
  // root auditQuerySchema both allow 200, and the creator's audit screen asks
  // for 200). It used to be 100 here, so that screen promised 200 rows and
  // quietly received half.
  async listRecent(limit = 25) {
    const safeLimit = Math.min(AuditLog.MAX_LIMIT, Math.max(1, Number(limit) || 25));
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
