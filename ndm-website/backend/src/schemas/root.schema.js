'use strict';

const { z } = require('zod');

const objectId = z.coerce.number().int().positive('Invalid id');

const rootLoginSchema = {
  body: z
    .object({
      email: z.string().trim().toLowerCase().email(),
      password: z.string().min(1),
    })
    .strict(),
};

// The creator mints staff admins. 'root' is deliberately absent from every
// schema in this file: a second creator can only be created by the CLI script
// (npm run create-root), never over HTTP, so no request can escalate to root.
const createAdminSchema = {
  body: z
    .object({
      name: z.string().trim().min(1).max(255),
      email: z.string().trim().toLowerCase().email(),
      password: z.string().min(12).max(200),
    })
    .strict(),
};

const updateAdminSchema = {
  params: z.object({ id: objectId }).strict(),
  body: z
    .object({
      name: z.string().trim().min(1).max(255).optional(),
      banned: z.boolean().optional(),
      role: z.enum(['user', 'admin']).optional(),
    })
    .strict()
    .refine((d) => Object.keys(d).length > 0, { message: 'No fields to update' }),
};

const resetAdminPasswordSchema = {
  params: z.object({ id: objectId }).strict(),
  body: z.object({ password: z.string().min(12).max(200) }).strict(),
};

const idParamSchema = { params: z.object({ id: objectId }).strict() };

const auditQuerySchema = {
  query: z
    .object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
    })
    .strict(),
};

// Deleting an account is irreversible and cascades to its subscriptions,
// payments and reviews, so the caller must retype the exact email to confirm.
const deleteUserSchema = {
  params: z.object({ id: objectId }).strict(),
  body: z.object({ confirmEmail: z.string().trim().toLowerCase().email() }).strict(),
};

module.exports = {
  rootLoginSchema,
  createAdminSchema,
  updateAdminSchema,
  resetAdminPasswordSchema,
  idParamSchema,
  auditQuerySchema,
  deleteUserSchema,
};
