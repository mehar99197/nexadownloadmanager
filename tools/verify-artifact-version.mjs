#!/usr/bin/env node
/**
 * Assert that a built artifact declares the version we think it does.
 *
 * WP-03 — /download advertised "Linux · Version 0.3.0 · 34.8 MB" while serving
 * `nexa_0.2.0_amd64.deb`. The SHA-256 was correct for the served bytes, so
 * every checksum check passed; the artifact was simply the wrong build. The
 * invariant that was missing is:
 *
 *     release.version === deb control Version === filename version
 *                     === exe product version
 *
 * This enforces it at build time. The API enforces the same rule at publish
 * time (backend/src/utils/artifactVersion.js + the admin upload route), so a
 * mismatch cannot reach the website even if it is uploaded by hand.
 *
 * Usage:
 *   node tools/verify-artifact-version.mjs <file> <windows|linux> <expected>
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { gunzipSync } from 'node:zlib';

const [, , file, os, expected] = process.argv;

if (!file || !os || !expected) {
  console.error('usage: verify-artifact-version.mjs <file> <windows|linux> <expected-version>');
  process.exit(2);
}

const VS_FIXEDFILEINFO_SIGNATURE = 0xfeef04bd;

/** Normalise for comparison: drop a dpkg revision and trailing zero parts. */
function normalise(version) {
  const parts = String(version).split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  while (parts.length > 1 && parts[parts.length - 1] === 0) parts.pop();
  return parts.join('.');
}

function peProductVersion(buf) {
  const needle = Buffer.alloc(4);
  needle.writeUInt32LE(VS_FIXEDFILEINFO_SIGNATURE, 0);
  const at = buf.indexOf(needle);
  if (at < 0) return null;
  const ms = buf.readUInt32LE(at + 16);
  const ls = buf.readUInt32LE(at + 20);
  const parts = [(ms >>> 16) & 0xffff, ms & 0xffff, (ls >>> 16) & 0xffff, ls & 0xffff];
  while (parts.length > 3 && parts[parts.length - 1] === 0) parts.pop();
  return parts.join('.');
}

function debControlVersion(buf) {
  if (buf.subarray(0, 8).toString('ascii') !== '!<arch>\n') return null;
  let off = 8;
  while (off + 60 <= buf.length) {
    const name = buf.subarray(off, off + 16).toString('ascii').trim().replace(/\/$/, '');
    const size = Number.parseInt(buf.subarray(off + 48, off + 58).toString('ascii').trim(), 10);
    if (!Number.isFinite(size)) return null;
    const start = off + 60;
    if (name.startsWith('control.tar')) {
      let tar = buf.subarray(start, start + size);
      if (name.endsWith('.gz')) {
        try { tar = gunzipSync(tar); } catch { return null; }
      } else if (name !== 'control.tar') {
        return null; // .xz needs an external tool
      }
      let o = 0;
      while (o + 512 <= tar.length) {
        const entry = tar.subarray(o, o + 100).toString('ascii').replace(/\0.*$/, '');
        if (!entry) break;
        const len = Number.parseInt(
          tar.subarray(o + 124, o + 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8
        );
        if (entry === 'control' || entry === './control') {
          const text = tar.subarray(o + 512, o + 512 + len).toString('utf8');
          return text.match(/^Version:\s*(\S+)\s*$/m)?.[1] ?? null;
        }
        o += 512 + Math.ceil(len / 512) * 512;
      }
      return null;
    }
    off = start + size + (size % 2);
  }
  return null;
}

const buf = readFileSync(file);
const problems = [];

// 1. The version embedded in the artifact itself.
const embedded = os === 'windows' ? peProductVersion(buf) : debControlVersion(buf);
if (embedded === null) {
  console.error(`verify-artifact-version: could not read a version out of ${file}`);
  process.exit(1);
}
if (normalise(embedded) !== normalise(expected)) {
  problems.push(`the artifact declares ${embedded}, expected ${expected}`);
}

// 2. The version in the filename, when it carries one. This is the field that
//    was stale in production: the page read it and believed it.
const inName = basename(file).match(/(\d+\.\d+(?:\.\d+)?)/)?.[1];
if (inName && normalise(inName) !== normalise(expected)) {
  problems.push(`the filename says ${inName}, expected ${expected}`);
}

if (problems.length) {
  console.error(`verify-artifact-version: ${file}`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `verify-artifact-version: ${basename(file)} is ${embedded} `
  + `(${os === 'windows' ? 'PE product version' : 'deb control Version'}), matching ${expected}.`
);
