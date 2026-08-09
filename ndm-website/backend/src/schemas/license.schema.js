'use strict';

const { z } = require('zod');

// license_key format: NDM-XXXX-XXXX-XXXX (uppercase A-Z0-9)
// device_fingerprint: SHA-256-ish hex string, 16..64 chars.
const validateLicenseSchema = {
  body: z
    .object({
      license_key: z.string().regex(/^NDM(-[A-Z0-9]{4}){3}$/, 'Invalid license key format'),
      device_fingerprint: z
        .string()
        .regex(/^[a-f0-9]{16,64}$/i, 'Invalid device fingerprint'),
    })
    .strict(),
};

module.exports = { validateLicenseSchema };
