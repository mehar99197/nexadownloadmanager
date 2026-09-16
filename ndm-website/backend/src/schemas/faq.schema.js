'use strict';

const { z } = require('zod');

// POST /api/faq/vote — "Was this helpful?" under one FAQ answer.
//
// The question is identified by its own text. An index would be smaller, but it
// would also mean that inserting one entry into the FAQ silently reassigns
// every stored count to the wrong question, and nobody would notice.
const faqVoteSchema = {
  body: z
    .object({
      question: z.string().trim().min(3).max(300),
      helpful: z.boolean(),
    })
    .strict(),
};

module.exports = { faqVoteSchema };
