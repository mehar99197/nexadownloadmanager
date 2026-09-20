'use strict';

const { verifyAccess } = require('../utils/jwt');
const { fail } = require('../utils/respond');
const User = require('../models/User');
const UserSession = require('../models/UserSession');

function extractBearer(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

/**
 * Site bearer gate.
 *
 * A valid signature is necessary, not sufficient: the token's `sid` must
 * still name a live session row for this account (UserSession.findLiveForToken).
 * That row is what every revocation deletes — sign-out, a password change or
 * reset, a ban, an admin's "revoke sessions" — so deleting it ends access on
 * the spot instead of whenever the JWT happens to expire. Before this check
 * existed, "revoke sessions" only stopped the holder minting a NEW token at
 * /auth/refresh; the one already in their hand kept working for its full
 * seven-day life (AUDIT.md H-08).
 *
 * The order matters. The account is checked first so a banned owner is told
 * so (403) rather than handed a generic "session ended" — the ban is the
 * fact that explains everything else. A token minted before sessions were
 * bound carries no `sid` and is refused like any other dead session; the SPA
 * answers a 401 with one /auth/refresh, which mints a bound one.
 *
 * SESSION_REVOKED is one answer for every way the row can be missing —
 * signed out, revoked, expired, wrong realm, never existed — because the
 * client's next move is the same for all of them: refresh, and if that fails
 * too, sign in again.
 */
async function requireAuth(req, res, next) {
  try {
    const token = extractBearer(req);
    if (!token) return fail(res, 'UNAUTHORIZED', 'Authentication required', 401);
    const payload = verifyAccess(token);
    const user = await User.findById(Number(payload.sub));
    if (!user) return fail(res, 'UNAUTHORIZED', 'Account not found', 401);
    if (user.banned) return fail(res, 'FORBIDDEN', 'Account is banned', 403);
    const session = await UserSession.findLiveForToken({
      id: payload.sid, userId: user.id, realm: 'site',
    });
    if (!session) return fail(res, 'SESSION_REVOKED', 'This session has ended. Please sign in again.', 401);
    req.user = user;
    req.session = session;
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireAuth };
