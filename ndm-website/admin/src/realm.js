/**
 * Which control panel is this?
 *
 * One bundle is served at two mount points — /admin for staff and /root for the
 * creator — and the URL decides everything downstream: the router basename, the
 * API namespace (/api/admin vs /api/root), which session cookie the backend
 * sets, and which routes exist at all. Nothing here is a security boundary; the
 * server gates every request independently. This only decides what to render
 * and which endpoints to talk to.
 */

const path = typeof window === 'undefined' ? '/admin' : window.location.pathname;

// Exact segment match, so a stray path like /rootkit is not treated as the
// creator panel.
export const IS_ROOT = path === '/root' || path.startsWith('/root/');

export const REALM = IS_ROOT ? 'root' : 'admin';
export const BASENAME = IS_ROOT ? '/root' : '/admin';

/** API namespace for this realm's session endpoints: login / refresh / logout / me. */
export const AUTH_NS = IS_ROOT ? '/root' : '/admin';

export const PANEL_LABEL = IS_ROOT ? 'Root' : 'Admin';
export const PANEL_SUBTITLE = IS_ROOT ? 'Creator console' : 'Control panel';
export const PANEL_HEADING = IS_ROOT ? 'Owner administration' : 'Administration';
