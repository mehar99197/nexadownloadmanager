'use strict';

const { z } = require('zod');

const os = z.enum(['windows', 'linux']);

// GET /api/releases/download/:os
const downloadOsSchema = {
  params: z.object({ os }).strict(),
};

// GET /api/releases/feed?os=windows|linux
const feedQuerySchema = {
  query: z.object({ os }).strict(),
};

module.exports = { downloadOsSchema, feedQuerySchema };
