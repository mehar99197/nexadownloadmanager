'use strict';

/**
 * WP-03 — proving the version invariant can actually be enforced.
 *
 * The audit's evidence: /download advertised "Linux · Version 0.3.0" while the
 * served file was nexa_0.2.0_amd64.deb, and the SHA-256 matched the served
 * bytes over all 36,475,904 of them. The checksum was right; the artifact was
 * the wrong build. Nothing compared the two.
 *
 * These tests build real .deb and PE byte layouts in memory, so they prove the
 * readers work on bytes rather than on a filename an uploader controls.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const {
  artifactVersion, readPeProductVersion, readDebVersion, versionsMatch,
  VS_FIXEDFILEINFO_SIGNATURE,
} = require('../src/utils/artifactVersion');

// ── fixtures ────────────────────────────────────────────────────────────────

/** A 512-byte tar header plus padded body, enough for one file. */
function tarFile(name, body) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'ascii');
  header.write('0000644\0', 100, 'ascii');            // mode
  header.write('0000000\0', 108, 'ascii');            // uid
  header.write('0000000\0', 116, 'ascii');            // gid
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');        // mtime
  header.write('        ', 148, 'ascii');             // checksum placeholder
  header.write('0', 156, 'ascii');                    // type: regular file
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');

  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded, Buffer.alloc(1024)]); // two empty blocks
}

function arMember(name, data) {
  const header = Buffer.alloc(60, 0x20);
  header.write(`${name}/`, 0, 'ascii');
  header.write('0'.padEnd(12), 16, 'ascii');
  header.write('0'.padEnd(6), 28, 'ascii');
  header.write('0'.padEnd(6), 34, 'ascii');
  header.write('100644'.padEnd(8), 40, 'ascii');
  header.write(String(data.length).padEnd(10), 48, 'ascii');
  header.write('`\n', 58, 'ascii');
  const pad = data.length % 2 ? Buffer.from('\n') : Buffer.alloc(0);
  return Buffer.concat([header, data, pad]);
}

/** A .deb whose DEBIAN/control declares `version`. */
function makeDeb(version, { compress = 'gz' } = {}) {
  const control = Buffer.from(
    `Package: nexa\nVersion: ${version}\nArchitecture: amd64\nMaintainer: Nexa <x@example.test>\nDescription: test\n`,
    'utf8'
  );
  const tar = tarFile('./control', control);
  const body = compress === 'gz' ? zlib.gzipSync(tar) : tar;
  const name = compress === 'gz' ? 'control.tar.gz' : 'control.tar';
  return Buffer.concat([
    Buffer.from('!<arch>\n', 'ascii'),
    arMember('debian-binary', Buffer.from('2.0\n')),
    arMember(name, body),
    arMember('data.tar.gz', zlib.gzipSync(Buffer.alloc(1024))),
  ]);
}

/** A PE-shaped buffer carrying a VS_FIXEDFILEINFO with `version`. */
function makeExe(version) {
  const [a = 0, b = 0, c = 0, d = 0] = version.split('.').map(Number);
  const buf = Buffer.alloc(4096);
  buf.writeUInt16LE(0x5a4d, 0);                       // "MZ"
  const at = 1024;
  buf.writeUInt32LE(VS_FIXEDFILEINFO_SIGNATURE, at);
  buf.writeUInt32LE(0x00010000, at + 4);              // dwStrucVersion
  buf.writeUInt32LE(((a << 16) | b) >>> 0, at + 8);   // file version MS
  buf.writeUInt32LE(((c << 16) | d) >>> 0, at + 12);  // file version LS
  buf.writeUInt32LE(((a << 16) | b) >>> 0, at + 16);  // product version MS
  buf.writeUInt32LE(((c << 16) | d) >>> 0, at + 20);  // product version LS
  return buf;
}

// ── .deb ────────────────────────────────────────────────────────────────────

test('reads the Version out of a .deb control file', () => {
  const res = readDebVersion(makeDeb('0.2.0'));
  assert.equal(res.version, '0.2.0');
  assert.equal(res.source, 'deb-control');
});

test('reads an uncompressed control.tar too', () => {
  assert.equal(readDebVersion(makeDeb('1.4.2', { compress: 'none' })).version, '1.4.2');
});

test('ignores the filename entirely — only the bytes count', () => {
  // This is the audit's exact scenario: a file NAMED 0.3.0 that IS 0.2.0.
  const deb = makeDeb('0.2.0');
  const res = artifactVersion(deb, 'linux');
  assert.equal(res.version, '0.2.0');
  assert.equal(versionsMatch(res.version, '0.3.0'), false,
    'a 0.2.0 package must not satisfy a 0.3.0 release');
});

test('says why, rather than guessing, when the control archive is unreadable', () => {
  const res = readDebVersion(Buffer.from('not a deb at all'));
  assert.equal(res.version, null);
  assert.match(res.reason, /ar archive/);
});

// ── PE ──────────────────────────────────────────────────────────────────────

test('reads the product version out of a PE resource', () => {
  assert.equal(readPeProductVersion(makeExe('0.2.1.0')).version, '0.2.1');
  // Normalised to three components: only the trailing build number is dropped.
  assert.equal(readPeProductVersion(makeExe('1.0.0.0')).version, '1.0.0');
});

test('reports a missing version resource instead of returning a wrong number', () => {
  const buf = Buffer.alloc(2048);
  buf.writeUInt16LE(0x5a4d, 0);
  const res = readPeProductVersion(buf);
  assert.equal(res.version, null);
  assert.match(res.reason, /VS_VERSIONINFO/);
});

test('rejects something that is not a PE at all', () => {
  assert.match(readPeProductVersion(Buffer.from('#!/bin/sh\n')).reason, /not a PE/);
});

// ── comparison ──────────────────────────────────────────────────────────────

test('version comparison ignores trailing zeros and dpkg revisions', () => {
  assert.equal(versionsMatch('0.3.0.0', '0.3'), true);
  assert.equal(versionsMatch('0.3.0', '0.3.0-1'), true);
  assert.equal(versionsMatch('0.3.0', '0.3.1'), false);
  assert.equal(versionsMatch('0.3.0', ''), false);
  assert.equal(versionsMatch(null, '0.3.0'), false);
});

test('an empty upload is unknown, not a match', () => {
  const res = artifactVersion(Buffer.alloc(0), 'windows');
  assert.equal(res.version, null);
  assert.match(res.reason, /empty/);
});
