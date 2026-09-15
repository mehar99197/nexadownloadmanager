// Print the CSP hash source ('sha256-…') of every inline <script> in an HTML
// file, one per line. application/ld+json blocks are skipped: they are data,
// never executed, and the CSP does not apply to them.
//
//   node scripts/inline-script-hashes.mjs dist/index.html
//
// deploy/build-and-upload.sh runs this against the built shell and refuses to
// deploy unless deploy/hostinger/public_html.htaccess allows every hash it
// prints — the only inline script today is the boot screen + theme stamp in
// index.html, and a CSP that silently drops it costs the boot screen and a
// flash of the wrong theme on every load while curl still sees a 200.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const file = process.argv[2];
if (!file) {
  console.error('usage: inline-script-hashes.mjs <file.html>');
  process.exit(2);
}
const html = readFileSync(file, 'utf8');
const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
const hashes = [];
let m;
while ((m = re.exec(html))) {
  if (/ld\+json/.test(m[1])) continue;
  hashes.push(`sha256-${createHash('sha256').update(m[2]).digest('base64')}`);
}
console.log(hashes.join('\n'));
