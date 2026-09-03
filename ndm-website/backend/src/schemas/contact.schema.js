'use strict';

const { z } = require('zod');

const TOPICS = ['general', 'bug', 'billing', 'license', 'macos', 'feature', 'other'];
const STATUSES = ['new', 'open', 'replied', 'closed', 'spam'];

const contactSchema = {
  body: z
    .object({
      name: z.string().trim().max(100).optional().default(''),
      email: z.string().trim().toLowerCase().email().max(254),
      topic: z.enum(TOPICS).default('general'),
      message: z.string().trim().min(10, 'Please write at least a sentence').max(5000),
      // Honeypot: real browsers leave it empty. A bot that fills every field
      // fails validation here (400 VALIDATION_ERROR) and nothing is stored or
      // sent — the message never reaches the handler.
      website: z.string().max(0).optional().default(''),
    })
    .strict(),
};

// Admin inbox listing: GET /api/admin/contact
const contactListQuerySchema = {
  query: z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(200).default(20),
      status: z.enum(STATUSES).optional(),
      topic: z.enum(TOPICS).optional(),
      q: z.string().trim().max(200).optional(),
    })
    .strict(),
};

const contactIdParamSchema = {
  params: z.object({ id: z.coerce.number().int().positive() }).strict(),
};

// PUT /api/admin/contact/:id — move a thread through the queue.
const updateContactStatusSchema = {
  params: z.object({ id: z.coerce.number().int().positive() }).strict(),
  body: z.object({ status: z.enum(STATUSES) }).strict(),
};

// POST /api/admin/contact/:id/reply — the answer emailed to the visitor.
const contactReplySchema = {
  params: z.object({ id: z.coerce.number().int().positive() }).strict(),
  body: z
    .object({
      body: z.string().trim().min(2, 'Write a reply first').max(10000),
      // Default: sending a reply also closes the thread only when asked, so the
      // usual flow leaves it at 'replied' and visible in the queue.
      close: z.boolean().optional().default(false),
    })
    .strict(),
};

module.exports = {
  contactSchema,
  contactListQuerySchema,
  contactIdParamSchema,
  updateContactStatusSchema,
  contactReplySchema,
  TOPICS,
  STATUSES,
};

