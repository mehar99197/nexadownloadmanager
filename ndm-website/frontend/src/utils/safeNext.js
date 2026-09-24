/**
 * Where to send someone after signing in, from a `?next=` value: a path on
 * this site, or the fallback.
 *
 * The value is resolved the way the browser resolves it, not judged by its
 * first characters. "/\evil.example" and "/<tab>/evil.example" start with a
 * single slash, but the URL parser reads the backslash as a slash and drops
 * the tab, so both point at another site.
 */
export default function safeNext(raw, fallback = '/dashboard') {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return fallback;
  let url;
  try {
    url = new URL(raw, window.location.origin);
  } catch {
    return fallback;
  }
  if (url.origin !== window.location.origin) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}
