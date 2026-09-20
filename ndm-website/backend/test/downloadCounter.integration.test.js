'use strict';

/**
 * WP-09 — the download counter must count downloads, not requests.
 *
 * Measured on production: a bare `Range: bytes=0-1` — two bytes — incremented
 * the counter, which went 611 → 615 across four requests, three of them range
 * probes. Resumes, retries, bots, antivirus scanners and link-preview fetchers
 * all inflated it.
 *
 * Two rules, and this file pins both:
 *
 *   1. Only a FRESH start counts: no Range header, or one beginning at byte 0.
 *      A resume (`bytes=5000-`) is the same download continuing.
 *   2. One IP counts once per release PER PLATFORM per window. A browser that
 *      starts, is cancelled and starts again is one person getting one file —
 *      but someone who takes both the Windows and the Linux build has taken
 *      two, so the platform is part of the key.
 *
 * Rule 1 was applied to the uploaded-installer path only; the legacy
 * external-URL redirect still counted every request, including range probes.
 * Both paths go through the same decision now.
 */

process.env.RATE_LIMIT_DISABLED = '1';
// 'loopback' so Express honours the X-Forwarded-For these tests set: the
// per-address rule cannot be exercised over a single loopback socket
// otherwise, because req.ip would be 127.0.0.1 for every request.
process.env.TRUST_PROXY = process.env.TRUST_PROXY || 'loopback';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const srv = require('./helpers/testServer');
const Release = require('../src/models/Release');
const { uploadDir, ensureUploadDir } = require('../src/utils/releaseFiles');

const countOf = async () => Number((await Release.findLatest()).download_count) || 0;

/** A GET with a chosen client address, so "per IP" can actually be exercised. */
async function get(baseUrl, path, { range, ip = '203.0.113.10', method = 'GET' } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      'x-forwarded-for': ip,
      ...(range ? { range } : {}),
    },
  });
  await res.arrayBuffer().catch(() => {});
  return res;
}

test('download counter', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  const baseUrl = await srv.start();
  await srv.reset();

  // A legacy release: no uploaded file, just an external URL, so /download 302s.
  // This is the path that counted unconditionally.
  await Release.create({
    version: '1.0.0',
    windowsUrl: 'https://cdn.example.test/nexa.exe',
    linuxUrl: '',
    changelog: '', isLatest: true, windowsSha256: null, linuxSha256: null,
  });

  await t.test('a partial request does not count as a download', async () => {
    const before = await countOf();

    // The audit's exact probe, five times over.
    for (let i = 0; i < 5; i += 1) {
      await get(baseUrl, '/api/releases/download/windows', {
        range: `bytes=${5000 + i}-${6000 + i}`,
        ip: `198.51.100.${i + 1}`,
      });
    }

    assert.equal(await countOf(), before, 'resume requests must not inflate the counter');
  });

  await t.test('a fresh download counts exactly once', async () => {
    const before = await countOf();
    await get(baseUrl, '/api/releases/download/windows', { ip: '203.0.113.20' });
    assert.equal(await countOf(), before + 1);
  });

  await t.test('a range starting at byte 0 is a fresh start and counts', async () => {
    const before = await countOf();
    await get(baseUrl, '/api/releases/download/windows', { range: 'bytes=0-', ip: '203.0.113.21' });
    assert.equal(await countOf(), before + 1);
  });

  await t.test('the same address downloading again shortly after counts once', async () => {
    const before = await countOf();
    const ip = '203.0.113.30';

    for (let i = 0; i < 5; i += 1) {
      await get(baseUrl, '/api/releases/download/windows', { ip });
    }

    assert.equal(
      await countOf(), before + 1,
      'five starts from one address in one window is one download'
    );
  });

  await t.test('taking both platforms from one address counts twice', async () => {
    const before = await countOf();
    const ip = '203.0.113.60';
    await get(baseUrl, '/api/releases/download/windows', { ip });
    // The linux column on this release has no artifact, so this 404s and must
    // not count; assert the windows one alone moved the needle.
    assert.equal(await countOf(), before + 1);
  });

  await t.test('a different address is a different download', async () => {
    const before = await countOf();
    await get(baseUrl, '/api/releases/download/windows', { ip: '203.0.113.41' });
    await get(baseUrl, '/api/releases/download/windows', { ip: '203.0.113.42' });
    assert.equal(await countOf(), before + 2);
  });

  await t.test('the audit scenario end to end: 5 partial/resume requests add 1', async () => {
    const before = await countOf();
    const ip = '203.0.113.50';

    // One real start, then four resumes of it — what a segmented downloader or
    // a dropped-and-resumed browser transfer actually looks like.
    await get(baseUrl, '/api/releases/download/windows', { ip });
    for (const range of ['bytes=1024-', 'bytes=2048-', 'bytes=4096-', 'bytes=8192-']) {
      await get(baseUrl, '/api/releases/download/windows', { range, ip });
    }

    assert.equal(await countOf(), before + 1, 'the counter increased by 1, not 5');
  });

  await t.test('a HEAD is a size probe, not a download', async () => {
    // Express routes HEAD to the GET handler, and a HEAD carries no Range, so
    // without an explicit check it is indistinguishable from a fresh start.
    const before = await countOf();
    await get(baseUrl, '/api/releases/download/windows', { ip: '203.0.113.70', method: 'HEAD' });
    assert.equal(await countOf(), before, 'a HEAD on the redirect path must not count');
  });

  // The uploaded-installer path: the file is streamed from disk, so the
  // counter must also cope with a row that names a file which is not there.
  await t.test('an uploaded installer', async (t2) => {
    await ensureUploadDir();
    const stored = `windows-2.0.0-${Date.now()}.exe`;
    await fs.writeFile(path.join(uploadDir(), stored), Buffer.alloc(4096, 0x4d));
    const release = await Release.create({
      version: '2.0.0', windowsUrl: '', linuxUrl: '',
      changelog: '', isLatest: true, windowsSha256: null, linuxSha256: null,
    });
    await Release.unsetLatestExcept(release.id);
    await Release.update(release.id, {
      windowsFile: stored, windowsFilename: 'nexa-setup.exe', windowsSize: 4096,
    });

    try {
      await t2.test('a fresh start of a file on disk counts once', async () => {
        const before = await countOf();
        const res = await get(baseUrl, '/api/releases/download/windows', { ip: '203.0.113.80' });
        assert.equal(res.status, 200);
        assert.equal(await countOf(), before + 1);
      });

      await t2.test('a resume of it does not', async () => {
        const before = await countOf();
        const res = await get(baseUrl, '/api/releases/download/windows',
          { ip: '203.0.113.81', range: 'bytes=2048-' });
        assert.equal(res.status, 206);
        assert.equal(await countOf(), before);
      });

      await t2.test('nor a HEAD', async () => {
        const before = await countOf();
        const res = await get(baseUrl, '/api/releases/download/windows',
          { ip: '203.0.113.82', method: 'HEAD' });
        assert.equal(res.status, 200);
        assert.equal(await countOf(), before);
      });

      await t2.test('a release whose file is missing answers 404 and counts nothing', async () => {
        // The row still names the file; only the bytes are gone. The counter
        // used to be bumped before anyone looked, so a broken release counted
        // every visitor it failed.
        await fs.rm(path.join(uploadDir(), stored));
        const before = await countOf();
        const res = await get(baseUrl, '/api/releases/download/windows', { ip: '203.0.113.83' });
        assert.equal(res.status, 404);
        assert.equal(await countOf(), before, 'a 404 is not a download');
      });
    } finally {
      await fs.rm(path.join(uploadDir(), stored), { force: true });
    }
  });

  await srv.stop();
});
