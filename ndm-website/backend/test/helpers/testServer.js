'use strict';

/**
 * Boots the real Express app against a real MySQL database and returns a small
 * fetch-based client. These are integration tests on purpose: the risky part of
 * this backend is the SQL itself (transactions, seat caps, idempotency), and a
 * stubbed database would test the stub instead.
 *
 * Point it at a throwaway server with:
 *   MYSQL_HOST/PORT/USER/PASS/DB   (see test/README.md)
 * If no database is reachable, `available()` returns false and the suites skip
 * rather than fail, so `npm test` still works on a machine without MySQL.
 */

// Env must be set BEFORE src/config/env.js is required anywhere.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.MYSQL_HOST = process.env.MYSQL_HOST || '127.0.0.1';
process.env.MYSQL_PORT = process.env.MYSQL_PORT || '3399';
process.env.MYSQL_USER = process.env.MYSQL_USER || 'ndm';
process.env.MYSQL_PASS = process.env.MYSQL_PASS || 'test_password_at_least_16_chars';
process.env.MYSQL_DB = process.env.MYSQL_DB || 'ndm_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_value_that_is_long_enough_x1';
process.env.JWT_ADMIN_SECRET = process.env.JWT_ADMIN_SECRET || 'test_admin_secret_value_long_enough_x2';
process.env.LICENSE_JWT_SECRET = process.env.LICENSE_JWT_SECRET || 'test_license_secret_value_long_enough_x3';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
process.env.EMAIL_VERIFICATION_REQUIRED = process.env.EMAIL_VERIFICATION_REQUIRED || 'false';
// The public-stats floors (default 50 users / 100 downloads) would hide the
// tiny counts these tests create; disable them so assertions see real numbers.
process.env.STATS_MIN_USERS = process.env.STATS_MIN_USERS || '0';
process.env.STATS_MIN_DOWNLOADS = process.env.STATS_MIN_DOWNLOADS || '0';
// Loopback so the admin IP allowlist lets the tests through.
process.env.ADMIN_ALLOWED_IPS = process.env.ADMIN_ALLOWED_IPS || '127.0.0.1,::1,::ffff:127.0.0.1';
// The creator's address. It is what `requireRoot` matches on and what
// utils/reservedEmail.js keeps out of the public sign-up flow, so the suites
// need a known value to assert against.
process.env.ROOT_ADMIN_EMAIL = process.env.ROOT_ADMIN_EMAIL || 'creator@example.test';
// The breach check would call Have I Been Pwned from every sign-up in the
// suites; passwordPolicy.test.js covers it with a fake fetch instead.
process.env.PASSWORD_BREACH_CHECK = process.env.PASSWORD_BREACH_CHECK || 'false';

const app = require('../../src/app');
const { getPool, query } = require('../../src/config/db');
const { initSchema } = require('../../src/config/schema');

let server = null;
let baseUrl = null;
let dbUp = null;

async function available() {
  if (dbUp !== null) return dbUp;
  try {
    const pool = await getPool();
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    dbUp = true;
  } catch {
    dbUp = false;
  }
  return dbUp;
}

/** Start the app on an ephemeral port and make sure the schema exists. */
async function start() {
  if (server) return baseUrl;
  await initSchema();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

async function stop() {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
  try {
    const pool = await getPool();
    await pool.end();
  } catch {
    /* pool already closed */
  }
}

/** Empty every table so each suite starts from a known state. */
async function reset() {
  await query('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of [
    // rate_limits is durable now (middleware/rateLimitStore.js), so leftovers
    // from an earlier run would otherwise start a suite already throttled.
    'rate_limits', 'user_sessions', 'security_events', 'used_id_tokens',
    // Ad-event budgets. A nonce left over from an earlier run makes the first
    // report of a "new" token look like a replay, which is a confusing way to
    // fail — the counters are the thing under test.
    'ad_event_nonces',
    'license_activations', 'license_email_deliveries', 'stripe_webhook_events',
    'team_members',
    'contact_replies', 'contact_messages',
    'payments', 'reviews', 'audit_logs', 'ads', 'subscriptions', 'releases', 'users',
  ]) {
    await query(`TRUNCATE TABLE ${table}`).catch(() => { /* table may not exist yet */ });
  }
  await query('SET FOREIGN_KEY_CHECKS = 1');
}

/**
 * fetch wrapper that keeps cookies between calls (the refresh flow needs them)
 * and parses the JSON envelope.
 */
function client() {
  const jar = new Map();

  function cookieHeader() {
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  function absorb(res) {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  async function request(method, path, { body, token, headers = {} } = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(jar.size ? { cookie: cookieHeader() } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    absorb(res);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON (a redirect) */ }
    return { status: res.status, body: json, text, headers: res.headers };
  }

  return {
    get: (p, o) => request('GET', p, o),
    post: (p, body, o) => request('POST', p, { ...o, body }),
    put: (p, body, o) => request('PUT', p, { ...o, body }),
    del: (p, o) => request('DELETE', p, o),
    cookies: jar,
    clearCookies: () => jar.clear(),
  };
}

/** Register a user and return { email, password, token, id }. */
/**
 * A registered, VERIFIED, signed-in user — the ordinary state of an account
 * that has been through sign-up.
 *
 * The verification step is not decoration: an unverified account is refused its
 * licence key (routes/user.js) and, once EMAIL_VERIFICATION_REQUIRED is on,
 * every authenticated request. Suites that want the unverified case build it
 * explicitly — see accountSecurity.integration.test.js.
 */
async function makeUser(api, suffix = Date.now()) {
  const email = `user${suffix}${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = 'a-strong-password';
  await api.post('/api/auth/register', { name: 'Test User', email, password });
  await query('UPDATE users SET email_verified = 1 WHERE email = ?', [email]);
  const login = await api.post('/api/auth/login', { email, password });
  return { email, password, token: login.body?.data?.token, login };
}

module.exports = { app, start, stop, reset, client, available, makeUser, query, baseUrl: () => baseUrl };
