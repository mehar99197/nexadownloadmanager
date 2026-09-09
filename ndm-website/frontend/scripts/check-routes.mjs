/**
 * Every route in the router must be reachable in production.
 *
 * The site is served by Apache from deploy/hostinger/public_html.htaccess, and
 * since unknown paths there answer a real 404 rather than the SPA shell, a
 * route only works if it is one of two things:
 *
 *   - prerendered  — scripts/prerender.mjs wrote it its own dist/<route>/index.html
 *   - client-only  — named in the htaccess rule that hands those paths the shell
 *
 * A route that is neither used to be covered by a catch-all that answered 200
 * for literally any path. That catch-all is gone, so this check is what stops a
 * new route from silently 404ing in production while working perfectly in dev.
 *
 * Runs as part of `npm run build`. Failing here is much cheaper than finding out
 * from a customer that /some-new-page is a 404.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, p), 'utf8');

const routerRoutes = [...read('../src/App.jsx').matchAll(/path="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((p) => p !== '*');                       // the NotFound catch-all

const prerendered = [...read('./prerender.mjs').matchAll(/^\s*\['(\/[^']*)'/gm)]
  .map((m) => m[1]);

const htaccess = read('../../deploy/hostinger/public_html.htaccess');
const clientOnlyRule = htaccess.match(/RewriteRule \^\(([^)]+)\)\/\?\$ index\.html \[L\]/);
if (!clientOnlyRule) {
  console.error('check-routes: could not find the client-only RewriteRule in public_html.htaccess.');
  console.error('If that rule was renamed or removed, update this script — do not delete the check.');
  process.exit(1);
}
const clientOnly = clientOnlyRule[1].split('|').map((r) => '/' + r);

const covered = new Set([...prerendered, ...clientOnly]);
const orphans = routerRoutes.filter((r) => !covered.has(r));
const stale = clientOnly.filter((r) => !routerRoutes.includes(r));

let bad = false;
if (orphans.length) {
  bad = true;
  console.error('\ncheck-routes: these routes would 404 in production.');
  console.error('Either add the route to ROUTES in scripts/prerender.mjs (public, indexable),');
  console.error('or add it to the client-only RewriteRule in deploy/hostinger/public_html.htaccess:');
  for (const r of orphans) console.error(`  ${r}`);
}
if (stale.length) {
  bad = true;
  console.error('\ncheck-routes: the htaccess client-only rule names routes the router no longer has.');
  console.error('Drop them so the rule keeps saying something true:');
  for (const r of stale) console.error(`  ${r}`);
}
if (bad) process.exit(1);

console.log(
  `check-routes: ${routerRoutes.length} routes, all reachable ` +
  `(${prerendered.length} prerendered, ${clientOnly.length} client-only).`
);
