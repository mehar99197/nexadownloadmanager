'use strict';

/**
 * Mint or repair the creator ("root") account.
 *
 *   npm run create-root -- "Owner Name" owner@example.com 'a-long-password'
 *
 * This is deliberately the ONLY way a root account comes into existence — no
 * HTTP route can create or promote one. requireRoot additionally demands that
 * the account's email equals ROOT_ADMIN_EMAIL, so this script refuses to leave
 * you with a root row the running server would reject.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { connectDB } = require('../config/db');
const { initSchema } = require('../config/schema');
const config = require('../config/env');
const User = require('../models/User');
const UserSession = require('../models/UserSession');

function randomPassword() {
  return crypto.randomBytes(18).toString('base64url');
}

async function main() {
  const [, , argName, argEmail, argPassword] = process.argv;
  const name = argName || process.env.ROOT_NAME || 'Creator';
  const email = (argEmail || config.ROOT_ADMIN_EMAIL || process.env.ROOT_EMAIL || '')
    .toLowerCase().trim();
  const provided = argPassword || process.env.ROOT_PASSWORD;
  const password = provided || randomPassword();

  if (!email) {
    throw new Error(
      'No email given. Pass one as the 2nd argument or set ROOT_ADMIN_EMAIL in .env.'
    );
  }
  if (config.ROOT_ADMIN_EMAIL && email !== config.ROOT_ADMIN_EMAIL) {
    throw new Error(
      `Refusing to create a root account the server would reject.\n` +
      `  ROOT_ADMIN_EMAIL = ${config.ROOT_ADMIN_EMAIL}\n` +
      `  requested email  = ${email}\n` +
      `Set ROOT_ADMIN_EMAIL to this address (or pass the matching one) and retry.`
    );
  }
  if (password.length < 12) throw new Error('Root password must be at least 12 characters.');

  await connectDB();
  await initSchema();

  const passwordHash = await bcrypt.hash(password, 12);

  let user = await User.findByEmail(email);
  if (user) {
    await User.update(user.id, {
      name, role: 'root', emailVerified: true, banned: false, passwordHash,
      refreshTokenHash: null,
    });
    // Any session minted before this account became root is not a root
    // session: every realm's rows go, and every bearer bound to them with it.
    await UserSession.removeAllForUser(user.id);
    user = await User.findById(user.id);
  } else {
    user = await User.create({ name, email, passwordHash, role: 'root', emailVerified: true });
  }

  const others = (await User.listStaff()).filter((u) => u.role === 'root' && u.id !== user.id);

  /* eslint-disable no-console */
  console.log('───────────────────────────────────────────');
  console.log(' Root / creator account ready');
  console.log(`   id:       ${user.id}`);
  console.log(`   name:     ${name}`);
  console.log(`   email:    ${email}`);
  console.log(`   password: ${password}${provided ? '' : '   (randomly generated — save it!)'}`);
  console.log(`   sign in:  ${config.FRONTEND_URL.replace(/\/+$/, '')}/root/login`);
  console.log('───────────────────────────────────────────');
  if (!config.ROOT_ADMIN_EMAIL) {
    console.warn(' WARNING: ROOT_ADMIN_EMAIL is not set. Add this to .env so the');
    console.warn(' database role alone cannot mint a creator:');
    console.warn(`   ROOT_ADMIN_EMAIL=${email}`);
  }
  if (others.length) {
    console.warn(` WARNING: ${others.length} other root account(s) exist: ` +
      `${others.map((u) => u.email).join(', ')}`);
    console.warn(' Only the one matching ROOT_ADMIN_EMAIL can actually sign in.');
  }
  /* eslint-enable no-console */

  process.exit(0);
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error('[createRoot] failed:', err.message);
  process.exit(1);
});
