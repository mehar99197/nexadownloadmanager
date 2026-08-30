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
