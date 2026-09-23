/**
 * List the artwork the feature pages are still waiting for.
 *
 * <Figure> placeholders render only in development (FeatureShell.jsx), so the
 * live site no longer shows "SCREENSHOT NEEDED" boxes. This keeps them from
 * going quiet instead: every production build prints what is outstanding,
 * with the file and line to replace. It reports; it never fails the build.
 *
 * Run automatically by `npm run build`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pages = join(root, 'src', 'pages');

function* jsxFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* jsxFiles(path);
    else if (name.endsWith('.jsx')) yield path;
  }
}

const FIGURE = /<Figure kind="([^"]+)">([\s\S]*?)<\/Figure>/g;

// The descriptions are JSX text, so they carry the entities JSX needs.
const ENTITIES = { ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', apos: "'", quot: '"', amp: '&', hellip: '…', rarr: '→', nbsp: ' ', times: '×' };
const decode = (text) => text.replace(/&(\w+);/g, (m, name) => ENTITIES[name] ?? m);

const found = [];
for (const file of jsxFiles(pages)) {
  const source = readFileSync(file, 'utf8');
  for (const m of source.matchAll(FIGURE)) {
    const line = source.slice(0, m.index).split('\n').length;
    const what = decode(m[2].replace(/\s+/g, ' ').trim());
    found.push(`  ${relative(root, file).replace(/\\/g, '/')}:${line}  ${m[1]}: ${what}`);
  }
}

if (found.length) {
  console.log(`report-placeholders: ${found.length} figure(s) still to be made (hidden in production):`);
  for (const f of found) console.log(f);
} else {
  console.log('report-placeholders: no placeholders left.');
}
