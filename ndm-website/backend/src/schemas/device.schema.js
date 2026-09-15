'use strict';

const { z } = require('zod');

// Same opaque machine id the licence endpoints take (schemas/license.schema.js).
const deviceFingerprint = z.string().regex(/^[a-f0-9]{16,64}$/i, 'Invalid device fingerprint');
const deviceName = z.string().trim().min(1).max(120).optional();
const appVersion = z.string().trim().min(1).max(40).optional();

// The secret the app polls with: 32 random bytes, base64url.
const deviceCode = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid device code');
// The long-lived credential a signed-in machine holds.
const deviceToken = z.string().regex(/^ndt_[A-Za-z0-9_-]{43}$/, 'Invalid device token');
// What the person types: "ABCD-1234", with or without the dash, any case.
const userCode = z.string().trim().min(8).max(12);

const deviceCodeRequestSchema = {
  body: z.object({
    device_fingerprint: deviceFingerprint,
    device_name: deviceName,
    app_version: appVersion,
  }).strict(),
};

const devicePollSchema = {
  body: z.object({
    device_code: deviceCode,
    device_fingerprint: deviceFingerprint,
  }).strict(),
};

const deviceUserCodeParamsSchema = {
  params: z.object({ userCode }).strict(),
};

const deviceDecisionSchema = {
  body: z.object({ user_code: userCode }).strict(),
};

const deviceSignOutSchema = {
  body: z.object({
    device_token: deviceToken,
    device_fingerprint: deviceFingerprint,
  }).strict(),
};

module.exports = {
  deviceCodeRequestSchema, devicePollSchema, deviceUserCodeParamsSchema,
  deviceDecisionSchema, deviceSignOutSchema, deviceToken,
};
