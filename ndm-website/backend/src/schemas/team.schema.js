'use strict';

const { z } = require('zod');

const email = z.string().trim().toLowerCase().email();
const objectId = z.coerce.number().int().positive('Invalid id');

const inviteSchema = {
  body: z.object({ email }).strict(),
};

const memberIdSchema = {
  params: z.object({ id: objectId }).strict(),
};

// Invite tokens are 32 random bytes as base64url (43 chars); anything else is
// rejected before it reaches the database.
const inviteToken = z.string().trim().regex(/^[A-Za-z0-9_-]{40,64}$/, 'Invalid invite token');

const joinSchema = {
  body: z.object({ token: inviteToken }).strict(),
};

const inviteLookupSchema = {
  params: z.object({ token: inviteToken }).strict(),
};

module.exports = { inviteSchema, memberIdSchema, joinSchema, inviteLookupSchema, inviteToken };
