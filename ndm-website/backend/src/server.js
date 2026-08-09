'use strict';

const config = require('./config/env');
const { connectDB } = require('./config/db');
const { initSchema } = require('./config/schema');
const app = require('./app');

process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[fatal] unhandledRejection:', reason);
  process.exit(1);
});

connectDB().then(async () => {
  await initSchema();
  app.listen(config.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] NDM backend listening on :${config.PORT} (${config.NODE_ENV})`);
    if (config.isStripeMock) console.log('[server] Stripe: MOCK mode (no STRIPE_SECRET_KEY)');
    if (config.isEmailMock) console.log('[server] Email: MOCK mode (no SMTP_HOST)');
  });
});
