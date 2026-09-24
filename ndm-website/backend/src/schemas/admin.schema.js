'use strict';

const { z } = require('zod');

// Release artifact URLs become installer downloads — https only.
const { httpsUrl } = require('./common');

// The website backend uses MySQL AUTO_INCREMENT ids, not Mongo ObjectIds.
const objectId = z.coerce.number().int().positive('Invalid id');

// Artifact checksum: exactly 64 hex chars (case-insensitive, stored lowercase).
const sha256 = z.string().trim().toLowerCase().regex(/^[a-f0-9]{64}$/, 'Invalid SHA-256 (expected 64 hex characters)');

const adminLoginSchema = {
  body: z
    .object({
      email: z.string().trim().toLowerCase().email(),
      password: z.string().min(1),
    })
    .strict(),
};

const createAdminUserSchema = {
  body: z.object({
    name: z.string().trim().min(1).max(255),
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(8).max(200),
    // No `role` here on purpose: staff admins create ordinary customers only.
    // Minting or promoting a control-panel account is creator-only, and lives
    // at POST /api/root/admins.
    plan: z.enum(['free', 'pro', 'team']).default('free'),
  }).strict(),
};

const resetUserPasswordSchema = {
  params: z.object({ id: objectId }).strict(),
  body: z.object({ password: z.string().min(8).max(200) }).strict(),
};

// Ban/unban + change plan. Role is absent by design — see createAdminUserSchema.
const updateUserSchema = {
  params: z.object({ id: objectId }).strict(),
  body: z
    .object({
      banned: z.boolean().optional(),
      emailVerified: z.boolean().optional(),
      plan: z.enum(['free', 'pro', 'team']).optional(),
    })
    .strict()
    .refine((d) => Object.keys(d).length > 0, { message: 'No fields to update' }),
};

// Approve / reject a review.
const updateReviewSchema = {
  params: z.object({ id: objectId }).strict(),
  body: z
    .object({
      status: z.enum(['pending', 'approved', 'rejected']),
    })
    .strict(),
};

const updateSubscriptionSchema = {
  params: z.object({ id: objectId }).strict(),
  body: z
    .object({
      plan: z.enum(['free', 'pro', 'team']).optional(),
      status: z.enum(['active', 'expired', 'cancelled']).optional(),
      seats: z.coerce.number().int().min(1).max(100).optional(),
      // Support has to be able to correct an expiry by hand: extending a
      // customer whose renewal webhook went missing, or honouring a refund.
      // Absent leaves it alone; a plan change without one still recomputes it.
      expiryDate: z.string().trim().datetime({ offset: true })
        .transform((v) => new Date(v)).optional(),
    })
    .strict()
    .refine((d) => Object.keys(d).length > 0, { message: 'No fields to update' }),
};

const createSubscriptionSchema = {
  body: z.object({
    userId: z.coerce.number().int().positive(),
    plan: z.enum(['free', 'pro', 'team']),
    status: z.enum(['active', 'expired', 'cancelled']).default('active'),
    seats: z.coerce.number().int().min(1).max(100).optional(),
    expiryDate: z.string().datetime().optional(),
  }).strict(),
};

const reviewListQuerySchema = {
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(20),
    status: z.enum(['pending', 'approved', 'rejected']).optional(),
    rating: z.coerce.number().int().min(1).max(5).optional(),
  }).strict(),
};

const bulkReviewSchema = {
  body: z.object({
    ids: z.array(z.coerce.number().int().positive()).min(1).max(200),
    status: z.enum(['pending', 'approved', 'rejected']),
  }).strict(),
};

const createReleaseSchema = {
  body: z
    .object({
      version: z.string().trim().min(1).max(50),
      windowsUrl: httpsUrl.optional(),
      linuxUrl: httpsUrl.optional(),
      windowsSha256: sha256.optional(),
      linuxSha256: sha256.optional(),
      changelog: z.string().max(20000).optional(),
      isLatest: z.boolean().optional(),
    })
    .strict(),
};

const updateReleaseSchema = {
  params: z.object({ id: objectId }).strict(),
  body: z
    .object({
      version: z.string().trim().min(1).max(50).optional(),
      windowsUrl: httpsUrl.optional(),
      linuxUrl: httpsUrl.optional(),
      windowsSha256: sha256.nullable().optional(),
      linuxSha256: sha256.nullable().optional(),
      changelog: z.string().max(20000).optional(),
      isLatest: z.boolean().optional(),
    })
    .strict()
    .refine((d) => Object.keys(d).length > 0, { message: 'No fields to update' }),
};

// Generic paginated list query for admin tables.
const listQuerySchema = {
  query: z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(200).default(20),
      q: z.string().trim().max(200).optional(),
      status: z.string().trim().max(50).optional(),
      plan: z.enum(['free', 'pro', 'team']).optional(),
      role: z.enum(['user', 'admin', 'root']).optional(),
      banned: z.enum(['true', 'false']).optional(),
      emailVerified: z.enum(['true', 'false']).optional(),
    })
    .strict(),
};

const idParamSchema = {
  params: z.object({ id: objectId }).strict(),
};

// The read-only admin queries that used to take req.query as it came. The
// models clamp these anyway; the schemas make a bad value a 400 at the door
// instead of a silently substituted default, and refuse unknown keys.
const limitQuerySchema = {
  query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).strict(),
};
const usersExportQuerySchema = {
  query: z
    .object({
      q: z.string().trim().max(200).optional(),
      role: z.enum(['user', 'admin', 'root']).optional(),
      banned: z.enum(['true', 'false']).optional(),
      emailVerified: z.enum(['true', 'false']).optional(),
    })
    .strict(),
};
const subscriptionsExportQuerySchema = {
  query: z
    .object({
      q: z.string().trim().max(200).optional(),
      status: z.string().trim().max(50).optional(),
      plan: z.enum(['free', 'pro', 'team']).optional(),
    })
    .strict(),
};
const tokenRejectionsQuerySchema = {
  query: z.object({ hours: z.coerce.number().int().min(1).max(24 * 30).optional() }).strict(),
};
const securityEventsQuerySchema = {
  query: z
    .object({
      hours: z.coerce.number().int().min(1).max(24 * 30).optional(),
      kind: z.string().trim().regex(/^[a-z0-9_.]{1,50}$/).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    })
    .strict(),
};

// Installer upload/removal: /releases/:id/artifact/:os
const releaseArtifactParamsSchema = {
  params: z.object({ id: objectId, os: z.enum(['windows', 'linux']) }).strict(),
};

// Deleting an account is irreversible and cascades through subscriptions,
// reviews and licence activations (payments are kept, detached). The body must repeat the target's
// exact address, so the destructive call cannot be made by clicking the wrong
// row — the same guard the creator's Danger Zone uses.
const deleteUserSchema = {
  params: z.object({ id: objectId }).strict(),
  body: z.object({ confirmEmail: z.string().trim().toLowerCase().email() }).strict(),
};

module.exports = {
  adminLoginSchema,
  deleteUserSchema,
  createAdminUserSchema,
  resetUserPasswordSchema,
  updateUserSchema,
  updateReviewSchema,
  updateSubscriptionSchema,
  createSubscriptionSchema,
  reviewListQuerySchema,
  bulkReviewSchema,
  createReleaseSchema,
  updateReleaseSchema,
  releaseArtifactParamsSchema,
  listQuerySchema,
  idParamSchema,
  limitQuerySchema,
  usersExportQuerySchema,
  subscriptionsExportQuerySchema,
  tokenRejectionsQuerySchema,
  securityEventsQuerySchema,
  sha256,
};
