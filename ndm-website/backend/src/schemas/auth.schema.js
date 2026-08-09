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

module.exports = {
  registerSchema,
  loginSchema,
  verifyEmailSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
};
