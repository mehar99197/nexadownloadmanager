'use strict';

const { z } = require('zod');
const { AD_PLACEMENTS } = require('../utils/ads');

const adId = z.coerce.number().int().positive('Invalid id');

// Ad links are opened in the user's own browser and images are fetched by the
// desktop client, so both are restricted to HTTPS. An admin account is not a
// licence to point the app at http:// or javascript: URLs.
const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .url('Must be a URL')
  .refine((v) => v.toLowerCase().startsWith('https://'), 'Must start with https://');

// An ISO datetime, or an explicit clear. The `.optional()` sits OUTSIDE the
// transform on purpose: an absent key must stay absent so a partial update
// (say, renaming an ad) does not silently wipe its schedule. Only an explicit
// "" or null — what the admin form sends for an empty field — clears a bound.
const optionalDate = z
  .union([
    z.string().trim().datetime({ offset: true }).transform((v) => new Date(v)),
    z.string().trim().length(0).transform(() => null),
    z.null(),
  ])
  .optional();

const placement = z.enum(AD_PLACEMENTS);

const createAdSchema = {
  body: z
    .object({
      title: z.string().trim().min(1).max(120),
      body: z.string().trim().max(300).default(''),
      imageUrl: httpsUrl.optional().nullable(),
      targetUrl: httpsUrl,
      ctaLabel: z.string().trim().min(1).max(40).default('Learn more'),
      placement: placement.default('app_banner'),
      active: z.boolean().default(true),
      weight: z.coerce.number().int().min(1).max(100).default(1),
      startsAt: optionalDate,
      endsAt: optionalDate,
    })
    .strict()
    .refine((d) => !d.startsAt || !d.endsAt || d.endsAt > d.startsAt, {
      message: 'End must be after start',
      path: ['endsAt'],
    }),
};

const updateAdSchema = {
  params: z.object({ id: adId }).strict(),
  body: z
    .object({
      title: z.string().trim().min(1).max(120).optional(),
      body: z.string().trim().max(300).optional(),
      imageUrl: httpsUrl.nullable().optional(),
      targetUrl: httpsUrl.optional(),
      ctaLabel: z.string().trim().min(1).max(40).optional(),
      placement: placement.optional(),
      active: z.boolean().optional(),
      weight: z.coerce.number().int().min(1).max(100).optional(),
      startsAt: optionalDate,
      endsAt: optionalDate,
    })
    .strict()
    .refine((d) => Object.keys(d).length > 0, { message: 'No fields to update' })
    .refine((d) => !d.startsAt || !d.endsAt || d.endsAt > d.startsAt, {
      message: 'End must be after start',
      path: ['endsAt'],
    }),
};

const adIdParamSchema = {
  params: z.object({ id: adId }).strict(),
};

// GET /api/ads?placement=app_banner — the desktop app asks for one surface.
const serveAdsSchema = {
  query: z.object({ placement: placement.default('app_banner') }).strict(),
};

// POST /api/ads/:id/event { type, token }
//
// `token` is the short-lived proof issued alongside the ad by GET /api/ads. It
// is optional in the schema so an older desktop build still gets a clean 200
// rather than a validation error — the route simply does not count it.
const adEventSchema = {
  params: z.object({ id: adId }).strict(),
  body: z.object({
    type: z.enum(['impression', 'click']),
    token: z.string().trim().max(200).optional(),
  }).strict(),
};

module.exports = {
  createAdSchema, updateAdSchema, adIdParamSchema, serveAdsSchema, adEventSchema,
};
