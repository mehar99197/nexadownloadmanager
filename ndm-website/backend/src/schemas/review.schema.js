'use strict';

const { z } = require('zod');

const createReviewSchema = {
  body: z
    .object({
      rating: z.coerce.number().int().min(1).max(5),
      comment: z.string().trim().min(1).max(2000),
    })
    .strict(),
};

const listReviewsQuerySchema = {
  query: z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(10),
      rating: z.coerce.number().int().min(1).max(5).optional(),
    })
    .strict(),
};

module.exports = { createReviewSchema, listReviewsQuerySchema };
