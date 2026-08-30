'use strict';

const { z } = require('zod');

const TOPICS = ['general', 'bug', 'billing', 'license', 'macos', 'feature', 'other'];

const contactSchema = {
  body: z
    .object({
      name: z.string().trim().max(100).optional().default(''),
      email: z.string().trim().toLowerCase().email().max(254),
      topic: z.enum(TOPICS).default('general'),
      message: z.string().trim().min(10, 'Please write at least a sentence').max(5000),
      // Honeypot: real browsers leave it empty; a bot that fills every field
      // gets a polite 200 and nothing is sent.
      website: z.string().max(0).optional().default(''),
    })
    .strict(),
};

module.exports = { contactSchema, TOPICS };
