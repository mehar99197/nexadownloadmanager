'use strict';

/**
 * Security events: the record a SIEM would be fed, kept in MySQL and on the
 * API log, with the handful of alert rules that matter for a site this size
 * evaluated as the events land.
 *
 *   record(kind, { req, user, email, severity, detail })
 *
 * Never throws and never blocks the request that produced it: a broken
 * recorder must not turn a sign-in into a 500, so every failure is logged
 * and swallowed. Each event is also printed as ONE JSON line prefixed
 * `[security]` so a log shipper (Papertrail, Better Stack, Grafana Loki…)
 * can pick it up from logs/api.log without touching the database.
 *
 * Alerts go by email (SECURITY_ALERT_EMAIL, default ROOT_ADMIN_EMAIL):
 *   - any `critical` event, at once, with a per-kind cooldown so a storm
 *     produces one mail, not a thousand;
 *   - too many failed sign-ins across accounts in a short window
 *     (credential stuffing looks exactly like this);
 *   - too many lockouts in an hour (a spray across many accounts).
 * The counters are queried, not kept in memory, so a keepalive restart does
 * not lose the last ten minutes.
 */

const { query, insert, execute } = require('../config/db');
const config = require('../config/env');

const SEVERITIES = new Set(['info', 'warning', 'critical']);

// Thresholds. Small on purpose: the site sees tens of sign-ins a day, so
// twenty failures in ten minutes is not a busy morning, it is a script.
const RULES = {
  loginFailures: { kind: 'login.failed', windowMinutes: 10, threshold: 20 },
  lockouts: { kind: 'login.locked', windowMinutes: 60, threshold: 5 },
  twoFactorFailures: { kind: '2fa.failed', windowMinutes: 10, threshold: 15 },
};
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const lastAlertAt = new Map();

function clip(value, max) {
  if (value === undefined || value === null) return null;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? s.slice(0, max) : s;
}

function requestFacts(req) {
  if (!req) return { ip: null, userAgent: null };
  return {
    ip: clip(req.ip, 45),
    userAgent: clip(req.get ? req.get('user-agent') : req.headers?.['user-agent'], 255),
  };
}

let mailer = null;
function sendAlert(subject, text) {
  // Lazy: utils/email.js requires config and nodemailer; this module is
  // required from the auth routes at boot, before any of that matters.
  if (!mailer) mailer = require('./email');
  const to = config.SECURITY_ALERT_EMAIL || config.ROOT_ADMIN_EMAIL;
  if (!to) return Promise.resolve();
  return mailer.sendSecurityAlertEmail(to, subject, text);
}

function cooledDown(key) {
  const now = Date.now();
  const last = lastAlertAt.get(key) || 0;
  if (now - last < ALERT_COOLDOWN_MS) return false;
  lastAlertAt.set(key, now);
  return true;
}

async function countRecent(kind, minutes) {
  const rows = await query(
    'SELECT COUNT(*) AS n FROM security_events WHERE kind = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)',
    [kind, minutes]
  );
  return rows.length ? Number(rows[0].n) || 0 : 0;
}

async function evaluateRules(event) {
  if (event.severity === 'critical' && cooledDown(`critical:${event.kind}`)) {
    await sendAlert(
      `[security] ${event.kind}`,
      `A critical security event was recorded on ${config.FRONTEND_URL}:\n\n`
      + `kind:    ${event.kind}\nwhen:    ${new Date().toISOString()}\n`
      + `account: ${event.email || event.userId || '-'}\nip:      ${event.ip || '-'}\n`
      + `detail:  ${event.detail || '-'}\n\n`
      + 'Further events of this kind are not mailed for the next 30 minutes; the admin panel (Security) has all of them.'
    );
  }
  for (const rule of Object.values(RULES)) {
    if (rule.kind !== event.kind) continue;
    const n = await countRecent(rule.kind, rule.windowMinutes);
    if (n >= rule.threshold && cooledDown(`rule:${rule.kind}`)) {
      await sendAlert(
        `[security] ${n} × ${rule.kind} in ${rule.windowMinutes} minutes`,
        `${n} "${rule.kind}" events were recorded on ${config.FRONTEND_URL} in the last ${rule.windowMinutes} minutes `
        + `(alert threshold ${rule.threshold}).\n\nLatest: ${event.email || '-'} from ${event.ip || '-'}.\n\n`
        + 'This is the shape of a credential-stuffing or password-spraying run. The per-account lockout and the '
        + 'per-address limiters are holding; if the source is a single network, block it at the CDN/WAF. '
        + 'Not mailed again for 30 minutes.'
      );
    }
  }
}

/**
 * Record one event. Resolves once the row is written; alert evaluation runs
 * after that and is not awaited by callers who pass `await` only to the
 * write (they get the event back either way).
 */
async function record(kind, { req, user, email, severity = 'info', detail } = {}) {
  const facts = requestFacts(req);
  const event = {
    kind: clip(kind, 50),
    severity: SEVERITIES.has(severity) ? severity : 'info',
    userId: user ? Number(user.id) || null : null,
    email: clip(email || (user && user.email), 255),
    ip: facts.ip,
    userAgent: facts.userAgent,
    detail: clip(detail, 2000),
  };
  try {
    await insert(
      `INSERT INTO security_events (kind, severity, user_id, email, ip, user_agent, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [event.kind, event.severity, event.userId, event.email, event.ip, event.userAgent, event.detail]
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[security] event not recorded:', err.message);
  }
  // eslint-disable-next-line no-console
  console.log('[security] ' + JSON.stringify({ t: new Date().toISOString(), ...event }));
  evaluateRules(event).catch((err) =>
    // eslint-disable-next-line no-console
    console.error('[security] alert evaluation failed:', err.message));
  return event;
}

/** For the admin panel: recent events, newest first, optional kind filter. */
async function listRecent({ hours = 24, kind, limit = 200 } = {}) {
  const safeHours = Math.max(1, Math.min(24 * 30, Number(hours) || 24));
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
  const where = ['created_at > DATE_SUB(NOW(), INTERVAL ? HOUR)'];
  const vals = [safeHours];
  if (kind) { where.push('kind = ?'); vals.push(String(kind).slice(0, 50)); }
  const events = await query(
    `SELECT id, kind, severity, user_id, email, ip, user_agent, detail, created_at
       FROM security_events WHERE ${where.join(' AND ')}
      ORDER BY id DESC LIMIT ${safeLimit}`,
    vals
  );
  const counts = await query(
    `SELECT kind, severity, COUNT(*) AS n FROM security_events
      WHERE created_at > DATE_SUB(NOW(), INTERVAL ? HOUR)
      GROUP BY kind, severity ORDER BY n DESC`,
    [safeHours]
  );
  return { hours: safeHours, events, counts: counts.map((c) => ({ ...c, n: Number(c.n) })) };
}

/** Events older than `days` are dropped; run from the daily maintenance job. */
async function prune(days = 90) {
  const result = await execute(
    'DELETE FROM security_events WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
    [Math.max(7, Number(days) || 90)]
  );
  return result.affectedRows || 0;
}

module.exports = { record, listRecent, prune, RULES, ALERT_COOLDOWN_MS, _lastAlertAt: lastAlertAt };
