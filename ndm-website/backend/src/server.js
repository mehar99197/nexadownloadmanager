'use strict';

const config = require('./config/env');
const { connectDB } = require('./config/db');
const { initSchema } = require('./config/schema');
const { ensureUploadDir } = require('./utils/releaseFiles');
const app = require('./app');

process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[fatal] unhandledRejection:', reason);
  process.exit(1);
});

connectDB().then(async () => {
  await initSchema();
  // Uploaded installers land here. Created up-front so the first upload of a
  // fresh deployment does not fail on a missing directory.
  await ensureUploadDir();
  // Outside production the config falls back to well-known dev secrets
  // (dev_admin_secret et al., which are committed to this repo) and Stripe runs
  // in mock mode, where webhook signatures are NOT verified. Binding that to
  // 0.0.0.0 would expose forgeable admin JWTs and unsigned subscription webhooks
  // to the whole network, so a non-production process listens on loopback only.
  // Set BIND_HOST explicitly to override (e.g. BIND_HOST=0.0.0.0 to test from a
  // phone on the LAN); production is unchanged and still binds every interface.
  const insecureDefaults = !config.isProd;
  const bindHost = process.env.BIND_HOST || (insecureDefaults ? '127.0.0.1' : '0.0.0.0');
  app.listen(config.PORT, bindHost, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] NDM backend listening on ${bindHost}:${config.PORT} (${config.NODE_ENV})`);
    if (config.isStripeMock) console.log('[server] Stripe: MOCK mode (no STRIPE_SECRET_KEY) — webhook signatures NOT verified');
    if (config.isEmailMock) console.log('[server] Email: MOCK mode (no SMTP_HOST)');
    if (insecureDefaults && bindHost !== '127.0.0.1')
      console.warn(`[server] WARNING: dev secrets + mock Stripe are exposed on ${bindHost}. Set NODE_ENV=production for a real deployment.`);
  });
});
