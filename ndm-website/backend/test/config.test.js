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
    STRIPE_SECRET_KEY: 'sk_live_example',
    STRIPE_WEBHOOK_SECRET: 'whsec_example',
    SMTP_HOST: 'smtp.example.test', SMTP_USER: '', SMTP_PASS: '',
    CORS_ORIGINS: 'https://www.example.test,https://admin.example.test',
    FRONTEND_URL: 'https://www.example.test', ADMIN_ALLOWED_IPS: '203.0.113.10',
    TRUST_PROXY: '127.0.0.1',
  });
  assert.equal(result.status, 0, result.stderr);
});
