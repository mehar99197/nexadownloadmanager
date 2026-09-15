'use strict';

const { z } = require('zod');

// A 6-digit authenticator code, or a recovery code ("k7f3q-9x2mp").
const totpCode = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app');
const anyCode = z.string().trim().min(6).max(16);

const twoFactorLoginSchema = {
  body: z.object({
    challenge: z.string().min(20).max(2048),
    code: anyCode,
  }).strict(),
};

const twoFactorEnableSchema = {
  body: z.object({ code: totpCode }).strict(),
};

const twoFactorDisableSchema = {
  body: z.object({
    // Optional in the schema only: the route insists on it for every account
    // that has a password (a Google-created customer has none).
    password: z.string().min(1).max(128).optional(),
    code: anyCode,
  }).strict(),
};

module.exports = { twoFactorLoginSchema, twoFactorEnableSchema, twoFactorDisableSchema, totpCode };
