'use strict';

const { verifyAccess } = require('../utils/jwt');
const { fail } = require('../utils/respond');
const config = require('../config/env');
const User = require('../models/User');
const { isControlPanelAccount } = require('../utils/reservedEmail');

function extractBearer(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

async function requireAuth(req, res, next) {
  try {
    const token = extractBearer(req);
    if (!token) return fail(res, 'UNAUTHORIZED', 'Authentication required', 401);
    const payload = verifyAccess(token);
    const user = await User.findById(Number(payload.sub));
    if (!user) return fail(res, 'UNAUTHORIZED', 'Account not found', 401);
    // A control-panel row is not a customer. Staff and the creator sign in at
    // their own endpoints, with their own token families, behind an IP
    // allowlist and a second factor; this token family has none of that, so an
    // admin or creator identity must never be reachable through it.
    //
    // Enforced HERE, and not only where the token is minted, because the token
    // outlives the decision that minted it: one issued before this rule
    // existed, or before the account was promoted to staff, keeps working for
    // the rest of its seven-day life. This is the boundary every route behind
    // requireAuth shares, so it also covers the ones nobody has written yet.
    //
    // Reported as an ended session, which is what it is, and never as "this is
    // a control-panel account". The customer site is what reads this answer and
    // renders it, and a message naming the account type is one screenshot away
    // from telling a room full of people which address runs the place. The
    // signed-out state it produces is the correct one either way.
    if (isControlPanelAccount(user))
      return fail(res, 'SESSION_REVOKED', 'This session has ended. Please sign in again.', 401);
    if (user.banned) return fail(res, 'FORBIDDEN', 'Account is banned', 403);
    // The session generation this token was minted with must still be current.
    // Access tokens live seven days, so without this a password change, a
    // password reset, a sign-out or an admin's "revoke sessions" left a stolen
    // bearer token working for the rest of the week — every one of those
    // actions only cleared the refresh cookie's hash.
    if ((Number(payload.tv) || 0) !== (Number(user.token_version) || 0))
      return fail(res, 'SESSION_REVOKED', 'This session has ended. Please sign in again.', 401);
    // An account that has not proved it owns its address gets no further than
    // this. It is the same rule as the login gate, applied to every request, so
    // a token minted before verification was switched on stops working too.
    if (!user.email_verified && config.EMAIL_VERIFICATION_REQUIRED)
      return fail(res, 'EMAIL_NOT_VERIFIED', 'Please verify your email address to continue', 403);
    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Identify the caller if they happen to be signed in, and carry on either way.
 *
 * For public endpoints that want to attribute a submission to an account
 * WITHOUT taking the sender's word for who they are. Anything a failed check
 * would have rejected — unknown user, ban, control-panel account, stale
 * session generation, unverified address — simply leaves req.user unset, so
 * the route sees an anonymous request rather than a half-trusted one.
 */
async function optionalAuth(req, res, next) {
  try {
    const token = extractBearer(req);
    if (!token) return next();
    const payload = verifyAccess(token);
    const user = await User.findById(Number(payload.sub));
    if (!user || user.banned || isControlPanelAccount(user)) return next();
    if ((Number(payload.tv) || 0) !== (Number(user.token_version) || 0)) return next();
    if (!user.email_verified && config.EMAIL_VERIFICATION_REQUIRED) return next();
    req.user = user;
    return next();
  } catch {
    // A bad or expired token on a public route is not an error, just anonymity.
    return next();
  }
}

module.exports = { requireAuth, optionalAuth };
