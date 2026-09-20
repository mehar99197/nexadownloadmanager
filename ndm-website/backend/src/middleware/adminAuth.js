'use strict';

const { verifyAdmin, verifyRoot } = require('../utils/jwt');
const { fail } = require('../utils/respond');
const config = require('../config/env');
const User = require('../models/User');
const UserSession = require('../models/UserSession');

function ipAllowed(list, req) {
  if (!list || list.length === 0) return true;
  const ip = req.ip;
  const normalized = ip && ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return list.includes(ip) || list.includes(normalized);
}

function ipWhitelist(req, res, next) {
  if (ipAllowed(config.ADMIN_ALLOWED_IPS, req)) return next();
  return fail(res, 'IP_FORBIDDEN', 'Access from this IP is not allowed', 403);
}

// The creator panel must never be *less* restricted than the staff panel, so an
// empty ROOT_ALLOWED_IPS falls back to the admin list rather than to "allow all".
function rootIpWhitelist(req, res, next) {
  const list = config.ROOT_ALLOWED_IPS.length ? config.ROOT_ALLOWED_IPS : config.ADMIN_ALLOWED_IPS;
  if (ipAllowed(list, req)) return next();
  return fail(res, 'IP_FORBIDDEN', 'Access from this IP is not allowed', 403);
}

function extractBearer(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

/**
 * Is this account the creator?
 *
 * Two independent facts must agree: the stored role AND the configured email.
 * Requiring both means a rogue `UPDATE users SET role='root'` is not by itself
 * enough — the attacker would also have to change the deployed environment.
 * When ROOT_ADMIN_EMAIL is unset the role alone decides; production config
 * refuses to boot without it (see config/env.js), so that path is dev-only.
 */
function isRootUser(user) {
  if (!user || user.role !== 'root') return false;
  if (!config.ROOT_ADMIN_EMAIL) return true;
  return String(user.email).toLowerCase() === config.ROOT_ADMIN_EMAIL;
}

/**
 * The live session row a panel token names, or a 401 already sent.
 *
 * Same rule as the site gate (middleware/auth.js): the signature proves we
 * minted the token, the row proves nobody has since taken it back. The realm
 * is the token's family, so a staff session's id inside a root-signed token
 * finds nothing — and the creator revoking a staff admin's sessions ends that
 * admin's panel access with the request in flight, not at the end of an
 * eight-hour token.
 */
async function liveSessionOr401(res, payload, user, realm) {
  const session = await UserSession.findLiveForToken({ id: payload.sid, userId: user.id, realm });
  if (!session) {
    fail(res, 'SESSION_REVOKED', 'This session has ended. Please sign in again.', 401);
    return null;
  }
  return session;
}

/**
 * Staff-admin gate for /api/admin/*.
 *
 * Accepts either token family: a staff token (role 'admin') or a root token, so
 * the creator gets every staff screen without a second login. It does NOT grant
 * root powers — those live behind requireRoot on /api/root/*.
 */
async function verifyAdminToken(req, res, next) {
  try {
    const token = extractBearer(req);
    if (!token) return fail(res, 'UNAUTHORIZED', 'Admin authentication required', 401);

    let payload;
    let family;
    try {
      payload = verifyAdmin(token);
      family = 'admin';
    } catch (adminErr) {
      // Surface the staff-token error when neither family verifies — that is
      // overwhelmingly the common case and the more useful message.
      try {
        payload = verifyRoot(token);
        family = 'root';
      } catch {
        throw adminErr;
      }
    }

    const user = await User.findById(Number(payload.sub));
    if (!user) return fail(res, 'FORBIDDEN', 'Admin access required', 403);
    if (user.banned) return fail(res, 'FORBIDDEN', 'Account is banned', 403);

    // Re-check the CURRENT stored role, never the role baked into the token: a
    // demoted admin's unexpired token must stop working immediately.
    if (family === 'root') {
      if (!isRootUser(user)) return fail(res, 'FORBIDDEN', 'Root access required', 403);
    } else if (user.role !== 'admin') {
      return fail(res, 'FORBIDDEN', 'Admin access required', 403);
    }

    const session = await liveSessionOr401(res, payload, user, family);
    if (!session) return undefined;

    req.admin = user;
    req.session = session;
    req.isRoot = family === 'root';
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Creator-only gate for /api/root/*. Staff-admin tokens can never pass this. */
async function verifyRootToken(req, res, next) {
  try {
    const token = extractBearer(req);
    if (!token) return fail(res, 'UNAUTHORIZED', 'Root authentication required', 401);
    const payload = verifyRoot(token);
    const user = await User.findById(Number(payload.sub));
    if (!user || !isRootUser(user)) return fail(res, 'FORBIDDEN', 'Root access required', 403);
    if (user.banned) return fail(res, 'FORBIDDEN', 'Account is banned', 403);
    const session = await liveSessionOr401(res, payload, user, 'root');
    if (!session) return undefined;
    req.admin = user;
    req.root = user;
    req.session = session;
    req.isRoot = true;
    return next();
  } catch (err) {
    return next(err);
  }
}

const requireAdmin = [ipWhitelist, verifyAdminToken];
const requireRoot = [rootIpWhitelist, verifyRootToken];

module.exports = {
  ipWhitelist, rootIpWhitelist,
  requireAdmin, requireRoot,
  verifyAdminToken, verifyRootToken,
  isRootUser,
};
