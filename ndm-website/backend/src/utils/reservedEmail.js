'use strict';

const config = require('../config/env');

/**
 * Which addresses and accounts the PUBLIC auth surface may not touch.
 *
 * The creator's address identifies one thing: the creator. It must never also
 * become an ordinary customer account, and the public sign-up flow must never
 * be able to write credentials onto a control-panel row.
 *
 * Two separate rules, because they close two different gaps:
 *
 *  - `isReservedEmail` is address-based and works even when NO row exists. The
 *    users table's unique index already stops a second account on an address
 *    that is taken, so registration on the creator's address fails today simply
 *    because the creator's row is there. Delete that row — an accident, a
 *    restore from an older dump, a migration — and the address becomes
 *    claimable by whoever registers first. They would only get `role:'user'`
 *    (requireRoot demands role='root' AND a match on ROOT_ADMIN_EMAIL, so this
 *    is not by itself an escalation), but the creator would then be unable to
 *    re-create their own account, and support would be arguing with somebody
 *    holding the owner's address.
 *
 *  - `isControlPanelAccount` is row-based. A staff or creator row already
 *    exists, and the question is whether /api/auth may modify it. It may not:
 *    "Continue with Google" would attach a second credential to it, and the
 *    password-reset flow would rewrite the very hash /admin/login and
 *    /root/login check — turning read access to one mailbox into the panel
 *    password. The panels have their own sign-in; the customer site is not a
 *    recovery channel for them.
 *
 * Creator password recovery is `npm run create-root` on the server, which
 * updates the existing row (scripts/createRoot.js). That is deliberately
 * something you must already be on the box to do.
 */

/**
 * One wording for every public endpoint that turns a control-panel identity
 * away, so the customer site never explains this two different ways — and so
 * the sign-in form, the Google button and a stale session all say the same
 * thing to the same person.
 */
const CONTROL_PANEL_MESSAGE =
  'This address belongs to a control-panel account. Sign in at the admin console instead.';

function isReservedEmail(email) {
  if (!config.ROOT_ADMIN_EMAIL) return false;
  return String(email || '').trim().toLowerCase() === String(config.ROOT_ADMIN_EMAIL).toLowerCase();
}

function isControlPanelAccount(user) {
  return Boolean(user) && (user.role === 'admin' || user.role === 'root');
}

/** Either rule — the usual question at a public auth endpoint. */
function isProtectedIdentity(email, user) {
  return isReservedEmail(email) || isControlPanelAccount(user);
}

module.exports = {
  isReservedEmail, isControlPanelAccount, isProtectedIdentity, CONTROL_PANEL_MESSAGE,
};
