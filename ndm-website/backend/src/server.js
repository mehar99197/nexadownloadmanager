'use strict';

const config = require('./config/env');
const licenseKeys = require('./config/licenseKeys');
const { connectDB } = require('./config/db');
const { initSchema } = require('./config/schema');
const { ensureUploadDir } = require('./utils/releaseFiles');
const housekeeping = require('./utils/housekeeping');
const app = require('./app');

process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[fatal] unhandledRejection:', reason);
  process.exit(1);
});

/* eslint-disable no-console */
function describeStripe() {
  switch (config.stripeMode) {
    case 'live': return '[server] Stripe: LIVE (webhook signatures verified)';
    case 'mock': return '[server] Stripe: MOCK mode (local development only — webhook signatures NOT verified)';
    default: return '[server] Stripe: DISABLED (no STRIPE_SECRET_KEY) — checkout, the billing portal and the webhook answer 503 until live keys are configured';
  }
}

connectDB().then(async () => {
  await initSchema();
  // Uploaded installers land here. Created up-front so the first upload of a
  // fresh deployment does not fail on a missing directory.
  await ensureUploadDir();
  // Dead sessions, old security events, spent ID-token ids, expired counters.
  housekeeping.schedule();

  // Loopback by default, in every mode. Every deployment so far puts a reverse
  // proxy (nginx, or Hostinger's PHP shim) in front of this process, and that
  // proxy is what terminates TLS, adds X-Forwarded-For and applies the edge
  // rules; a process reachable on 0.0.0.0 would sidestep all three. A
  // containerised deployment sets BIND_HOST=0.0.0.0 explicitly (the Dockerfile
  // does), as does anyone testing from a phone on the LAN.
  const bindHost = process.env.BIND_HOST || '127.0.0.1';
  app.listen(config.PORT, bindHost, () => {
    console.log(
      `[server] NDM backend listening on ${bindHost}:${config.PORT} `
      + `(NODE_ENV=${config.NODE_ENV}, ${config.isLocalDeployment ? 'local' : 'public'} deployment, `
      + `production checks ${config.isHardened ? 'ON' : 'off'})`
    );
    console.log(describeStripe());
    if (config.isEmailMock) console.log('[server] Email: MOCK mode (no SMTP_HOST) — mail is logged, not sent');

    if (!config.isProd && !config.isLocalDeployment) {
      // The checks were enforced regardless (config/env.js), so this is a nag,
      // not a hole — but the word in .env should say what the box is.
      console.warn(
        `[server] WARNING: NODE_ENV=${config.NODE_ENV} on a public deployment (FRONTEND_URL=${config.FRONTEND_URL}). `
        + 'The production checks were applied anyway; set NODE_ENV=production so this is explicit.'
      );
    }
    if (!config.isHardened && bindHost !== '127.0.0.1')
      console.warn(`[server] WARNING: dev secrets + mock Stripe are exposed on ${bindHost}. Keep this off any shared network.`);
    if (!config.isHardened && licenseKeys.holdsShippedKey()) {
      // A laptop does not need the key that signs every customer's licence and
      // the update feed every install executes. Development builds of the app
      // trust the fixed dev seed instead — see config/licenseKeys.js.
      console.warn(
        '[server] WARNING: LICENSE_JWT_PRIVATE_KEY in this local .env is the PRODUCTION signing key '
        + '(its public half is packaging/license-public-key.txt). Remove it from this machine; '
        + 'local development uses the built-in dev key automatically.'
      );
    }
  });
});
/* eslint-enable no-console */
