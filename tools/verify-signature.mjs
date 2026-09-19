#!/usr/bin/env node
/**
 * Assert that a Windows artifact carries an Authenticode signature.
 *
 * WP-02 — parsing the first 8192 bytes of the production installer showed a
 * PE32+ header whose Data Directory entry 4 (the Certificate Table) had
 * RVA = 0 and size = 0: no signature at all, so every Windows user meets a
 * SmartScreen warning before they can install.
 *
 * Usage:
 *   node tools/verify-signature.mjs NexaSetup.exe          # exit 1 if unsigned
 *   node tools/verify-signature.mjs NexaSetup.exe --warn   # report, exit 0
 *
 * `--warn` exists because there is no code-signing certificate yet. Drop the
 * flag from the workflow the day one lands and CI starts refusing unsigned
 * builds — which is the whole point of the check.
 */
import { readFileSync } from 'node:fs';

const [, , file, ...flags] = process.argv;
const warnOnly = flags.includes('--warn');

if (!file) {
  console.error('usage: verify-signature.mjs <file.exe> [--warn]');
  process.exit(2);
}

/** Certificate Table size from the PE optional header's data directory. */
export function certificateTableSize(buffer) {
  const view = new DataView(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  );

  if (view.byteLength < 0x40 || view.getUint16(0, true) !== 0x5a4d) {
    throw new Error('not a PE executable (no MZ header)');
  }

  const peOff = view.getUint32(0x3c, true);
  if (view.getUint32(peOff, true) !== 0x00004550) {
    throw new Error('not a PE executable (no PE signature)');
  }

  // 0x20b = PE32+ (64-bit) has a larger optional header than PE32's 0x10b.
  const magic = view.getUint16(peOff + 24, true);
  const dirBase = peOff + 24 + (magic === 0x20b ? 112 : 96);

  // Data directory index 4 is the Certificate Table: { RVA, size }.
  const rva = view.getUint32(dirBase + 4 * 8, true);
  const size = view.getUint32(dirBase + 4 * 8 + 4, true);
  return { rva, size, pe32Plus: magic === 0x20b };
}

let result;
try {
  result = certificateTableSize(readFileSync(file));
} catch (err) {
  console.error(`verify-signature: ${file}: ${err.message}`);
  process.exit(warnOnly ? 0 : 1);
}

if (result.size === 0) {
  const message =
    `verify-signature: ${file} is UNSIGNED — the PE Certificate Table is empty `
    + '(RVA 0, size 0). Windows will show a SmartScreen warning on first run.';
  if (warnOnly) {
    console.warn(`${message}\nverify-signature: continuing because --warn was given.`);
    process.exit(0);
  }
  console.error(message);
  process.exit(1);
}

console.log(
  `verify-signature: ${file} is signed — ${result.pe32Plus ? 'PE32+' : 'PE32'}, `
  + `certificate table ${result.size} bytes at RVA 0x${result.rva.toString(16)}.`
);
