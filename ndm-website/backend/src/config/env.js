'use strict';

const deployment = require('./deployment');

const { NODE_ENV, FRONTEND_URL, isProd, isLocalDeployment, isHardened } = deployment;

function csv(value, fallback = []) {
  if (!value) return fallback;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function intOrDefault(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// '' → '' (off) · '2' → 2 (hop count) · 'true'/'false' → boolean ·
// anything else (an address, a subnet, 'loopback', a comma list) → unchanged.
function trustProxy(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

// ---------------------------------------------------------------------------
// Fail-closed configuration.
//
// Every violation is collected and reported together, so whoever is doing a
// cutover fixes the whole list in one edit of .env instead of discovering them
// one boot at a time. `isHardened` is true for NODE_ENV=production AND for any
// deployment whose FRONTEND_URL is a public address — see config/deployment.js
// for why the second condition exists.
// ---------------------------------------------------------------------------

const problems = [];
const WHEN = 'required when NODE_ENV=production or the deployment is public (FRONTEND_URL is not a localhost/private address)';

function required(name, fallback) {
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  if (isHardened) {
    problems.push(`${name} is ${WHEN}`);
    return '';
  }
  return fallback;
}

// Outside a hardened deployment the well-known dev value is used when the
// variable is unset. Those defaults are committed to this repository, which is
// exactly why a hardened deployment refuses them.
function requiredSecret(name, devFallback) {
  const value = process.env[name];
  if (!isHardened) return value || devFallback;
  if (!value) {
    problems.push(`${name} is ${WHEN}`);
    return '';
  }
  if (value.length < 32 || /^change_me|^dev_/i.test(value))
    problems.push(`${name} must be a high-entropy secret of at least 32 characters, not a dev/change_me default`);
  return value;
}

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

// 'live'     — real Stripe, signatures verified.
// 'mock'     — local development only: constructEvent is JSON.parse and the
//              dev-only /mock-complete route exists. Never on a public box.
// 'disabled' — a hardened deployment with no Stripe key: checkout, the portal
//              and the webhook all answer 503 until live keys are configured.
//              This is what a production site without payments looks like;
//              "mock" was never an acceptable substitute for it.
const stripeMode = STRIPE_SECRET_KEY ? 'live' : (isHardened ? 'disabled' : 'mock');

const config = {
  NODE_ENV,
  isProd,
  // Where this server runs — see config/deployment.js.
  isLocalDeployment,
  isHardened,
  PORT: parseInt(process.env.PORT, 10) || 3001,

  MYSQL_HOST: process.env.MYSQL_HOST || '127.0.0.1',
  MYSQL_PORT: parseInt(process.env.MYSQL_PORT, 10) || 3306,
  MYSQL_USER: process.env.MYSQL_USER || 'ndm',
  MYSQL_PASS: required('MYSQL_PASS', 'ndm_secret'),
  MYSQL_DB: process.env.MYSQL_DB || 'ndm_dev',

  JWT_SECRET: requiredSecret('JWT_SECRET', 'dev_user_access_secret'),
  JWT_ADMIN_SECRET: requiredSecret('JWT_ADMIN_SECRET', 'dev_admin_secret'),
  LICENSE_JWT_SECRET: requiredSecret('LICENSE_JWT_SECRET', 'dev_license_secret'),
  // Root/creator tokens are a separate family from staff-admin tokens. A stolen
  // or forged admin token can never satisfy requireRoot, and vice versa.
  JWT_ROOT_SECRET: requiredSecret('JWT_ROOT_SECRET', 'dev_root_secret'),

  // Suspend a licence automatically when the sharing evidence is beyond
  // argument (utils/licenseAbuse.js#autoSuspendReason). A kill switch, not a
  // tuning knob: if it ever misfires on real customers, set this to false and
  // the flagging stays on while the suspending stops.
  LICENSE_AUTO_SUSPEND: bool(process.env.LICENSE_AUTO_SUSPEND, true),

  // Powers the desktop app's AI helpers, which are proxied through this server
  // so the `aiRename` entitlement is enforced somewhere the client cannot
  // patch. Unset simply disables the feature — the app falls back to leaving
  // filenames alone, exactly as it did before the proxy existed.
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  AI_MODEL: process.env.AI_MODEL || 'claude-haiku-4-5',

  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  stripeMode,

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
  // What to do when Cloudflare itself cannot be reached. Default open: an
  // outage at their end must not take sign-up, the contact form and reviews
  // down with it, and an attacker cannot cause that outage on demand. Set true
  // if a bot wave ever arrives while Cloudflare is unreachable — the site then
  // refuses those four endpoints instead of waving them through.
  TURNSTILE_FAIL_CLOSED: bool(process.env.TURNSTILE_FAIL_CLOSED, false),

  // Home-page statistics floor: a figure below this is omitted from
  // GET /api/stats (the tile is hidden) rather than shown while it still reads
  // as "nobody uses this". Never rounds up — see utils/stats.js.
  // An explicit 0 disables a floor; only an absent/invalid value gets the
  // default (`|| 50` would silently turn 0 back into 50).
  STATS_MIN_USERS: intOrDefault(process.env.STATS_MIN_USERS, 50),
  STATS_MIN_DOWNLOADS: intOrDefault(process.env.STATS_MIN_DOWNLOADS, 100),

  // HMAC key for the short-lived tokens that make an ad impression or click
  // countable (utils/ads.js). Falls back to LICENSE_JWT_SECRET so an existing
  // deployment needs no new config; set it separately to rotate independently.
  AD_EVENT_SECRET: process.env.AD_EVENT_SECRET || '',

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
  // Express accepts a hop COUNT (number), a boolean, or a list of proxy
  // addresses/subnets (string). Everything from a .env file arrives as a
  // string, and a bare "1" — the most natural thing to write — is then parsed
  // as an ADDRESS (0.0.0.1) rather than a hop count. It does not fail loudly:
  // it silently trusts nothing, so req.ip stays the reverse proxy's address and
  // both the admin IP allowlist and per-IP rate limiting key off the wrong
  // client. Coercing a numeric value to a real number makes it mean what
  // everybody intends: trust that many hops.
  TRUST_PROXY: trustProxy(process.env.TRUST_PROXY),
  CORS_ORIGINS: csv(process.env.CORS_ORIGINS, [
    'http://localhost:5173',
    'http://localhost:5174',
  ]),
  FRONTEND_URL,
  // Public origin where this API is reachable under /api (used to build the
  // absolute counting-download URL in the desktop update feed). Defaults to
  // the site origin, which fronts /api in every deployment so far.
  PUBLIC_API_URL: (process.env.PUBLIC_API_URL || FRONTEND_URL).replace(/\/+$/, ''),

  EMAIL_VERIFICATION_REQUIRED: bool(process.env.EMAIL_VERIFICATION_REQUIRED, isHardened),

  // Where uploaded installers are stored. Keep this OFF the web root and on a
  // volume with room for several builds — every artifact is a full installer.
  RELEASE_UPLOAD_DIR: process.env.RELEASE_UPLOAD_DIR
    || require('path').join(__dirname, '..', '..', 'uploads', 'releases'),
  // Hard ceiling per uploaded artifact (MB). Streaming aborts past this.
  MAX_RELEASE_UPLOAD_MB: parseInt(process.env.MAX_RELEASE_UPLOAD_MB, 10) || 1024,
};

config.isStripeMock = stripeMode === 'mock';
config.isBillingDisabled = stripeMode === 'disabled';
config.isEmailMock = !config.SMTP_HOST;
// "Continue with Google" is only offered when a client ID is configured on both
// halves; without it the backend has no audience to verify an ID token against.
config.isGoogleAuthEnabled = Boolean(config.GOOGLE_CLIENT_ID);
// Effective reply address for outbound support mail.
config.supportReplyTo = config.SUPPORT_REPLY_TO || config.SUPPORT_EMAIL || config.FROM_EMAIL;
// Effective key for ad event tokens.
config.adEventSecret = config.AD_EVENT_SECRET || config.LICENSE_JWT_SECRET;

// Session cookies carry the Secure flag whenever the site itself is served
// over HTTPS — not only when NODE_ENV happens to say production. The Node
// process sees plain HTTP from the reverse proxy, so this cannot be derived
// from the connection; the site origin is the honest signal.
config.secureCookies = isProd || FRONTEND_URL.startsWith('https://');
// Stack traces in 500 responses, and the RATE_LIMIT_DISABLED escape hatch, are
// development conveniences. A public box gets neither.
config.exposeStackTraces = !isHardened;
config.allowRateLimitBypass = !isHardened;

if (isHardened) {
  const jwtSecrets = [
    config.JWT_SECRET, config.JWT_ADMIN_SECRET, config.LICENSE_JWT_SECRET, config.JWT_ROOT_SECRET,
  ];
  if (jwtSecrets.every(Boolean) && new Set(jwtSecrets).size !== jwtSecrets.length)
    problems.push('JWT_SECRET, JWT_ADMIN_SECRET, LICENSE_JWT_SECRET and JWT_ROOT_SECRET must all be different');
  if (!config.ROOT_ADMIN_EMAIL)
    problems.push(`ROOT_ADMIN_EMAIL must name the creator account (${WHEN})`);
  if (stripeMode === 'live') {
    if (!STRIPE_SECRET_KEY.startsWith('sk_'))
      problems.push('STRIPE_SECRET_KEY must be a Stripe secret key (sk_…)');
    if (!STRIPE_WEBHOOK_SECRET.startsWith('whsec_'))
      problems.push('STRIPE_WEBHOOK_SECRET (whsec_…) is required whenever STRIPE_SECRET_KEY is set — without it no webhook can be verified');
  }
  if (config.isEmailMock)
    problems.push(`SMTP_HOST is ${WHEN}; email mock mode only logs mail (verification links, reset tokens, licence keys) to a file`);
  if (!config.CORS_ORIGINS.length || config.CORS_ORIGINS.some((origin) => !origin.startsWith('https://')))
    problems.push('CORS_ORIGINS must contain HTTPS origins only');
  if (!FRONTEND_URL.startsWith('https://'))
    problems.push('FRONTEND_URL must use HTTPS');
  if (!config.PUBLIC_API_URL.startsWith('https://'))
    problems.push('PUBLIC_API_URL must use HTTPS');
  if (!config.ADMIN_ALLOWED_IPS.length)
    problems.push('ADMIN_ALLOWED_IPS must explicitly restrict admin access (empty = the control panels are reachable from any address)');
  if (!config.TRUST_PROXY)
    problems.push('TRUST_PROXY must describe the reverse proxy (TRUST_PROXY=1 behind one proxy); without it every client is 127.0.0.1 to the rate limiters and the admin IP allowlist');
  if (config.SMTP_USER && !config.SMTP_PASS)
    problems.push('SMTP_PASS is required when SMTP_USER is configured');
  if (config.MYSQL_PASS && (config.MYSQL_PASS.length < 16 || /^(change_me|ndm_secret)$/i.test(config.MYSQL_PASS)))
    problems.push('MYSQL_PASS must be a non-default password of at least 16 characters');
}

if (problems.length) {
  const why = isProd
    ? 'NODE_ENV=production'
    : `FRONTEND_URL=${FRONTEND_URL} is a public address, so the production checks apply even though NODE_ENV=${NODE_ENV}`;
  throw new Error(
    `[config] Refusing to start: this configuration is not safe for a public deployment (${why}).\n`
    + problems.map((p) => `  - ${p}`).join('\n')
    + '\n[config] Fix every line above in the server .env (see ndm-website/deploy/README.md, "Going to production") and restart.'
  );
}

module.exports = config;
