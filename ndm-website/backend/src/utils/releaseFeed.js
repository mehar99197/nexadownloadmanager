'use strict';

// Pure helpers for the desktop-app update feed (GET /api/releases/feed).
// No config or DB access here so the shaping can be unit-tested in isolation.

const FEED_OSES = ['windows', 'linux'];

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

module.exports = {
  FEED_OSES, buildFeed, downloadRedirectUrl,
  releaseUrlFor, releaseFileFor, hasArtifact, releaseSha256For,
};
