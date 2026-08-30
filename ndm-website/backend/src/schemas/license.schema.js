'use strict';

const { z } = require('zod');

// license_key format: NDM-XXXX-XXXX-XXXX (uppercase A-Z0-9)
// device_fingerprint: SHA-256-ish hex string, 16..64 chars. The desktop app
// derives it from the primary MAC address plus the machine id, then hashes it —
// the raw MAC never leaves the machine, so this stays a stable opaque id.
const licenseKey = z.string().regex(/^NDM(-[A-Z0-9]{4}){3}$/, 'Invalid license key format');
const deviceFingerprint = z.string().regex(/^[a-f0-9]{16,64}$/i, 'Invalid device fingerprint');

// Free-text, shown to the user in their device list. Never trusted for auth.
const deviceName = z.string().trim().min(1).max(120).optional();

const validateLicenseSchema = {
  body: z
    .object({
      license_key: licenseKey,
      device_fingerprint: deviceFingerprint,
      device_name: deviceName,
    })
    .strict(),
};

// Sent every few minutes to keep this device's seat lease alive.
const heartbeatSchema = {
  body: z
    .object({
      license_key: licenseKey,
      device_fingerprint: deviceFingerprint,
      device_name: deviceName,
    })
    .strict(),
};

// Sent on a clean shutdown so the seat frees immediately instead of waiting out
// the lease. Best-effort: the lease expiry is what actually guarantees release.
const releaseSeatSchema = {
  body: z
    .object({
      license_key: licenseKey,
      device_fingerprint: deviceFingerprint,
    })
    .strict(),
};

module.exports = { validateLicenseSchema, heartbeatSchema, releaseSeatSchema };
