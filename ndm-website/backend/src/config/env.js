'use strict';

require('dotenv').config();

function csv(value, fallback = []) {
  if (!value) return fallback;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

const NODE_ENV = process.env.NODE_ENV || 'development';

function required(name, { fallback = undefined, productionRequired = false } = {}) {
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  if (!productionRequired && fallback !== undefined) return fallback;
  throw new Error(`[config] ${name} is required when NODE_ENV=production`);
}

function requiredSecret(name) {
  const value = required(name, { productionRequired: true });
  if (value.length < 32 || /^change_me|^dev_/i.test(value))
    throw new Error(`[config] ${name} must be a high-entropy secret of at least 32 characters`);
  return value;
}

const config = {
  NODE_ENV,
  isProd: NODE_ENV === 'production',
  PORT: parseInt(process.env.PORT, 10) || 3001,

  MYSQL_HOST: process.env.MYSQL_HOST || '127.0.0.1',
  MYSQL_PORT: parseInt(process.env.MYSQL_PORT, 10) || 3306,
  MYSQL_USER: process.env.MYSQL_USER || 'ndm',
  MYSQL_PASS: NODE_ENV === 'production' ? required('MYSQL_PASS', { productionRequired: true })
    : process.env.MYSQL_PASS || 'ndm_secret',
  MYSQL_DB: process.env.MYSQL_DB || 'ndm_dev',

  JWT_SECRET: NODE_ENV === 'production' ? requiredSecret('JWT_SECRET')
    : process.env.JWT_SECRET || 'dev_user_access_secret',
  JWT_ADMIN_SECRET: NODE_ENV === 'production' ? requiredSecret('JWT_ADMIN_SECRET')
    : process.env.JWT_ADMIN_SECRET || 'dev_admin_secret',
  LICENSE_JWT_SECRET: NODE_ENV === 'production' ? requiredSecret('LICENSE_JWT_SECRET')
    : process.env.LICENSE_JWT_SECRET || 'dev_license_secret',

  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',

  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: parseInt(process.env.SMTP_PORT, 10) || 587,
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  FROM_EMAIL: process.env.FROM_EMAIL || 'noreply@nexadownloadmanager.com',

  ADMIN_ALLOWED_IPS: csv(process.env.ADMIN_ALLOWED_IPS, []),
  TRUST_PROXY: process.env.TRUST_PROXY || '',
  CORS_ORIGINS: csv(process.env.CORS_ORIGINS, [
    'http://localhost:5173',
    'http://localhost:5174',
  ]),
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',

  EMAIL_VERIFICATION_REQUIRED: bool(process.env.EMAIL_VERIFICATION_REQUIRED, NODE_ENV === 'production'),
};

config.isStripeMock = !config.STRIPE_SECRET_KEY;
config.isEmailMock = !config.SMTP_HOST;

if (config.isProd) {
  if (config.JWT_SECRET === config.JWT_ADMIN_SECRET || config.JWT_SECRET === config.LICENSE_JWT_SECRET ||
      config.JWT_ADMIN_SECRET === config.LICENSE_JWT_SECRET)
    throw new Error('[config] JWT secrets must all be different in production');
  if (!config.STRIPE_SECRET_KEY.startsWith('sk_') || !config.STRIPE_WEBHOOK_SECRET.startsWith('whsec_'))
    throw new Error('[config] live Stripe secret and webhook signing secret are required in production');
  if (config.isEmailMock)
    throw new Error('[config] SMTP_HOST is required in production; email mock mode is disabled');
  if (!config.CORS_ORIGINS.length || config.CORS_ORIGINS.some((origin) => !origin.startsWith('https://')))
    throw new Error('[config] production CORS_ORIGINS must contain HTTPS origins only');
  if (!config.FRONTEND_URL.startsWith('https://'))
    throw new Error('[config] FRONTEND_URL must use HTTPS in production');
  if (!config.ADMIN_ALLOWED_IPS.length)
    throw new Error('[config] ADMIN_ALLOWED_IPS must explicitly restrict production admin access');
  if (!config.TRUST_PROXY)
    throw new Error('[config] TRUST_PROXY must explicitly describe the production reverse proxy');
  if (config.SMTP_USER && !config.SMTP_PASS)
    throw new Error('[config] SMTP_PASS is required when SMTP_USER is configured');
  if (config.MYSQL_PASS.length < 16 || /^(change_me|ndm_secret)$/i.test(config.MYSQL_PASS))
    throw new Error('[config] MYSQL_PASS must be a non-default production password of at least 16 characters');
}

module.exports = config;
