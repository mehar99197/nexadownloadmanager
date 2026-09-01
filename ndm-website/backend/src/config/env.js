'use strict';

require('dotenv').config();

function csv(value, fallback = []) {
  if (!value) return fallback;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function intOrDefault(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

const NODE_ENV = process.env.NODE_ENV || 'development';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

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
  // Root/creator tokens are a separate family from staff-admin tokens. A stolen
  // or forged admin token can never satisfy requireRoot, and vice versa.
  JWT_ROOT_SECRET: NODE_ENV === 'production' ? requiredSecret('JWT_ROOT_SECRET')
    : process.env.JWT_ROOT_SECRET || 'dev_root_secret',

  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',

  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: parseInt(process.env.SMTP_PORT, 10) || 587,
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  FROM_EMAIL: process.env.FROM_EMAIL || 'noreply@nexadownloadmanager.com',
  // Where the website's contact form delivers. Defaults to FROM_EMAIL.
  SUPPORT_EMAIL: process.env.SUPPORT_EMAIL || '',
  // Reply-To stamped on support replies so a customer's answer lands in the
  // support inbox rather than an unattended noreply@ mailbox. Defaults to
  // SUPPORT_EMAIL, then FROM_EMAIL.
  SUPPORT_REPLY_TO: process.env.SUPPORT_REPLY_TO || '',

  // Google Sign-In ("Continue with Google"). The client ID is the audience every
  // ID token must carry; blank = the button is off, and POST /api/auth/google
  // refuses rather than trusting an unverifiable token. The site's
  // VITE_GOOGLE_CLIENT_ID must be set in step with this.
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',

  // Cloudflare Turnstile secret for the anonymous write endpoints (register,
  // password reset, contact, reviews). Blank = the gate is off; the site's
  // VITE_TURNSTILE_SITE_KEY must be set in step with this.
  TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY || '',

  // Home-page statistics floor: a figure below this is omitted from
  // GET /api/stats (the tile is hidden) rather than shown while it still reads
  // as "nobody uses this". Never rounds up — see utils/stats.js.
  // An explicit 0 disables a floor; only an absent/invalid value gets the
  // default (`|| 50` would silently turn 0 back into 50).
  STATS_MIN_USERS: intOrDefault(process.env.STATS_MIN_USERS, 50),
  STATS_MIN_DOWNLOADS: intOrDefault(process.env.STATS_MIN_DOWNLOADS, 100),

  // Key for the admin/root TOTP secrets at rest (AES-256-GCM). Falls back to
  // JWT_ADMIN_SECRET so an existing deployment gains 2FA without new config;
  // set it separately if you ever want to rotate JWT secrets independently.
  TOTP_ENCRYPTION_KEY: process.env.TOTP_ENCRYPTION_KEY || '',

  ADMIN_ALLOWED_IPS: csv(process.env.ADMIN_ALLOWED_IPS, []),
  // Extra IP gate for /api/root/*. Empty = reuse ADMIN_ALLOWED_IPS, so the root
  // panel is never *less* restricted than the staff panel.
  ROOT_ALLOWED_IPS: csv(process.env.ROOT_ALLOWED_IPS, []),
  // The creator's email. requireRoot demands BOTH role='root' in the database
  // AND a match against this value, so a stray UPDATE on the users table is not
  // by itself enough to mint a root admin.
  ROOT_ADMIN_EMAIL: String(process.env.ROOT_ADMIN_EMAIL || '').toLowerCase().trim(),
  TRUST_PROXY: process.env.TRUST_PROXY || '',
  CORS_ORIGINS: csv(process.env.CORS_ORIGINS, [
    'http://localhost:5173',
    'http://localhost:5174',
  ]),
  FRONTEND_URL,
  // Public origin where this API is reachable under /api (used to build the
  // absolute counting-download URL in the desktop update feed). Defaults to
  // the site origin, which fronts /api in every deployment so far.
  PUBLIC_API_URL: (process.env.PUBLIC_API_URL || FRONTEND_URL).replace(/\/+$/, ''),

  EMAIL_VERIFICATION_REQUIRED: bool(process.env.EMAIL_VERIFICATION_REQUIRED, NODE_ENV === 'production'),

  // Where uploaded installers are stored. Keep this OFF the web root and on a
  // volume with room for several builds — every artifact is a full installer.
  RELEASE_UPLOAD_DIR: process.env.RELEASE_UPLOAD_DIR
    || require('path').join(__dirname, '..', '..', 'uploads', 'releases'),
  // Hard ceiling per uploaded artifact (MB). Streaming aborts past this.
  MAX_RELEASE_UPLOAD_MB: parseInt(process.env.MAX_RELEASE_UPLOAD_MB, 10) || 1024,
};

config.isStripeMock = !config.STRIPE_SECRET_KEY;
config.isEmailMock = !config.SMTP_HOST;
// "Continue with Google" is only offered when a client ID is configured on both
// halves; without it the backend has no audience to verify an ID token against.
config.isGoogleAuthEnabled = Boolean(config.GOOGLE_CLIENT_ID);
// Effective reply address for outbound support mail.
config.supportReplyTo = config.SUPPORT_REPLY_TO || config.SUPPORT_EMAIL || config.FROM_EMAIL;

if (config.isProd) {
  const jwtSecrets = [
    config.JWT_SECRET, config.JWT_ADMIN_SECRET, config.LICENSE_JWT_SECRET, config.JWT_ROOT_SECRET,
  ];
  if (new Set(jwtSecrets).size !== jwtSecrets.length)
    throw new Error('[config] JWT secrets must all be different in production');
  if (!config.ROOT_ADMIN_EMAIL)
    throw new Error('[config] ROOT_ADMIN_EMAIL must name the creator account in production');
  if (!config.STRIPE_SECRET_KEY.startsWith('sk_') || !config.STRIPE_WEBHOOK_SECRET.startsWith('whsec_'))
    throw new Error('[config] live Stripe secret and webhook signing secret are required in production');
  if (config.isEmailMock)
    throw new Error('[config] SMTP_HOST is required in production; email mock mode is disabled');
  if (!config.CORS_ORIGINS.length || config.CORS_ORIGINS.some((origin) => !origin.startsWith('https://')))
    throw new Error('[config] production CORS_ORIGINS must contain HTTPS origins only');
  if (!config.FRONTEND_URL.startsWith('https://'))
    throw new Error('[config] FRONTEND_URL must use HTTPS in production');
  if (!config.PUBLIC_API_URL.startsWith('https://'))
    throw new Error('[config] PUBLIC_API_URL must use HTTPS in production');
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
