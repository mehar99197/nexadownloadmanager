#!/usr/bin/env node
'use strict';

/**
 * Generate the Ed25519 keypair that signs licence tokens.
 *
 *   npm run license:keygen
 *
 * Prints two things:
 *   1. LICENSE_JWT_PRIVATE_KEY — goes in the SERVER environment, nowhere else.
 *   2. The 32-byte public key as hex — compiled into the desktop app
 *      (src/license/LicenseKey.h). Safe to publish; it can only verify.
 *
 * Rotating the pair invalidates every licence token still in circulation.
 * Tokens live 24h, so a rotation is felt for at most a day — but a client
 * built against the OLD public key will reject the NEW tokens permanently.
 * Ship the app update first, then rotate.
 */

const crypto = require('crypto');
const { rawPublicKeyHex } = require('../config/licenseKeys');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString().trim();
const hex = rawPublicKeyHex(publicKey);

process.stdout.write(`
Ed25519 licence signing keypair
===============================

1. SERVER — put this in the backend environment (.env / host panel).
   Keep it secret. Anyone holding it can mint Pro licences.

LICENSE_JWT_PRIVATE_KEY="${pem.replace(/\n/g, '\\n')}"

   (The literal \\n escapes are read back correctly by config/licenseKeys.js,
   so this pastes into a single-line .env value as-is.)

2. DESKTOP APP — compile this into src/license/LicenseKey.h as
   kLicensePublicKeyHex. It is public; shipping it is the whole point.

${hex}

3. Order of operations when rotating:
   ship the desktop update carrying the new public key FIRST, then swap the
   server key. Doing it the other way round locks out every existing install.

`);
