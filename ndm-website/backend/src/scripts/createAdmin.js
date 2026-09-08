'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { connectDB } = require('../config/db');
const { initSchema } = require('../config/schema');
const User = require('../models/User');

function randomPassword() {
  return crypto.randomBytes(12).toString('base64url');
}

async function main() {
  const [, , argName, argEmail, argPassword] = process.argv;
  const name = argName || process.env.ADMIN_NAME || 'Admin';
  const email = (argEmail || process.env.ADMIN_EMAIL || 'admin@nexadownloadmanager.com')
    .toLowerCase().trim();
  const provided = argPassword || process.env.ADMIN_PASSWORD;
  const password = provided || randomPassword();

  await connectDB();
  await initSchema();

  const passwordHash = await bcrypt.hash(password, 12);

  let user = await User.findByEmail(email);
  if (user) {
    await User.update(user.id, {
      name, role: 'admin', emailVerified: true, banned: false, passwordHash,
    });
    // The row may have been an ordinary customer until this line. Its customer
    // access tokens are stateless and live another seven days, and the public
    // API no longer serves a staff identity, so end every session rather than
    // leaving one that will only be refused later. Same reasoning as
    // createRoot.js.
    await User.revokeSessions(user.id);
    user = await User.findById(user.id);
  } else {
    user = await User.create({
      name, email, passwordHash, role: 'admin', emailVerified: true,
    });
  }

  // eslint-disable-next-line no-console
  console.log('───────────────────────────────────────────');
  // eslint-disable-next-line no-console
  console.log(' Admin account ready');
  // eslint-disable-next-line no-console
  console.log(`   id:       ${user.id}`);
  // eslint-disable-next-line no-console
  console.log(`   name:     ${name}`);
  // eslint-disable-next-line no-console
  console.log(`   email:    ${email}`);
  // eslint-disable-next-line no-console
  console.log(`   password: ${password}${provided ? '' : '   (randomly generated — save it!)'}`);
  // eslint-disable-next-line no-console
  console.log('───────────────────────────────────────────');

  process.exit(0);
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error('[createAdmin] failed:', err.message);
  process.exit(1);
});
