'use strict';

// Pure helpers for the desktop-app update feed (GET /api/releases/feed).
// No config or DB access here so the shaping can be unit-tested in isolation
// (the signing key is passed in rather than read from config for that reason).

const crypto = require('crypto');

const FEED_OSES = ['windows', 'linux'];

// Bumped if the signed field set ever changes, so an old client cannot be
// tricked by a payload that means something different to a new one.
const UPDATE_FEED_SIGNATURE_VERSION = 'nexa-update-v1';

function releaseUrlFor(release, os) {
  if (!release) return '';
  const url = os === 'windows' ? release.windows_url : release.linux_url;
  return typeof url === 'string' ? url.trim() : '';
}

// Stored filename of an uploaded installer, when the release carries one.
function releaseFileFor(release, os) {
  if (!release) return '';
  const file = os === 'windows' ? release.windows_file : release.linux_file;
  return typeof file === 'string' ? file.trim() : '';
}

// A release is downloadable for an OS if it has EITHER an uploaded installer or
// a legacy external URL. Uploads win; the URL columns stay only so releases
// published before uploads existed keep resolving.
function hasArtifact(release, os) {
  return Boolean(releaseFileFor(release, os) || releaseUrlFor(release, os));
}

function releaseSha256For(release, os) {
  if (!release) return '';
  const sha = os === 'windows' ? release.windows_sha256 : release.linux_sha256;
  return typeof sha === 'string' ? sha.trim().toLowerCase() : '';
}

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Absolute URL of the counting redirect for one OS, e.g.
// https://nexadownloadmanager.com/api/releases/download/windows
function downloadRedirectUrl(baseUrl, os) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return `${base}/api/releases/download/${os}`;
}

// buildFeed(release, os, baseUrl) → literal feed body or null when there is no
// release / no artifact URL for that OS. `release` is a raw `releases` row.
function buildFeed(release, os, baseUrl) {
  if (!release || !FEED_OSES.includes(os)) return null;
  if (!hasArtifact(release, os)) return null;
  return {
    version: String(release.version || ''),
    url: downloadRedirectUrl(baseUrl, os),
    notes: typeof release.changelog === 'string' ? release.changelog : '',
    sha256: releaseSha256For(release, os),
    publishedAt: toIso(release.published_at),
  };
}

/**
 * The exact bytes an update feed's signature covers.
 *
 * Only the fields that decide what gets executed: the version, where the
 * installer comes from, and the hash it is checked against. `notes` and
 * `publishedAt` are cosmetic and deliberately excluded, so editing a changelog
 * does not invalidate a signature.
 *
 * Newline-separated with a version prefix, because a delimiter-free
 * concatenation would let one field's content be shifted into the next.
 */
function updateFeedSigningPayload(feed) {
  return [
    UPDATE_FEED_SIGNATURE_VERSION,
    String(feed.version || ''),
    String(feed.url || ''),
    String(feed.sha256 || ''),
  ].join('\n');
}

/**
 * Attach an Ed25519 signature to a feed body.
 *
 * The update feed hands the app a URL and the SHA-256 it is verified against —
 * both from the same response — and the app then *runs* what it downloads. A
 * hash is therefore no protection at all against a feed that is not genuinely
 * ours: whoever controls the response controls both halves. Signing the feed is
 * what makes the checksum mean something.
 *
 * Uses the same key as licence tokens, so the desktop app already carries the
 * public half and there is one trust anchor to rotate rather than two.
 */
function signFeed(feed, privateKey) {
  if (!feed) return feed;
  const signature = crypto.sign(
    null, Buffer.from(updateFeedSigningPayload(feed), 'ascii'), privateKey);
  return { ...feed, signature: signature.toString('base64url') };
}

module.exports = {
  FEED_OSES, buildFeed, downloadRedirectUrl,
  releaseUrlFor, releaseFileFor, hasArtifact, releaseSha256For,
  updateFeedSigningPayload, signFeed, UPDATE_FEED_SIGNATURE_VERSION,
};
