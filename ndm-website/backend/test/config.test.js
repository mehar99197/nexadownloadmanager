'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const backendRoot = path.resolve(__dirname, '..');

function loadProduction(extraEnv = {}) {
  return spawnSync(process.execPath, ['-e', "require('./src/config/env')"], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production', ...extraEnv },
  });
}

test('production refuses missing secrets and mock services', () => {
  const result = loadProduction({
    MYSQL_PASS: '', JWT_SECRET: '', JWT_ADMIN_SECRET: '', LICENSE_JWT_SECRET: '',
    STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', SMTP_HOST: '',
    CORS_ORIGINS: '', FRONTEND_URL: '', ADMIN_ALLOWED_IPS: '',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required when NODE_ENV=production/);
});

test('production accepts an explicit secure configuration', () => {
  const result = loadProduction({
    MYSQL_PASS: 'database-password',
    JWT_SECRET: 'user-secret-012345678901234567890123456789',
    JWT_ADMIN_SECRET: 'admin-secret-0123456789012345678901234567',
    LICENSE_JWT_SECRET: 'license-secret-01234567890123456789012345',
    JWT_ROOT_SECRET: 'root-secret-0123456789012345678901234567',
    ROOT_ADMIN_EMAIL: 'creator@example.test',
    STRIPE_SECRET_KEY: 'sk_live_example',
    STRIPE_WEBHOOK_SECRET: 'whsec_example',
    SMTP_HOST: 'smtp.example.test', SMTP_USER: '', SMTP_PASS: '',
    CORS_ORIGINS: 'https://www.example.test,https://admin.example.test',
    FRONTEND_URL: 'https://www.example.test', ADMIN_ALLOWED_IPS: '203.0.113.10',
    TRUST_PROXY: '127.0.0.1',
  });
  assert.equal(result.status, 0, result.stderr);
});

// The creator tier is only a boundary if production cannot fall back to the
// committed dev defaults for it, so both of its settings are fail-closed.
test('production refuses a missing or shared root JWT secret', () => {
  const base = {
    MYSQL_PASS: 'database-password',
    JWT_SECRET: 'user-secret-012345678901234567890123456789',
    JWT_ADMIN_SECRET: 'admin-secret-0123456789012345678901234567',
    LICENSE_JWT_SECRET: 'license-secret-01234567890123456789012345',
    ROOT_ADMIN_EMAIL: 'creator@example.test',
    STRIPE_SECRET_KEY: 'sk_live_example',
    STRIPE_WEBHOOK_SECRET: 'whsec_example',
    SMTP_HOST: 'smtp.example.test', SMTP_USER: '', SMTP_PASS: '',
    CORS_ORIGINS: 'https://www.example.test,https://admin.example.test',
    FRONTEND_URL: 'https://www.example.test', ADMIN_ALLOWED_IPS: '203.0.113.10',
    TRUST_PROXY: '127.0.0.1',
  };

  assert.notEqual(loadProduction({ ...base, JWT_ROOT_SECRET: '' }).status, 0);
  // Reusing the admin secret would let a staff token satisfy the root gate.
  assert.notEqual(
    loadProduction({ ...base, JWT_ROOT_SECRET: base.JWT_ADMIN_SECRET }).status, 0
  );
});

test('production refuses a missing ROOT_ADMIN_EMAIL', () => {
  const result = loadProduction({
    MYSQL_PASS: 'database-password',
    JWT_SECRET: 'user-secret-012345678901234567890123456789',
    JWT_ADMIN_SECRET: 'admin-secret-0123456789012345678901234567',
    LICENSE_JWT_SECRET: 'license-secret-01234567890123456789012345',
    JWT_ROOT_SECRET: 'root-secret-0123456789012345678901234567',
    ROOT_ADMIN_EMAIL: '',
    STRIPE_SECRET_KEY: 'sk_live_example',
    STRIPE_WEBHOOK_SECRET: 'whsec_example',
    SMTP_HOST: 'smtp.example.test', SMTP_USER: '', SMTP_PASS: '',
    CORS_ORIGINS: 'https://www.example.test,https://admin.example.test',
    FRONTEND_URL: 'https://www.example.test', ADMIN_ALLOWED_IPS: '203.0.113.10',
    TRUST_PROXY: '127.0.0.1',
  });
  assert.notEqual(result.status, 0);
});

/* ------------------------------------------------------------------------ */
/* Public deployments get the production checks whatever NODE_ENV says.     */
/* ------------------------------------------------------------------------ */

function load(env, expr = "require('./src/config/env')") {
  return spawnSync(process.execPath, ['-e', expr], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

// Everything a public box needs, minus Stripe — the state a site is in before
// its live keys exist.
const publicWithoutStripe = {
  NODE_ENV: 'development',
  MYSQL_PASS: 'database-password',
  JWT_SECRET: 'user-secret-012345678901234567890123456789',
  JWT_ADMIN_SECRET: 'admin-secret-0123456789012345678901234567',
  LICENSE_JWT_SECRET: 'license-secret-01234567890123456789012345',
  JWT_ROOT_SECRET: 'root-secret-0123456789012345678901234567',
  ROOT_ADMIN_EMAIL: 'creator@example.test',
  STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '',
  SMTP_HOST: 'smtp.example.test', SMTP_USER: '', SMTP_PASS: '',
  CORS_ORIGINS: 'https://www.example.test',
  FRONTEND_URL: 'https://www.example.test', ADMIN_ALLOWED_IPS: '203.0.113.10',
  TRUST_PROXY: '1',
  // Pinned empty so the developer's own .env (dotenv fills only UNSET vars)
  // cannot leak a value into the spawned process; the default is under test.
  EMAIL_VERIFICATION_REQUIRED: '',
};

test('a public FRONTEND_URL enforces the production checks even in development mode', () => {
  // The live box ran exactly like this: NODE_ENV=development, real domain,
  // dev secrets. It must not boot.
  const result = load({
    NODE_ENV: 'development', FRONTEND_URL: 'https://www.example.test',
    JWT_SECRET: '', JWT_ADMIN_SECRET: '', JWT_ROOT_SECRET: '', LICENSE_JWT_SECRET: '',
    ADMIN_ALLOWED_IPS: '', TRUST_PROXY: '', SMTP_HOST: '', STRIPE_SECRET_KEY: '',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not safe for a public deployment/);
  assert.match(result.stderr, /JWT_ADMIN_SECRET is required/);
  assert.match(result.stderr, /ADMIN_ALLOWED_IPS/);
  assert.match(result.stderr, /TRUST_PROXY/);
  // Every problem is listed at once, not one per boot.
  assert.match(result.stderr, /JWT_ROOT_SECRET is required/);
});

test('a public deployment refuses the committed dev-default secrets', () => {
  const result = load({
    ...publicWithoutStripe,
    JWT_ROOT_SECRET: 'dev_root_secret_local_only_but_long_enough_x',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /JWT_ROOT_SECRET must be a high-entropy secret/);
});

test('a public deployment without Stripe keys boots with billing DISABLED, never mock', () => {
  const result = load(publicWithoutStripe,
    "const c=require('./src/config/env');console.log(JSON.stringify({m:c.stripeMode,mock:c.isStripeMock,off:c.isBillingDisabled,h:c.isHardened,s:c.secureCookies,st:c.exposeStackTraces,rl:c.allowRateLimitBypass,ev:c.EMAIL_VERIFICATION_REQUIRED}))");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    m: 'disabled', mock: false, off: true, h: true, s: true, st: false, rl: false, ev: true,
  });
});

test('production without Stripe keys boots with billing DISABLED', () => {
  const result = loadProduction({ ...publicWithoutStripe, NODE_ENV: 'production' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('a Stripe key without its webhook secret is refused on a public deployment', () => {
  const result = load({ ...publicWithoutStripe, STRIPE_SECRET_KEY: 'sk_live_example', STRIPE_WEBHOOK_SECRET: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /STRIPE_WEBHOOK_SECRET/);
});

test('local development keeps its conveniences: mock Stripe, dev secrets, stack traces', () => {
  const result = load({
    NODE_ENV: 'development', FRONTEND_URL: 'http://localhost:5173',
    JWT_SECRET: '', JWT_ADMIN_SECRET: '', JWT_ROOT_SECRET: '', LICENSE_JWT_SECRET: '',
    STRIPE_SECRET_KEY: '', SMTP_HOST: '', ADMIN_ALLOWED_IPS: '', TRUST_PROXY: '',
  }, "const c=require('./src/config/env');console.log(JSON.stringify({m:c.stripeMode,h:c.isHardened,s:c.secureCookies,st:c.exposeStackTraces,rl:c.allowRateLimitBypass,local:c.isLocalDeployment}))");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()),
    { m: 'mock', h: false, s: false, st: true, rl: true, local: true });
});

test('a LAN address still counts as local, a public hostname does not', () => {
  const { isPrivateHost } = require('../src/config/deployment');
  for (const ok of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173',
    'http://192.168.1.5:5173', 'http://10.0.0.2', 'http://172.16.0.9', 'http://dev.local'])
    assert.equal(isPrivateHost(ok), true, ok);
  for (const pub of ['https://nexadownloadmanager.com', 'https://staging.example.test',
    'http://203.0.113.10', 'not a url', ''])
    assert.equal(isPrivateHost(pub), false, pub);
});
