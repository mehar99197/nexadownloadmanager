'use strict';

const { z } = require('zod');

const { isValidEntry } = require('../utils/ipMatch');

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

// Deleting an account is irreversible and cascades to its subscriptions
// and reviews (payments are kept, detached), so the caller must retype the exact email to confirm.
const deleteUserSchema = {
  params: z.object({ id: objectId }).strict(),
  body: z.object({ confirmEmail: z.string().trim().toLowerCase().email() }).strict(),
};

// An allow-list entry is validated by the same function the gate matches with,
// so the panel cannot accept a value that would then never match anything —
// which is how a typo becomes "I added my address and it still says 403".
const ipRuleSchema = {
  body: z
    .object({
      value: z.string().trim().min(1).max(64).refine(isValidEntry, {
        message: 'Not an address, a CIDR range, or *',
      }),
      label: z.string().trim().max(100).optional(),
    })
    .strict(),
};

const ipRuleUpdateSchema = {
  params: z.object({ id: objectId }).strict(),
  body: z.object({ enabled: z.boolean() }).strict(),
};

module.exports = {
  ipRuleSchema,
  ipRuleUpdateSchema,
  rootLoginSchema,
  createAdminSchema,
  updateAdminSchema,
  resetAdminPasswordSchema,
  idParamSchema,
  auditQuerySchema,
  deleteUserSchema,
};
