'use strict';

/**
 * Abandoned upload temp files get swept (AUDIT.md L-05).
 *
 * `storeUpload` writes `.incoming-<uuid>` and renames on success, and a clean
 * failure removes its own file. What it cannot clean up after is the process
 * dying mid-upload — a restart, an OOM, a deploy — which strands a partial
 * installer of up to MAX_RELEASE_UPLOAD_MB with nothing that will ever look at
 * it again. On shared hosting the disk quota is what runs out first.
 *
 * Age is the entire safety mechanism, so the cases that matter are the ones
 * where sweeping would be wrong: an upload still in flight, and every real
 * release sitting in the same directory.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

let dir;

// RELEASE_UPLOAD_DIR is read through config at call time, so the directory has
// to exist before releaseFiles is required.
test.before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ndm-sweep-'));
  process.env.RELEASE_UPLOAD_DIR = dir;
});

test.beforeEach(async () => {
  for (const name of await fsp.readdir(dir)) {
    await fsp.rm(path.join(dir, name), { recursive: true, force: true });
  }
});

test.after(async () => {
  if (dir) await fsp.rm(dir, { recursive: true, force: true });
});

async function write(name, ageMs = 0) {
  const full = path.join(dir, name);
  await fsp.writeFile(full, 'x'.repeat(64));
  if (ageMs) {
    const when = new Date(Date.now() - ageMs);
    await fsp.utimes(full, when, when);
  }
  return full;
}

const ls = async () => (await fsp.readdir(dir)).sort();

test('an abandoned temp file older than the cut-off is removed', async () => {
  const { sweepIncoming, INCOMING_MAX_AGE_MS } = require('../src/utils/releaseFiles');
  await write('.incoming-abandoned', INCOMING_MAX_AGE_MS + 60_000);

  assert.equal(await sweepIncoming(), 1);
  assert.deepEqual(await ls(), []);
});

test('an upload still in flight is left alone', async () => {
  const { sweepIncoming } = require('../src/utils/releaseFiles');
  // A fresh mtime is what tells a live upload from a dead one. Sweeping this
  // would delete the file out from under a writer mid-stream.
  await write('.incoming-in-flight');

  assert.equal(await sweepIncoming(), 0);
  assert.deepEqual(await ls(), ['.incoming-in-flight']);
});

test('real installers are never touched, however old', async () => {
  const { sweepIncoming, INCOMING_MAX_AGE_MS } = require('../src/utils/releaseFiles');
  // A year-old release is a release, not litter. Only the .incoming- prefix
  // marks a file as something nobody is coming back for.
  await write('windows-1.0.0-uuid.exe', 365 * 24 * 60 * 60 * 1000);
  await write('linux-1.0.0-uuid.deb', 365 * 24 * 60 * 60 * 1000);
  await write('.incoming-old', INCOMING_MAX_AGE_MS + 60_000);

  assert.equal(await sweepIncoming(), 1);
  assert.deepEqual(await ls(), ['linux-1.0.0-uuid.deb', 'windows-1.0.0-uuid.exe']);
});

test('the cut-off is a boundary, not a suggestion', async () => {
  const { sweepIncoming } = require('../src/utils/releaseFiles');
  await write('.incoming-just-inside', 60_000);
  await write('.incoming-just-outside', 120_000);

  // Swept with an explicit 90 s window: one file each side of it.
  assert.equal(await sweepIncoming({ maxAgeMs: 90_000 }), 1);
  assert.deepEqual(await ls(), ['.incoming-just-inside']);
});

test('a missing upload directory is not an error', async () => {
  const { sweepIncoming } = require('../src/utils/releaseFiles');
  const saved = process.env.RELEASE_UPLOAD_DIR;
  // Nothing has ever been uploaded on a fresh deployment, and reporting that
  // as a failure every six hours would train everyone to ignore the log.
  process.env.RELEASE_UPLOAD_DIR = path.join(dir, 'does-not-exist');
  try {
    assert.equal(await sweepIncoming(), 0);
  } finally {
    process.env.RELEASE_UPLOAD_DIR = saved;
  }
});
