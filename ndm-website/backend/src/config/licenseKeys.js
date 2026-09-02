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
// utils/jwt.js, which some scripts reach before env.js, and without dotenv here
// the private key in .env would be invisible and the fixed development key
// would be used instead — silently, and in a way that only shows up as clients
// rejecting every token.
require('dotenv').config();

const crypto = require('crypto');

const NODE_ENV = process.env.NODE_ENV || 'development';

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

  if (NODE_ENV === 'production') {
    throw new Error(
      '[config] LICENSE_JWT_PRIVATE_KEY is required when NODE_ENV=production. '
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

module.exports = {
  privateKey,
  publicKey,
  publicKeyHex: rawPublicKeyHex(publicKey),
  rawPublicKeyHex,
  privateKeyFromSeed,
};
