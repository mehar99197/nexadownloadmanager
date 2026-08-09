'use strict';

const { z } = require('zod');

// Update name and/or password. At least one field required.
const updateProfileSchema = {
  body: z
    .object({
      name: z.string().trim().min(1).max(100).optional(),
      currentPassword: z.string().min(1).optional(),
      newPassword: z.string().min(8, 'Password must be at least 8 characters').optional(),
    })
    .strict()
    .refine((d) => d.name !== undefined || d.newPassword !== undefined, {
      message: 'Provide a name or a new password to update',
    })
    .refine((d) => !d.newPassword || d.currentPassword, {
      message: 'currentPassword is required to set a new password',
      path: ['currentPassword'],
    }),
};

module.exports = { updateProfileSchema };
