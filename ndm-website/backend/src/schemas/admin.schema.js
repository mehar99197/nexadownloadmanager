'use strict';

const { z } = require('zod');

// The website backend uses MySQL AUTO_INCREMENT ids, not Mongo ObjectIds.
const objectId = z.coerce.number().int().positive('Invalid id');

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
    role: z.enum(['user', 'admin']).default('user'),
    plan: z.enum(['free', 'pro', 'team']).default('free'),
  }).strict(),
};

const resetUserPasswordSchema = {
  params: z.object({ id: objectId }).strict(),
  body: z.object({ password: z.string().min(8).max(200) }).strict(),
};

// Ban/unban + change plan + role.
const updateUserSchema = {
  params: z.object({ id: objectId }).strict(),
  body: z
    .object({
      banned: z.boolean().optional(),
      emailVerified: z.boolean().optional(),
      role: z.enum(['user', 'admin']).optional(),
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
      windowsUrl: z.string().url().optional(),
      linuxUrl: z.string().url().optional(),
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
      windowsUrl: z.string().url().optional(),
      linuxUrl: z.string().url().optional(),
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
      role: z.enum(['user', 'admin']).optional(),
      banned: z.enum(['true', 'false']).optional(),
      emailVerified: z.enum(['true', 'false']).optional(),
    })
    .strict(),
};

const idParamSchema = {
  params: z.object({ id: objectId }).strict(),
};

module.exports = {
  adminLoginSchema,
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
  listQuerySchema,
  idParamSchema,
};
