'use strict';

const { z } = require('zod');

// Bounds mirror utils/aiProxy.js. They are here as well as there because every
// character reaching the model costs money, and rejecting an oversized request
// before it is paid for is cheaper than truncating it afterwards.
const aiRenameSchema = {
  body: z
    .object({
      filename: z.string().trim().min(1).max(300),
      url: z.string().trim().max(2048).optional().default(''),
      contentType: z.string().trim().max(100).optional().default(''),
    })
    .strict(),
};

const aiCommandSchema = {
  body: z
    .object({
      text: z.string().trim().min(1).max(2000),
    })
    .strict(),
};

module.exports = { aiRenameSchema, aiCommandSchema };
