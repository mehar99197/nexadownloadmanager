'use strict';

const { z } = require('zod');

// Promotion codes are short, printable and case-insensitive on Stripe's side.
const couponCode = z.string().trim().min(2).max(64).regex(/^[A-Za-z0-9_-]+$/);

const checkoutSchema = {
  body: z
    .object({
      plan: z.enum(['pro', 'team']),
      billingCycle: z.enum(['monthly', 'yearly']),
      couponCode: couponCode.optional(),
    })
    .strict(),
};

const couponSchema = { body: z.object({ couponCode }).strict() };

const mockCompleteSchema = {
  body: z.object({
    plan: z.enum(['pro', 'team']),
    billingCycle: z.enum(['monthly', 'yearly']),
  }).strict(),
};

module.exports = { checkoutSchema, mockCompleteSchema, couponSchema };
