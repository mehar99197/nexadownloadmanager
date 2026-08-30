'use strict';

const router = require('express').Router();

const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { contactLimiter } = require('../middleware/rateLimiter');
const { requireTurnstile } = require('../middleware/turnstile');
const { ok } = require('../utils/respond');
const { sendContactMessage } = require('../utils/email');
const { contactSchema } = require('../schemas/contact.schema');

const TOPIC_LABEL = {
  general: 'General question', bug: 'Bug report', billing: 'Billing & refunds',
  license: 'License & seats', macos: 'macOS interest', feature: 'Feature request', other: 'Other',
};

// POST /api/contact — the website's contact form. Anyone may write; the
// message goes to the support inbox with Reply-To set to the sender.
router.post(
  '/', contactLimiter, requireTurnstile, validate(contactSchema),
  asyncHandler(async (req, res) => {
    const { name, email, topic, message } = req.body;
    await sendContactMessage({
      name, email, topic: TOPIC_LABEL[topic] || topic, message,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    });
    return ok(res, { sent: true });
  })
);

module.exports = router;
