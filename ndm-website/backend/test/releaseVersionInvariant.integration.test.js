'use strict';

/**
 * WP-03 — the release publish path must refuse a build from another version.
 *
 * Evidence: /download advertised "Linux · Version 0.3.0 · 34.8 MB" while
 * `Content-Disposition` served `nexa_0.2.0_amd64.deb`, and the SHA-256 matched
 * the served bytes exactly. The checksum machinery worked perfectly; nothing
 * ever asked whether the artifact belonged to the release row it was attached
 * to.
 *
 * This drives the real HTTP upload endpoint with a real .deb, so it proves the
 * invariant is enforced where releases are actually published — not just that
 * the version reader works.
 */

process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const bcrypt = require('bcryptjs');
const srv = require('./helpers/testServer');

const Release = require('../src/models/Release');
const { query } = require('../src/config/db');

// ── a minimal but structurally real .deb ────────────────────────────────────

function tarFile(name, body) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'ascii');
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header.write('        ', 148, 'ascii');
  header.write('0', 156, 'ascii');
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded, Buffer.alloc(1024)]);
}

function arMember(name, data) {
  const header = Buffer.alloc(60, 0x20);
  header.write(`${name}/`, 0, 'ascii');
  header.write(String(data.length).padEnd(10), 48, 'ascii');
  header.write('`\n', 58, 'ascii');
  const pad = data.length % 2 ? Buffer.from('\n') : Buffer.alloc(0);
  return Buffer.concat([header, data, pad]);
}

function makeDeb(version) {
  const control = Buffer.from(
    `Package: nexa\nVersion: ${version}\nArchitecture: amd64\nMaintainer: Nexa <x@example.test>\nDescription: test\n`,
    'utf8'
  );
  return Buffer.concat([
    Buffer.from('!<arch>\n', 'ascii'),
    arMember('debian-binary', Buffer.from('2.0\n')),
    arMember('control.tar.gz', zlib.gzipSync(tarFile('./control', control))),
    arMember('data.tar.gz', zlib.gzipSync(Buffer.alloc(512))),
  ]);
}

// Signed in through the real endpoint: a bearer is bound to the session row
// the sign-in opens (H-08), so one minted by hand with no row would be refused.
async function makeAdmin(baseUrl) {
  const email = `admin${Date.now()}@example.test`;
  const password = 'release-admin-password';
  await query(
    'INSERT INTO users (name, email, password_hash, role, email_verified) VALUES (?, ?, ?, ?, 1)',
    ['Release Admin', email, await bcrypt.hash(password, 4), 'admin']
  );
  const res = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok || !body.data?.token) throw new Error(`admin login failed: ${JSON.stringify(body)}`);
  return body.data.token;
}

/** Raw octet-stream PUT, the way the admin panel uploads an installer. */
async function putArtifact(baseUrl, token, releaseId, os, body, filename) {
  const res = await fetch(`${baseUrl}/api/admin/releases/${releaseId}/artifact/${os}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      authorization: `Bearer ${token}`,
      'x-filename': filename,
    },
    body,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('release version invariant', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  const baseUrl = await srv.start();
  // Reset ONCE: reset() truncates users, which would invalidate the admin token
  // the subtests sign in with. Each subtest uses its own release version
  // instead of clearing the table between them.
  await srv.reset();

  let token;
  try {
    token = await makeAdmin(baseUrl);
  } catch (err) {
    t.skip(`could not seed an admin: ${err.message}`);
    await srv.stop();
    return;
  }

  await t.test('refuses an installer that belongs to a different version', async () => {
    const release = await Release.create({
      version: '0.3.0', windowsUrl: '', linuxUrl: '', changelog: '', isLatest: true,
      windowsSha256: null, linuxSha256: null,
    });

    // The audit's exact case: named 0.3.0, actually 0.2.0.
    const res = await putArtifact(
      baseUrl, token, release.id, 'linux', makeDeb('0.2.0'), 'nexa_0.3.0_amd64.deb'
    );

    assert.equal(res.status, 409, 'a mismatched build must be refused');
    assert.equal(res.body.error.code, 'VERSION_MISMATCH');
    assert.equal(res.body.error.details.artifactVersion, '0.2.0');
    assert.equal(res.body.error.details.releaseVersion, '0.3.0');

    // And the release must be left with nothing rather than the wrong file.
    const after = await Release.findById(release.id);
    assert.equal(after.linux_file || '', '', 'the rejected upload must not be stored');
  });

  await t.test('accepts the matching build', async () => {
    const release = await Release.create({
      version: '0.4.0', windowsUrl: '', linuxUrl: '', changelog: '', isLatest: true,
      windowsSha256: null, linuxSha256: null,
    });

    const res = await putArtifact(
      baseUrl, token, release.id, 'linux', makeDeb('0.4.0'), 'nexa_0.4.0_amd64.deb'
    );

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.artifactVersion, '0.4.0');
    assert.equal(res.body.data.versionWarning, null);
  });

  await t.test('a dpkg revision still counts as the same release', async () => {
    const release = await Release.create({
      version: '0.5.0', windowsUrl: '', linuxUrl: '', changelog: '', isLatest: true,
      windowsSha256: null, linuxSha256: null,
    });

    const res = await putArtifact(
      baseUrl, token, release.id, 'linux', makeDeb('0.5.0-1'), 'nexa_0.5.0-1_amd64.deb'
    );
    assert.equal(res.status, 200, 'packaging revisions are not a different product version');
  });

  await t.test('says so when the version cannot be read, rather than passing silently', async () => {
    const release = await Release.create({
      version: '0.6.0', windowsUrl: '', linuxUrl: '', changelog: '', isLatest: true,
      windowsSha256: null, linuxSha256: null,
    });

    // A .deb we cannot introspect (no ar header) is accepted — refusing would
    // block legitimate formats — but the operator is told it went unchecked.
    const res = await putArtifact(
      baseUrl, token, release.id, 'linux', Buffer.from('not really a deb'), 'nexa_0.6.0_amd64.deb'
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.data.artifactVersion, null);
    assert.match(res.body.data.versionWarning, /could not read a version/i);
  });

  await srv.stop();
});
