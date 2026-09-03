'use strict';

/**
 * Creator ("root") API — mounted at /api/root.
 *
 * Everything here is reserved for the single owner account and is unreachable
 * with a staff-admin token: the gate is requireRoot, which only accepts the
 * root token family (own secret) AND re-checks role + ROOT_ADMIN_EMAIL on every
 * request. Staff admins live at /api/admin and cannot manage accounts at all.
 */

const router = require('express').Router();
const bcrypt = require('bcryptjs');

const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const Release = require('../models/Release');
const config = require('../config/env');

const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const { requireRoot, rootIpWhitelist, isRootUser } = require('../middleware/adminAuth');
const { adminLoginLimiter, adminRefreshLimiter } = require('../middleware/rateLimiter');
const { ok, fail } = require('../utils/respond');
const { stripSensitive } = require('../utils/sanitize');
const { signRootToken, generateRefreshToken, hashRefreshToken } = require('../utils/jwt');
const { mountTwoFactor, signChallenge } = require('./twoFactor');
const {
  rootLoginSchema, createAdminSchema, updateAdminSchema,
  resetAdminPasswordSchema, idParamSchema, auditQuerySchema, deleteUserSchema,
} = require('../schemas/root.schema');

// Scoped to /api/root so the browser never sends the creator's session cookie
// to a staff endpoint — and a stolen staff cookie is useless here.
const ROOT_REFRESH_COOKIE = 'ndm_root_refresh';
const ROOT_REFRESH_PATH = '/api/root';
const BCRYPT_COST = 12;

function rootRefreshCookieOptions() {
  return {
    httpOnly: true, sameSite: 'lax', secure: config.secureCookies,
    maxAge: 4 * 60 * 60 * 1000, path: ROOT_REFRESH_PATH,
  };
}

async function issueRootSession(res, user) {
  const { token: refreshToken, hash } = generateRefreshToken();
  await User.update(user.id, { rootRefreshTokenHash: hash });
  res.cookie(ROOT_REFRESH_COOKIE, refreshToken, rootRefreshCookieOptions());
}

function rootIdentity(user) {
  return { id: String(user.id), name: user.name, email: user.email, role: user.role };
}

// Shared with the staff panel — see utils/sanitize.js for why this is not a
// per-file destructure any more.
const safeUser = stripSensitive;

async function audit(req, action, entityType, entityId, summary, metadata) {
  await AuditLog.create({
    adminUserId: req.admin && req.admin.id,
    action, entityType, entityId, summary, metadata,
  });
}

/* ---------------------------------------------------------------- session */

router.post(
  '/login', adminLoginLimiter, rootIpWhitelist, validate(rootLoginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findByEmail(email);
    // isRootUser (not `role === 'root'`) so a row whose email no longer matches
    // ROOT_ADMIN_EMAIL cannot sign in here.
    // A password-less (Google-created) row cannot sign in here: bcrypt.compare
    // against null throws, which would answer 500 rather than rejecting.
    if (!isRootUser(user) || !user.password_hash)
      return fail(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return fail(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);
    if (user.banned) return fail(res, 'FORBIDDEN', 'Account is banned', 403);
    // Second factor on: no session until POST /login/2fa verifies a code.
    if (user.totp_enabled) {
      return ok(res, {
        requiresTwoFactor: true,
        challenge: signChallenge(user, { secret: config.JWT_ROOT_SECRET, realm: 'root' }),
      });
    }
    return ok(res, await finishRootLogin(res, user));
  })
);

async function finishRootLogin(res, user) {
  await issueRootSession(res, user);
  await audit({ admin: user }, 'root.login', 'user', user.id, `Root sign-in ${user.email}`);
  return { token: signRootToken(user), admin: rootIdentity(user) };
}

mountTwoFactor(router, {
  realm: 'root',
  secret: config.JWT_ROOT_SECRET,
  eligible: isRootUser,
  finishLogin: finishRootLogin,
  gate: requireRoot,
  audit: (req, action, user, summary) => audit({ admin: req.admin || user }, action, 'user', user.id, summary),
});

router.post(
  '/refresh', adminRefreshLimiter, rootIpWhitelist,
  asyncHandler(async (req, res) => {
    const cookie = req.cookies && req.cookies[ROOT_REFRESH_COOKIE];
    if (!cookie) return fail(res, 'NO_REFRESH_TOKEN', 'Missing root refresh token', 401);
    const user = await User.findByRootRefreshTokenHash(hashRefreshToken(cookie));
    if (!isRootUser(user)) {
      res.clearCookie(ROOT_REFRESH_COOKIE, { path: ROOT_REFRESH_PATH });
      return fail(res, 'INVALID_REFRESH_TOKEN', 'Root session is invalid or has expired', 401);
    }
    if (user.banned) {
      await User.update(user.id, { rootRefreshTokenHash: null });
      res.clearCookie(ROOT_REFRESH_COOKIE, { path: ROOT_REFRESH_PATH });
      return fail(res, 'FORBIDDEN', 'Account is banned', 403);
    }
    await issueRootSession(res, user);
    return ok(res, { token: signRootToken(user) });
  })
);

router.post(
  '/logout', rootIpWhitelist,
  asyncHandler(async (req, res) => {
    const cookie = req.cookies && req.cookies[ROOT_REFRESH_COOKIE];
    if (cookie) {
      const user = await User.findByRootRefreshTokenHash(hashRefreshToken(cookie));
      if (user) await User.update(user.id, { rootRefreshTokenHash: null });
    }
    res.clearCookie(ROOT_REFRESH_COOKIE, { path: ROOT_REFRESH_PATH });
    return ok(res, { loggedOut: true });
  })
);

/* ------------------------------------------------- creator-only from here */

router.use(requireRoot);

router.get('/me', asyncHandler(async (req, res) => ok(res, {
  ...rootIdentity(req.admin), twoFactorEnabled: Boolean(req.admin.totp_enabled),
})));

router.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const [totalUsers, admins, roots, banned, downloads] = await Promise.all([
      User.count(),
      User.count({ role: 'admin' }),
      User.count({ role: 'root' }),
      User.count({ banned: true }),
      Release.sumDownloadCount(),
    ]);
    return ok(res, {
      totalUsers, admins, roots, banned, downloads,
      rootEmailPinned: Boolean(config.ROOT_ADMIN_EMAIL),
    });
  })
);

/* ------------------------------------------------------- admin management */

router.get(
  '/admins',
  asyncHandler(async (req, res) => ok(res, { admins: (await User.listStaff()).map(safeUser) }))
);

router.post(
  '/admins', validate(createAdminSchema),
  asyncHandler(async (req, res) => {
    const { name, email, password } = req.body;
    if (await User.findByEmail(email))
      return fail(res, 'EMAIL_EXISTS', 'An account with this email already exists', 409);
    const user = await User.create({
      name, email, passwordHash: await bcrypt.hash(password, BCRYPT_COST),
      role: 'admin', emailVerified: true,
    });
    await audit(req, 'admin.created', 'user', user.id, `Created staff admin ${email}`);
    return ok(res, { admin: safeUser(user) }, 201);
  })
);

// Guard shared by every mutating admin route: the target must exist, must not
// be a creator account, and must not be the caller themselves.
async function loadStaffTarget(req, res) {
  const user = await User.findById(Number(req.params.id));
  if (!user) {
    fail(res, 'NOT_FOUND', 'Account not found', 404);
    return null;
  }
  if (user.id === req.admin.id) {
    fail(res, 'SELF_LOCKOUT', 'You cannot modify your own creator account here', 400);
    return null;
  }
  if (user.role === 'root') {
    fail(res, 'FORBIDDEN', 'A creator account cannot be modified over the API', 403);
    return null;
  }
  return user;
}

router.put(
  '/admins/:id', validate(updateAdminSchema),
  asyncHandler(async (req, res) => {
    const user = await loadStaffTarget(req, res);
    if (!user) return undefined;

    const { name, banned, role } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (banned !== undefined) updates.banned = banned;
    if (role !== undefined) updates.role = role;
    await User.update(user.id, updates);
    // Banning or demoting must also kill the live session. verifyAdminToken
    // re-reads the role on every request, so a demoted admin's panel token dies
    // on its own; revokeSessions is what also ends their ordinary user tokens.
    if (banned === true || role === 'user') await User.revokeSessions(user.id);

    const fresh = await User.findById(user.id);
    await audit(req, 'admin.updated', 'user', user.id, `Updated staff admin ${fresh.email}`, req.body);
    return ok(res, { admin: safeUser(fresh) });
  })
);

router.post(
  '/admins/:id/reset-password', validate(resetAdminPasswordSchema),
  asyncHandler(async (req, res) => {
    const user = await loadStaffTarget(req, res);
    if (!user) return undefined;
    await User.update(user.id, { passwordHash: await bcrypt.hash(req.body.password, BCRYPT_COST) });
    await User.revokeSessions(user.id);
    await audit(req, 'admin.password_reset', 'user', user.id, `Reset password for ${user.email}`);
    return ok(res, { reset: true });
  })
);

router.post(
  '/admins/:id/revoke-sessions', validate(idParamSchema),
  asyncHandler(async (req, res) => {
    const user = await loadStaffTarget(req, res);
    if (!user) return undefined;
    await User.revokeSessions(user.id);
    await audit(req, 'admin.sessions_revoked', 'user', user.id, `Revoked sessions for ${user.email}`);
    return ok(res, { revoked: true });
  })
);

// A staff admin who lost their authenticator: the creator clears their second
// factor so they can sign in with the password and re-enrol. Sessions are
// revoked at the same time, so a hijacked session cannot ride this through.
router.post(
  '/admins/:id/reset-2fa', validate(idParamSchema),
  asyncHandler(async (req, res) => {
    const user = await loadStaffTarget(req, res);
    if (!user) return undefined;
    await User.update(user.id, { totpEnabled: 0, totpSecret: null, totpRecovery: null });
    await User.revokeSessions(user.id);
    await audit(req, 'admin.2fa_reset', 'user', user.id, `Reset two-factor authentication for ${user.email}`);
    return ok(res, { reset: true });
  })
);

// Demote to a plain user — keeps the account and its billing history.
router.delete(
  '/admins/:id', validate(idParamSchema),
  asyncHandler(async (req, res) => {
    const user = await loadStaffTarget(req, res);
    if (!user) return undefined;
    await User.update(user.id, {
      role: 'user', adminRefreshTokenHash: null, refreshTokenHash: null,
    });
    await audit(req, 'admin.demoted', 'user', user.id, `Demoted ${user.email} to user`);
    return ok(res, { demoted: true });
  })
);

/* -------------------------------------------------------------- audit log */

router.get(
  '/audit', validate(auditQuerySchema),
  asyncHandler(async (req, res) => ok(res, await AuditLog.listRecent(req.query.limit)))
);

/* ------------------------------------------------------------ danger zone */

router.delete(
  '/users/:id', validate(deleteUserSchema),
  asyncHandler(async (req, res) => {
    const user = await User.findById(Number(req.params.id));
    if (!user) return fail(res, 'NOT_FOUND', 'Account not found', 404);
    if (user.id === req.admin.id)
      return fail(res, 'SELF_LOCKOUT', 'You cannot delete your own creator account', 400);
    if (user.role === 'root')
      return fail(res, 'FORBIDDEN', 'A creator account cannot be deleted over the API', 403);
    if (String(user.email).toLowerCase() !== req.body.confirmEmail)
      return fail(res, 'CONFIRM_MISMATCH', 'The confirmation email does not match this account', 400);

    // Write the audit row BEFORE the delete: audit_logs.admin_user_id is
    // ON DELETE SET NULL, and the row must survive the cascade that follows.
    await audit(req, 'user.deleted', 'user', user.id,
      `Deleted account ${user.email} and all of its data`, { email: user.email, role: user.role });
    await User.remove(user.id);
    return ok(res, { deleted: true });
  })
);

module.exports = router;
