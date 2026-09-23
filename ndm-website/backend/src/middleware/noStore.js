'use strict';

/**
 * Every API response is uncacheable unless it says otherwise.
 *
 * The API had exactly one `Cache-Control` in it — the release feed, which opts
 * in to `public, max-age=300` on purpose. Everything else went out with no
 * cache directive at all: `/user/me`, `/subscription/status`, the licence key,
 * the team roster, every admin screen. Helmet has not set `Cache-Control`
 * since v4, so nothing was filling that in.
 *
 * A response with no freshness information is not "do not cache" — RFC 9111
 * lets a shared cache store it and serve it again on its own heuristics. The
 * CDN in front of this deployment demonstrably caches (`Age` comes back on the
 * feed), and it happens not to touch the uncontrolled responses today. That is
 * a property of one vendor's configuration on one afternoon, not something
 * this codebase arranged, and it is the wrong thing to rely on for a body that
 * contains somebody's email address and licence key.
 *
 * So the default inverts: no-store for anything under /api, and a route that
 * genuinely is public overrides it with its own `res.set('Cache-Control', …)`,
 * which replaces this one. The opt-in stays a deliberate, visible line in the
 * route that wants it.
 *
 * `no-store` rather than `no-cache`: no-cache still permits a stored copy that
 * is revalidated, and a stored copy of a licence key on a shared proxy is the
 * thing being avoided. `private` is added for intermediaries that honour it
 * but ignore no-store.
 */

const VALUE = 'no-store, private';

function noStore(req, res, next) {
  res.set('Cache-Control', VALUE);
  next();
}

module.exports = { noStore, NO_STORE_VALUE: VALUE };
