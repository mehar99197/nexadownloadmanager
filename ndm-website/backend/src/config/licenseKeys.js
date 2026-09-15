'use strict';

// The Ed25519 keypair that signs licence tokens.
//
// Why asymmetric, when every other token family here uses an HMAC secret: the
// desktop app has to verify a licence token *itself*, offline, on a machine the
// user controls. With HS256 that would mean shipping the signing secret inside
// the binary, and anyone who pulled it out could mint themselves a Pro licence.
// With Ed25519 the binary carries only the public key — useless for forging.
//
// The private key never leaves the server. `npm run license:keygen` generates a
// pair and prints both halves in the form each side needs.

// Loaded directly rather than via config/env.js: this module is pulled in by
// utils/jwt.js, which some scripts reach before env.js. config/deployment.js
// runs dotenv, so the private key in .env is visible here; without that the
// fixed development key would be used instead — silently, and in a way that
// only shows up as clients rejecting every token.
const deployment = require('./deployment');

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// DER wrappers for a bare Ed25519 key. RFC 8410 fixes both prefixes, so a raw
// 32-byte key can be turned into something crypto.createPrivateKey accepts
// without pulling in an ASN.1 library.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX_LEN = 12;

function privateKeyFromSeed(seed) {
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

/**
 * The 32-byte public key, hex encoded — the exact form the desktop client
 * embeds. Printed by the keygen script and compared against by the client test.
 */
function rawPublicKeyHex(publicKey) {
  return publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(SPKI_ED25519_PREFIX_LEN)
    .toString('hex');
}

function loadPrivateKey() {
  const pem = process.env.LICENSE_JWT_PRIVATE_KEY;

  if (pem) {
    let key;
    try {
      // Accept a PEM with literal \n escapes, which is how most hosts (and
      // Hostinger's panel in particular) store a multi-line value.
      key = crypto.createPrivateKey(pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem);
    } catch (err) {
      throw new Error(`[config] LICENSE_JWT_PRIVATE_KEY is not a readable private key: ${err.message}`);
    }
    if (key.asymmetricKeyType !== 'ed25519')
      throw new Error(`[config] LICENSE_JWT_PRIVATE_KEY must be an Ed25519 key, got ${key.asymmetricKeyType}`);
    return key;
  }

  // Production, or any public deployment (see config/deployment.js): the fixed
  // development seed below is committed to this repository, so a public box
  // signing with it would let anybody mint licences and update feeds.
  if (deployment.isHardened) {
    throw new Error(
      '[config] LICENSE_JWT_PRIVATE_KEY is required when NODE_ENV=production or the deployment is public. '
      + 'Generate one with `npm run license:keygen`, keep the private half in the '
      + 'server environment, and compile the public half into the desktop app.'
    );
  }

  // Development and test: a fixed seed, so tokens stay verifiable across a
  // restart and the client test can hard-code the matching public key. This
  // seed is public by definition — it must never be used in production, which
  // the branch above enforces.
  return privateKeyFromSeed(Buffer.alloc(32, 0x4e /* 'N' */));
}

const privateKey = loadPrivateKey();
const publicKey = crypto.createPublicKey(privateKey);
const publicKeyHex = rawPublicKeyHex(publicKey);

// The public half of the key release builds of the desktop app trust, as
// committed in this monorepo. Null outside the monorepo layout.
const SHIPPED_PUBLIC_KEY_FILE = path.join(__dirname, '..', '..', '..', '..', 'packaging', 'license-public-key.txt');

/**
 * Is the key this process signs with the one compiled into shipped builds?
 *
 * On the production server the answer must be yes. On a developer's machine it
 * must be no: that key also signs the update feed every install downloads and
 * runs, and a laptop has no business holding it. server.js warns when a local
 * deployment answers yes. Never throws — a missing file just means "unknown".
 */
function holdsShippedKey() {
  try {
    const shipped = fs.readFileSync(SHIPPED_PUBLIC_KEY_FILE, 'utf8').trim().toLowerCase();
    return Boolean(shipped) && shipped === publicKeyHex;
  } catch {
    return false;
  }
}

module.exports = {
  privateKey,
  publicKey,
  publicKeyHex,
  rawPublicKeyHex,
  privateKeyFromSeed,
  holdsShippedKey,
};
