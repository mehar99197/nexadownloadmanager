'use strict';

const { z } = require('zod');

// Profile edits: the display name. The password is NOT changed here — that is
// POST /auth/change-password, which revokes the other sessions and has to live
// under /api/auth to see the refresh cookie (see routes/auth.js).
const updateProfileSchema = {
  body: z
    .object({
      name: z.string().trim().min(1).max(100),
    })
    .strict(),
};

// Self-service account deletion is irreversible, so it takes the password AND
// the literal word DELETE — one proves it is the owner, the other that it is
// deliberate. Both are checked again on the server, never only in the form.
// `password` is optional here only for Google-created accounts, which have none;
// routes/user.js still demands it for every account that does.
const deleteAccountSchema = {
  body: z
    .object({
      password: z.string().min(1).optional(),
      confirm: z.string().trim().refine((v) => v === 'DELETE', { message: 'Type DELETE to confirm' }),
    })
    .strict(),
};

module.exports = { updateProfileSchema, deleteAccountSchema };
