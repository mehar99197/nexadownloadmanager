'use strict';

/**
 * Account sign-in for the desktop app — /api/device.
 *
 * The app never sees a licence key. It asks for a code, opens the website,
 * the person approves the code while signed in, and the app collects a
 * device token it then presents to /api/license/validate instead of a key.
 * The plan comes from the account (or the Team the account belongs to), so
 * upgrading, joining a team, or a trial reaches every signed-in machine on
 * its next validation with nothing to paste anywhere.
 *
 *   POST /api/device/code            app   → { deviceCode, userCode, verificationUrl… }
 *   POST /api/device/token           app   → { status: pending|approved|denied|expired|slow_down, deviceToken? }
 *   GET  /api/device/code/:userCode  site  → what is asking (name, version, when)
 *   POST /api/device/approve         site  → { approved: true }
 *   POST /api/device/deny            site  → { denied: true }
 *   POST /api/device/signout         app   → revoke this machine's token + free its seat
 *
 * The app-facing calls answer the standard envelope like everything else; the
 * flow states (pending, denied, expired) are `ok:true` data, not errors —
 * they are the answer, not a failure to answer.
 */

const router = require('express').Router();

const DeviceAuth = require('../models/DeviceAuth');
const Subscription = require('../models/Subscription');
const { subscriptionForUser } = require('../utils/accountPlan');
const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const { ok, fail } = require('../utils/respond');
const { requireAuth } = require('../middleware/auth');
const { deviceCodeLimiter, devicePollLimiter, deviceApproveLimiter } = require('../middleware/rateLimiter');
const {
  deviceCodeRequestSchema, devicePollSchema, deviceUserCodeParamsSchema,
  deviceDecisionSchema, deviceSignOutSchema,
} = require('../schemas/device.schema');
const security = require('../utils/securityEvents');
const { sendDeviceSignedInEmail } = require('../utils/email');
const config = require('../config/env');

const publicDevice = (row) => ({
  userCode: row.user_code,
  deviceName: row.device_name || 'Unnamed device',
  appVersion: row.app_version || null,
  requestedAt: row.created_at,
  expiresAt: row.expires_at,
});

router.post(
  '/code', deviceCodeLimiter, validate(deviceCodeRequestSchema),
  asyncHandler(async (req, res) => {
    const { device_fingerprint, device_name, app_version } = req.body;
    const code = await DeviceAuth.createCode({
      deviceFingerprint: device_fingerprint,
      deviceName: device_name || null,
      appVersion: app_version || null,
      ip: req.ip,
    });
    const verificationUrl = `${config.FRONTEND_URL}/activate`;
    return ok(res, {
      deviceCode: code.deviceCode,
      userCode: code.userCode,
      verificationUrl,
      verificationUrlComplete: `${verificationUrl}?code=${encodeURIComponent(code.userCode)}`,
      expiresIn: Math.floor(DeviceAuth.CODE_TTL_MS / 1000),
      interval: DeviceAuth.POLL_INTERVAL_SECONDS,
    });
  })
);

router.post(
  '/token', devicePollLimiter, validate(devicePollSchema),
  asyncHandler(async (req, res) => {
    const result = await DeviceAuth.consume(req.body.device_code, req.body.device_fingerprint);
    if (result.status !== 'approved')
      return ok(res, { status: result.status, interval: DeviceAuth.POLL_INTERVAL_SECONDS });
    await security.record('device.signed_in', {
      req, user: result.user, detail: `desktop app signed in on "${result.deviceName || 'a device'}"`,
    });
    return ok(res, {
      status: 'approved',
      deviceToken: result.deviceToken,
      account: { id: result.user.id, email: result.user.email, name: result.user.name },
    });
  })
);

router.get(
  '/code/:userCode', requireAuth, validate(deviceUserCodeParamsSchema),
  asyncHandler(async (req, res) => {
    const row = await DeviceAuth.findPendingByUserCode(req.params.userCode);
    if (!row) return fail(res, 'CODE_NOT_FOUND', 'That code is not waiting for approval — it may have expired. Start the sign-in again in the app.', 404);
    return ok(res, publicDevice(row));
  })
);

router.post(
  '/approve', requireAuth, deviceApproveLimiter, validate(deviceDecisionSchema),
  asyncHandler(async (req, res) => {
    // The same bar the licence key has: an unverified address gets no
    // entitlement until the inbox is proven.
    if (!req.user.email_verified)
      return fail(res, 'EMAIL_NOT_VERIFIED', 'Verify your email address before connecting a device', 403, { canResend: true });
    if (req.user.role !== 'user')
      return fail(res, 'FORBIDDEN', 'Control-panel accounts cannot be used in the app', 403);
    const row = await DeviceAuth.findPendingByUserCode(req.body.user_code);
    if (!row) return fail(res, 'CODE_NOT_FOUND', 'That code is not waiting for approval — it may have expired. Start the sign-in again in the app.', 404);
    const approved = await DeviceAuth.approve(row.id, req.user.id);
    if (!approved) return fail(res, 'CODE_NOT_FOUND', 'That code was just used or expired. Start the sign-in again in the app.', 404);
    await security.record('device.approved', {
      req, user: req.user, detail: `approved "${row.device_name || 'a device'}" (${row.app_version || 'unknown version'}) from ${row.ip || 'unknown address'}`,
    });
    // Like Google's "new sign-in" notice: the owner of the mailbox learns of
    // every machine added, which is how a stolen website session gets caught.
    sendDeviceSignedInEmail(req.user, { deviceName: row.device_name, ip: row.ip }).catch((err) =>
      // eslint-disable-next-line no-console
      console.error('[device] sign-in notice failed:', err.message));
    return ok(res, { approved: true, device: publicDevice(row) });
  })
);

router.post(
  '/deny', requireAuth, deviceApproveLimiter, validate(deviceDecisionSchema),
  asyncHandler(async (req, res) => {
    const row = await DeviceAuth.findPendingByUserCode(req.body.user_code);
    if (!row) return fail(res, 'CODE_NOT_FOUND', 'That code is not waiting for approval.', 404);
    await DeviceAuth.deny(row.id);
    await security.record('device.denied', {
      req, user: req.user, severity: 'warning',
      detail: `denied "${row.device_name || 'a device'}" from ${row.ip || 'unknown address'}`,
    });
    return ok(res, { denied: true });
  })
);

// The app signing itself out. Always 200: a machine that is already signed
// out (revoked from the dashboard, token replaced) gets the same answer, and
// the app forgets its token either way.
router.post(
  '/signout', devicePollLimiter, validate(deviceSignOutSchema),
  asyncHandler(async (req, res) => {
    const row = await DeviceAuth.findLiveToken(req.body.device_token);
    if (!row || row.device_fingerprint !== req.body.device_fingerprint)
      return ok(res, { signedOut: true, wasSignedIn: false });
    await DeviceAuth.revoke(row.id, 'signed_out');
    // Free the seat this machine holds on whichever subscription it used —
    // the account's own or, for a Team member, the team's.
    const sub = await subscriptionForUser(row.user_id);
    if (sub) await Subscription.releaseSeat(sub.id, row.device_fingerprint);
    await security.record('device.signed_out', {
      req, user: { id: row.user_id, email: row.user_email }, detail: `"${row.device_name || 'a device'}" signed out from the app`,
    });
    return ok(res, { signedOut: true, wasSignedIn: true });
  })
);

module.exports = router;
