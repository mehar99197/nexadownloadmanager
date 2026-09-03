'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFeed, downloadRedirectUrl, releaseUrlFor } = require('../src/utils/releaseFeed');

const release = {
  id: 7,
  version: '0.1.0',
  windows_url: 'https://downloads.example.test/0.1.0/setup.exe',
  linux_url: 'https://downloads.example.test/0.1.0/ndm_0.1.0_amd64.deb',
  windows_sha256: 'A'.repeat(64),
  linux_sha256: null,
  changelog: 'NexaDownloadManager 0.1.0\n- first release',
  download_count: 12,
  is_latest: 1,
  published_at: new Date('2026-08-01T12:34:56.000Z'),
};

test('buildFeed returns the literal feed body for windows', () => {
  const feed = buildFeed(release, 'windows', 'https://nexadownloadmanager.com');
  assert.deepEqual(feed, {
    version: '0.1.0',
    url: 'https://nexadownloadmanager.com/api/releases/download/windows',
    notes: 'NexaDownloadManager 0.1.0\n- first release',
    sha256: 'a'.repeat(64),
    publishedAt: '2026-08-01T12:34:56.000Z',
  });
  assert.deepEqual(Object.keys(feed), ['version', 'url', 'notes', 'sha256', 'publishedAt']);
});

test('buildFeed uses an empty sha256 when none is recorded and accepts string dates', () => {
  const feed = buildFeed({ ...release, published_at: '2026-08-02T00:00:00.000Z' }, 'linux', 'https://x.test/');
  assert.equal(feed.sha256, '');
  assert.equal(feed.url, 'https://x.test/api/releases/download/linux');
  assert.equal(feed.publishedAt, '2026-08-02T00:00:00.000Z');
});

test('buildFeed returns null when there is no release or no artifact for that OS', () => {
  assert.equal(buildFeed(null, 'windows', 'https://x.test'), null);
  assert.equal(buildFeed({ ...release, linux_url: '' }, 'linux', 'https://x.test'), null);
  assert.equal(buildFeed({ ...release, windows_url: '   ' }, 'windows', 'https://x.test'), null);
  assert.equal(buildFeed(release, 'macos', 'https://x.test'), null);
});

test('buildFeed never fabricates notes or dates', () => {
  const feed = buildFeed({ ...release, changelog: null, published_at: 'not a date' }, 'windows', 'https://x.test');
  assert.equal(feed.notes, '');
  assert.equal(feed.publishedAt, null);
});

test('downloadRedirectUrl strips trailing slashes from the base', () => {
  assert.equal(downloadRedirectUrl('https://x.test///', 'linux'), 'https://x.test/api/releases/download/linux');
  assert.equal(releaseUrlFor(release, 'linux'), release.linux_url);
  assert.equal(releaseUrlFor(null, 'linux'), '');
});

// --- Update-feed signing -----------------------------------------------------
//
// The feed names an installer AND the SHA-256 it is checked against, and the
// desktop app then runs what it downloads. Both halves come from the same
// response, so the hash proves only "the download matches what the feed said".
// The signature is what proves the feed is ours. The matching client-side check
// is feedSignatureValid() in src/core/UpdateChecker.cpp.

test('a signed feed carries a signature over version, url and sha256', () => {
  const crypto = require('crypto');
  const { signFeed, updateFeedSigningPayload } = require('../src/utils/releaseFeed');
  const { privateKey, publicKey } = require('../src/config/licenseKeys');

  const feed = {
    version: '2.1.0',
    url: 'https://nexadownloadmanager.com/api/releases/download/linux',
    notes: 'anything',
    sha256: 'b'.repeat(64),
    publishedAt: null,
  };
  const signed = signFeed(feed, privateKey);
  assert.ok(signed.signature, 'a signature is attached');
  assert.ok(crypto.verify(
    null,
    Buffer.from(updateFeedSigningPayload(signed), 'ascii'),
    publicKey,
    Buffer.from(signed.signature, 'base64url')
  ), 'and it verifies against the public key the app ships');
});

test('swapping the installer URL invalidates the signature', () => {
  const crypto = require('crypto');
  const { signFeed, updateFeedSigningPayload } = require('../src/utils/releaseFeed');
  const { privateKey, publicKey } = require('../src/config/licenseKeys');

  const signed = signFeed({
    version: '2.1.0',
    url: 'https://nexadownloadmanager.com/api/releases/download/windows',
    notes: '', sha256: 'c'.repeat(64), publishedAt: null,
  }, privateKey);

  // This is the attack: point the app at someone else's installer, and supply
  // the matching hash so the checksum still passes.
  const hijacked = { ...signed, url: 'https://evil.example.com/payload.exe' };
  assert.equal(crypto.verify(
    null,
    Buffer.from(updateFeedSigningPayload(hijacked), 'ascii'),
    publicKey,
    Buffer.from(hijacked.signature, 'base64url')
  ), false);
});

test('changing the sha256 invalidates the signature', () => {
  const crypto = require('crypto');
  const { signFeed, updateFeedSigningPayload } = require('../src/utils/releaseFeed');
  const { privateKey, publicKey } = require('../src/config/licenseKeys');

  const signed = signFeed({
    version: '2.1.0', url: 'https://nexadownloadmanager.com/x',
    notes: '', sha256: 'd'.repeat(64), publishedAt: null,
  }, privateKey);
  const swapped = { ...signed, sha256: 'e'.repeat(64) };
  assert.equal(crypto.verify(
    null,
    Buffer.from(updateFeedSigningPayload(swapped), 'ascii'),
    publicKey,
    Buffer.from(swapped.signature, 'base64url')
  ), false);
});

test('cosmetic fields are outside the signature, so editing notes is free', () => {
  const crypto = require('crypto');
  const { signFeed, updateFeedSigningPayload } = require('../src/utils/releaseFeed');
  const { privateKey, publicKey } = require('../src/config/licenseKeys');

  const signed = signFeed({
    version: '2.1.0', url: 'https://nexadownloadmanager.com/x',
    notes: 'first wording', sha256: 'f'.repeat(64), publishedAt: null,
  }, privateKey);
  const reworded = { ...signed, notes: 'a corrected changelog', publishedAt: '2026-01-01T00:00:00Z' };
  assert.ok(crypto.verify(
    null,
    Buffer.from(updateFeedSigningPayload(reworded), 'ascii'),
    publicKey,
    Buffer.from(reworded.signature, 'base64url')
  ), 'a changelog edit does not invalidate a release');
});

test('the signing payload is delimited, so fields cannot be shifted into each other', () => {
  const { updateFeedSigningPayload } = require('../src/utils/releaseFeed');
  const a = updateFeedSigningPayload({ version: '1.0', url: 'https://x/y', sha256: 'aa' });
  const b = updateFeedSigningPayload({ version: '1.0https://x/y', url: '', sha256: 'aa' });
  assert.notEqual(a, b);
});
