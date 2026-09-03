'use strict';

/**
 * Telemetry for licence tokens that are structurally a bearer token but fail
 * verification.
 *
 * Why this is worth recording: a genuine client never sends one. It holds a
 * token this server signed, and replaces it every five minutes from
 * /heartbeat. So a request arriving with a token that does not verify is
 * somebody constructing tokens by hand — which is exactly what testing a crack
 * against the server looks like. The reason it failed says which attack:
 * `bad_signature` is forgery, `bad_algorithm` is the HS256-with-the-public-key
 * confusion attempt, and both are unambiguous.
 *
 * `expired` is deliberately tracked separately and NOT treated as an attack:
 * a client whose clock is off, or one that slept through its heartbeats, will
 * produce those honestly.
 *
 * Counts go into hourly buckets rather than a row per rejection. A row per
 * rejection would let anyone flood the table by sending garbage in a loop —
 * turning a security signal into a disk-space attack. Buckets bound the writes
 * to one upsert per hour per reason no matter how much noise arrives.
 */

const { query, execute } = require('../config/db');

const TABLE = 'license_token_rejections';

// Reasons, from the messages utils/ed25519Jwt.js throws. Anything unrecognised
// becomes 'other' rather than being interpolated into a column — the message
// is derived from attacker-supplied input.
const REASONS = ['bad_signature', 'bad_algorithm', 'malformed', 'expired', 'wrong_type', 'other'];

// Rejections in one hour beyond which the server says so loudly. A handful is
// background noise (an old build, a stale token, a bored port-scanner); a
// hundred forged signatures in an hour is somebody working on a crack.
const ALERT_THRESHOLD_PER_HOUR = 100;

/**
 * Map a verification error to a stable reason code.
 * Pure — no I/O — so the classification can be tested directly.
 */
function classifyRejection(error) {
  const message = String((error && error.message) || '').toLowerCase();
  if (message.includes('algorithm')) return 'bad_algorithm';
  if (message.includes('signature')) return 'bad_signature';
  if (message.includes('expired')) return 'expired';
  if (message.includes('token type')) return 'wrong_type';
  if (message.includes('malformed') || message.includes('exp') || message.includes('string'))
    return 'malformed';
  return 'other';
}

/** True for the reasons that only a hand-built token produces. */
function isAttackReason(reason) {
  return reason === 'bad_signature' || reason === 'bad_algorithm' || reason === 'wrong_type';
}

// Remembers which hours have already been shouted about, so a sustained attack
// logs once an hour rather than once a request.
const alerted = new Set();

/**
 * Record one rejection. Never throws and never blocks the caller's response —
 * telemetry must not be able to break the endpoint it observes.
 */
async function recordRejection(reason) {
  const safe = REASONS.includes(reason) ? reason : 'other';
  try {
    await execute(
      `INSERT INTO ${TABLE} (bucket_hour, reason, count)
       VALUES (DATE_FORMAT(NOW(), '%Y-%m-%d %H:00:00'), ?, 1)
       ON DUPLICATE KEY UPDATE count = count + 1`,
      [safe]
    );
    if (isAttackReason(safe)) await maybeAlert(safe);
  } catch {
    // A telemetry write failing is not worth failing a request over.
  }
}

async function maybeAlert(reason) {
  const rows = await query(
    `SELECT count FROM ${TABLE}
      WHERE bucket_hour = DATE_FORMAT(NOW(), '%Y-%m-%d %H:00:00') AND reason = ?`,
    [reason]
  );
  const count = Number(rows[0] && rows[0].count) || 0;
  if (count < ALERT_THRESHOLD_PER_HOUR) return;

  const key = `${new Date().toISOString().slice(0, 13)}:${reason}`;
  if (alerted.has(key)) return;
  alerted.add(key);
  // Deliberately loud and greppable. Whoever watches the logs should be able to
  // find this without knowing it exists.
  console.warn(
    `[SECURITY] ${count} licence tokens rejected as ${reason} in the current hour — `
    + 'this is consistent with someone testing forged tokens against the API.'
  );
}

/** Rejection counts per reason over the last `hours`, newest bucket first. */
async function recentRejections({ hours = 24 } = {}) {
  const window = Math.max(1, Math.min(24 * 30, Number(hours) || 24));
  const rows = await query(
    `SELECT bucket_hour, reason, count
       FROM ${TABLE}
      WHERE bucket_hour >= DATE_SUB(NOW(), INTERVAL ? HOUR)
      ORDER BY bucket_hour DESC, reason`,
    [window]
  );
  const totals = {};
  for (const row of rows) {
    totals[row.reason] = (totals[row.reason] || 0) + Number(row.count || 0);
  }
  return {
    hours: window,
    totals,
    attackTotal: Object.entries(totals)
      .filter(([reason]) => isAttackReason(reason))
      .reduce((sum, [, n]) => sum + n, 0),
    buckets: rows,
    alertThresholdPerHour: ALERT_THRESHOLD_PER_HOUR,
  };
}

module.exports = {
  classifyRejection, isAttackReason, recordRejection, recentRejections,
  REASONS, ALERT_THRESHOLD_PER_HOUR, TABLE,
};
