'use strict';

const zlib = require('node:zlib');
const fs = require('node:fs');

/**
 * Read the version an installer declares about ITSELF.
 *
 * WP-03 — /download advertised "Linux · Version 0.3.0" while the served file
 * was `nexa_0.2.0_amd64.deb`, and the SHA-256 matched the served bytes. The
 * checksum was never the problem: nothing anywhere compared the artifact's own
 * version with the release row it was uploaded to, so an admin uploading the
 * wrong build produced a page that was confidently wrong.
 *
 * Both readers work on the bytes, not on the filename — the filename arrives in
 * an `x-filename` header and is whatever the uploader says it is.
 *
 * Every function returns `{ version, source }` on success, or
 * `{ version: null, reason }` when the format is understood but the version
 * cannot be read. A null version is NOT proof of a mismatch; callers must treat
 * it as "unknown" and say so rather than rejecting a valid upload.
 */

// ── Windows PE ──────────────────────────────────────────────────────────────

// VS_FIXEDFILEINFO.dwSignature. It appears once, inside the RT_VERSION
// resource, so scanning for it is far shorter than walking the whole resource
// directory tree and gives exactly the same answer.
const VS_FIXEDFILEINFO_SIGNATURE = 0xfeef04bd;

/**
 * Product version from a PE's version resource, e.g. "0.2.1".
 *
 * Layout after the signature: dwStrucVersion, then dwFileVersionMS/LS and
 * dwProductVersionMS/LS, each a pair of 16-bit halves packed high-word first.
 */
function readPeProductVersion(buf) {
  if (buf.length < 64 || buf.readUInt16LE(0) !== 0x5a4d) {
    return { version: null, reason: 'not a PE executable (no MZ header)' };
  }

  const at = buf.indexOf(
    Buffer.from([
      VS_FIXEDFILEINFO_SIGNATURE & 0xff,
      (VS_FIXEDFILEINFO_SIGNATURE >>> 8) & 0xff,
      (VS_FIXEDFILEINFO_SIGNATURE >>> 16) & 0xff,
      (VS_FIXEDFILEINFO_SIGNATURE >>> 24) & 0xff,
    ])
  );
  if (at < 0 || at + 24 > buf.length) {
    return { version: null, reason: 'no VS_VERSIONINFO resource in the executable' };
  }

  const productMs = buf.readUInt32LE(at + 16);
  const productLs = buf.readUInt32LE(at + 20);
  const parts = [
    (productMs >>> 16) & 0xffff,
    productMs & 0xffff,
    (productLs >>> 16) & 0xffff,
    productLs & 0xffff,
  ];

  // Installers stamp 0.2.1 as 0.2.1.0; the trailing build number is noise when
  // comparing against a release row, so it is dropped when it is zero.
  while (parts.length > 3 && parts[parts.length - 1] === 0) parts.pop();
  return { version: parts.join('.'), source: 'pe-version-resource' };
}

// ── Debian package ──────────────────────────────────────────────────────────

/** Entries of an `ar` archive: [{ name, data }]. A .deb is an ar archive. */
function readArEntries(buf) {
  if (buf.subarray(0, 8).toString('ascii') !== '!<arch>\n') return null;
  const entries = [];
  let off = 8;
  while (off + 60 <= buf.length) {
    const name = buf.subarray(off, off + 16).toString('ascii').trim().replace(/\/$/, '');
    const size = Number.parseInt(buf.subarray(off + 48, off + 58).toString('ascii').trim(), 10);
    if (!Number.isFinite(size)) break;
    const start = off + 60;
    entries.push({ name, data: buf.subarray(start, start + size) });
    // ar pads every member to an even offset.
    off = start + size + (size % 2);
  }
  return entries;
}

/** Find one file inside an uncompressed tar buffer. */
function readTarFile(tar, wanted) {
  let off = 0;
  while (off + 512 <= tar.length) {
    const name = tar.subarray(off, off + 100).toString('ascii').replace(/\0.*$/, '');
    if (!name) break;
    const size = Number.parseInt(
      tar.subarray(off + 124, off + 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8
    );
    const body = tar.subarray(off + 512, off + 512 + size);
    if (name === wanted || name === `./${wanted}`) return body;
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

/**
 * `Version:` from a .deb's DEBIAN/control — the same field
 * `dpkg-deb -f <file> Version` prints.
 */
function readDebVersion(buf) {
  const entries = readArEntries(buf);
  if (!entries) return { version: null, reason: 'not a .deb (no ar archive header)' };

  const control = entries.find((e) => e.name.startsWith('control.tar'));
  if (!control) return { version: null, reason: 'no control.tar member in the .deb' };

  let tar;
  if (control.name.endsWith('.gz')) {
    try { tar = zlib.gunzipSync(control.data); }
    catch { return { version: null, reason: 'control.tar.gz could not be decompressed' }; }
  } else if (control.name === 'control.tar') {
    tar = control.data;
  } else {
    // control.tar.xz needs an external decompressor; Node has no xz. Report it
    // rather than guessing, so the caller can warn instead of rejecting.
    return { version: null, reason: `unsupported control archive: ${control.name}` };
  }

  const file = readTarFile(tar, 'control');
  if (!file) return { version: null, reason: 'no control file inside control.tar' };

  const match = file.toString('utf8').match(/^Version:\s*(\S+)\s*$/m);
  if (!match) return { version: null, reason: 'control file declares no Version' };
  return { version: match[1], source: 'deb-control' };
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/** Read the embedded version for a given OS ('windows' | 'linux'). */
function artifactVersion(buf, os) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return { version: null, reason: 'empty artifact' };
  }
  if (os === 'windows') return readPeProductVersion(buf);
  if (os === 'linux') return readDebVersion(buf);
  return { version: null, reason: `unknown platform: ${os}` };
}

/**
 * Do two version strings describe the same release?
 *
 * Trailing zero components are ignored so a PE's "0.3.0.0" matches a release
 * row's "0.3.0". A Debian revision ("0.3.0-1") also matches "0.3.0" — dpkg
 * revisions are packaging metadata, not a different build of the product.
 */
function versionsMatch(a, b) {
  if (!a || !b) return false;
  const norm = (v) => {
    const parts = String(v).split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
    while (parts.length > 1 && parts[parts.length - 1] === 0) parts.pop();
    return parts.join('.');
  };
  return norm(a) === norm(b);
}

/**
 * Same as artifactVersion(), reading from a file on disk.
 *
 * A .deb keeps control.tar right after the 4-byte `debian-binary` member, so
 * the head of the file is enough. A PE's version resource can sit anywhere, so
 * that one is scanned in chunks with a 3-byte overlap rather than loaded whole
 * — the Windows installer is ~187 MB and holding that in memory to read four
 * numbers would be silly.
 */
async function artifactVersionFromFile(filePath, os, { headBytes = 4 * 1024 * 1024 } = {}) {
  if (!filePath) return { version: null, reason: 'no stored file' };

  if (os === 'linux') {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(headBytes, size);
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, 0);
      return readDebVersion(buf);
    } finally {
      await handle.close();
    }
  }

  if (os !== 'windows') return { version: null, reason: `unknown platform: ${os}` };

  const needle = Buffer.alloc(4);
  needle.writeUInt32LE(VS_FIXEDFILEINFO_SIGNATURE, 0);

  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    // Enough bytes after the signature to hold VS_FIXEDFILEINFO's version words.
    const TAIL = 24;
    let carry = Buffer.alloc(0);
    let done = false;

    stream.on('data', (chunk) => {
      if (done) return;
      const window = Buffer.concat([carry, chunk]);
      const at = window.indexOf(needle);
      if (at >= 0 && at + TAIL <= window.length) {
        done = true;
        stream.destroy();
        resolve(readPeProductVersion(Buffer.concat([
          Buffer.from([0x4d, 0x5a]), Buffer.alloc(62), window.subarray(at, at + TAIL),
        ])));
        return;
      }
      // Keep enough tail to catch a signature straddling the chunk boundary.
      carry = window.subarray(Math.max(0, window.length - (needle.length - 1 + TAIL)));
    });
    stream.on('error', reject);
    stream.on('close', () => {
      if (!done) resolve({ version: null, reason: 'no VS_VERSIONINFO resource in the executable' });
    });
  });
}

module.exports = {
  artifactVersion,
  artifactVersionFromFile,
  readPeProductVersion,
  readDebVersion,
  versionsMatch,
  VS_FIXEDFILEINFO_SIGNATURE,
};
