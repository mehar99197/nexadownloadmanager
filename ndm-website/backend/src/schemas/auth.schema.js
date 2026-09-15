'use strict';

const { z } = require('zod');

const email = z.string().trim().toLowerCase().email();
const strongPassword = z.string().min(8, 'Password must be at least 8 characters').max(128);

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

// "Continue with Google": the ID token minted by Google Identity Services in the
// browser. Length is bounded so a bogus multi-megabyte body is rejected before
// any crypto work; a real Google ID token is well under 4 KB.
const googleSchema = {
  body: z
    .object({
      credential: z.string().trim().min(20).max(4096),
      nonce: z.string().trim().min(16).max(128).optional(),
    })
    .strict(),
};

// Ask for the verification link again. Same shape as forgot-password, and the
// same generic answer, so neither can be used to test which addresses exist.
const resendVerificationSchema = {
  body: z
    .object({
      email,
    })
    .strict(),
};

module.exports = {
  resendVerificationSchema,
  registerSchema,
  loginSchema,
  verifyEmailSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  googleSchema,
};
