'use strict';

const { z } = require('zod');

// license_key format: NDM-XXXX-XXXX-XXXX (uppercase A-Z0-9)
// device_fingerprint: SHA-256-ish hex string, 16..64 chars. The desktop app
// derives it from the primary MAC address plus the machine id, then hashes it —
// the raw MAC never leaves the machine, so this stays a stable opaque id.
const licenseKey = z.string().regex(/^NDM(-[A-Z0-9]{4}){3}$/, 'Invalid license key format');
const deviceFingerprint = z.string().regex(/^[a-f0-9]{16,64}$/i, 'Invalid device fingerprint');
// A signed-in machine's credential (routes/device.js) — the account, not a
// key, is what the plan is resolved from.
const deviceToken = z.string().regex(/^ndt_[A-Za-z0-9_-]{43}$/, 'Invalid device token');

// Free-text, shown to the user in their device list. Never trusted for auth.
const deviceName = z.string().trim().min(1).max(120).optional();
const appVersion = z.string().trim().min(1).max(40).optional();

// Exactly one credential: a licence key (manual activation, older builds) or
// a device token (account sign-in). Both together is a confused client.
const oneCredential = (data) => Boolean(data.license_key) !== Boolean(data.device_token);
const CREDENTIAL_MESSAGE = 'Send either license_key or device_token';

const validateLicenseSchema = {
  body: z
    .object({
      license_key: licenseKey.optional(),
      device_token: deviceToken.optional(),
      device_fingerprint: deviceFingerprint,
      device_name: deviceName,
      app_version: appVersion,
    })
    .strict()
    .refine(oneCredential, { message: CREDENTIAL_MESSAGE }),
};

// Sent every few minutes to keep this device's seat lease alive.
const heartbeatSchema = {
  body: z
    .object({
      license_key: licenseKey.optional(),
      device_token: deviceToken.optional(),
      device_fingerprint: deviceFingerprint,
      device_name: deviceName,
    })
    .strict()
    .refine(oneCredential, { message: CREDENTIAL_MESSAGE }),
};

// Sent on a clean shutdown so the seat frees immediately instead of waiting out
// the lease. Best-effort: the lease expiry is what actually guarantees release.
const releaseSeatSchema = {
  body: z
    .object({
      license_key: licenseKey.optional(),
      device_token: deviceToken.optional(),
      device_fingerprint: deviceFingerprint,
    })
    .strict()
    .refine(oneCredential, { message: CREDENTIAL_MESSAGE }),
};

module.exports = { validateLicenseSchema, heartbeatSchema, releaseSeatSchema };
