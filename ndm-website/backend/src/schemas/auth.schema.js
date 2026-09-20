'use strict';

const { z } = require('zod');

const email = z.string().trim().toLowerCase().email();
const strongPassword = z.string().min(8, 'Password must be at least 8 characters');

const registerSchema = {
  body: z
    .object({
      name: z.string().trim().min(1).max(100),
      email,
      password: strongPassword,
    })
    .strict(),
};

const loginSchema = {
  body: z
    .object({
      email,
      password: z.string().min(1),
    })
    .strict(),
};

const verifyEmailSchema = {
  body: z
    .object({
      token: z.string().min(1),
    })
    .strict(),
};

const forgotPasswordSchema = {
  body: z
    .object({
      email,
    })
    .strict(),
};

const resetPasswordSchema = {
  body: z
    .object({
      token: z.string().min(1),
      password: strongPassword,
    })
    .strict(),
};

// A signed-in user replacing their own password. `currentPassword` is required
// whenever the account HAS one — enforced in routes/auth.js, not here, because
// the schema cannot see the account: a Google-created account has no password
// yet and sets its first with the session alone.
const changePasswordSchema = {
  body: z
    .object({
      currentPassword: z.string().min(1).optional(),
      newPassword: strongPassword,
    })
    .strict(),
};

// "Continue with Google": the ID token minted by Google Identity Services in the
// browser. Length is bounded so a bogus multi-megabyte body is rejected before
// any crypto work; a real Google ID token is well under 4 KB.
const googleSchema = {
  body: z
    .object({
      credential: z.string().trim().min(20).max(4096),
    })
    .strict(),
};

module.exports = {
  registerSchema,
  loginSchema,
  verifyEmailSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  googleSchema,
};
