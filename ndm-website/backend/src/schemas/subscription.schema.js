'use strict';

const { z } = require('zod');

const checkoutSchema = {
  body: z
    .object({
      plan: z.enum(['pro', 'team']),
      billingCycle: z.enum(['monthly', 'yearly']),
    })
    .strict(),
};

const mockCompleteSchema = {
  body: z.object({
    plan: z.enum(['pro', 'team']),
    billingCycle: z.enum(['monthly', 'yearly']),
  }).strict(),
};

module.exports = { checkoutSchema, mockCompleteSchema };
