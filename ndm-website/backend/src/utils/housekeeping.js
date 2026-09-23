'use strict';

/**
 * Periodic clean-up of the things that only ever grow: dead browser sessions,
 * old security events, spent Google ID-token ids, expired rate-limit counters
 * and abandoned upload temp files. Runs inside the API process on a timer
 * (server.js) because the shared host has no reliable cron for the backend —
 * the keepalive job only checks health — and each pass is a handful of bounded
 * DELETEs plus one directory listing.
 *
 * Every step is independent and non-fatal: one failing table must not stop
 * the others, and nothing here is allowed to take the API down.
 */

const { execute } = require('../config/db');
const UserSession = require('../models/UserSession');
const DeviceAuth = require('../models/DeviceAuth');
const security = require('./securityEvents');
const { sweepIncoming } = require('./releaseFiles');

const INTERVAL_MS = 6 * 60 * 60 * 1000;
const SECURITY_EVENT_DAYS = 90;

async function step(name, fn) {
  try {
    const n = await fn();
    return `${name}=${n}`;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[housekeeping] ${name} failed:`, err.message);
    return `${name}=error`;
  }
}

async function runOnce() {
  const results = await Promise.all([
    step('sessions', () => UserSession.pruneDead()),
    step('device_auth', () => DeviceAuth.prune()),
    step('security_events', () => security.prune(SECURITY_EVENT_DAYS)),
    step('used_id_tokens', async () => (await execute('DELETE FROM used_id_tokens WHERE expires_at <= NOW()')).affectedRows || 0),
    step('rate_limits', async () => (await execute('DELETE FROM rate_limits WHERE expires_at <= NOW()')).affectedRows || 0),
    // The only step that touches the filesystem rather than a table. A partial
    // installer can be hundreds of megabytes, and on shared hosting the disk
    // quota is the thing that runs out first.
    step('incoming_uploads', () => sweepIncoming()),
  ]);
  // eslint-disable-next-line no-console
  console.log(`[housekeeping] pruned ${results.join(' ')}`);
  return results;
}

/** First pass a minute after boot (schema init is done by then), then every six hours. */
function schedule() {
  const first = setTimeout(() => {
    runOnce().catch(() => {});
    const timer = setInterval(() => runOnce().catch(() => {}), INTERVAL_MS);
    timer.unref();
  }, 60 * 1000);
  first.unref();
}

module.exports = { runOnce, schedule, INTERVAL_MS };
