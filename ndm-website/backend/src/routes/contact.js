'use strict';

const router = require('express').Router();

const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { contactLimiter } = require('../middleware/rateLimiter');
const { requireTurnstile } = require('../middleware/turnstile');
const { optionalAuth } = require('../middleware/auth');
const { ok } = require('../utils/respond');
const { sendContactMessage } = require('../utils/email');
const { contactSchema } = require('../schemas/contact.schema');
const ContactMessage = require('../models/ContactMessage');

const TOPIC_LABEL = {
  general: 'General question', bug: 'Bug report', billing: 'Billing & refunds',
  license: 'License & seats', macos: 'macOS interest', feature: 'Feature request', other: 'Other',
};

// POST /api/contact — the website's contact form. Anyone may write.
//
// The message is STORED FIRST and only then emailed: the admin inbox
// (/api/admin/contact) is the system of record, so a message survives an SMTP
// outage instead of vanishing with it. The notification email is best-effort and
// its outcome is recorded on the row.
router.post(
  '/', contactLimiter, optionalAuth, requireTurnstile, validate(contactSchema),
  asyncHandler(async (req, res) => {
    const { name, email, topic, message } = req.body;
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 300);

    // Attach the thread to an account ONLY when the sender is signed in as it.
    //
    // This used to attach on a bare email match, so anybody could type a
    // customer's address into a public form and have the message land in the
    // admin inbox labelled as coming from that customer's account — a very
    // good pretext for talking an admin into a refund, a plan change or a
    // password reset. The lookup is gone entirely rather than merely relabelled:
    // an admin can still search by address, and a link that means "this person
    // was authenticated" is worth more than one that means "somebody typed
    // this".
    const authenticatedSender = req.user
      && String(req.user.email).toLowerCase() === String(email).toLowerCase();

    const stored = await ContactMessage.create({
      userId: authenticatedSender ? req.user.id : null,
      name, email, topic, message,
      ip: String(req.ip || '').slice(0, 45),
      userAgent,
    });

    let delivered = false;
    try {
      await sendContactMessage({
        name, email, topic: TOPIC_LABEL[topic] || topic, message, userAgent,
      });
      delivered = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[contact] notification email failed:', err.message);
    }
    await ContactMessage.markEmailDelivered(stored.id, delivered);

    // `sent: true` regardless: the message IS safely recorded and will be
    // answered from the panel. Reporting a failure here would only push the
    // visitor into sending it again.
    return ok(res, { sent: true });
  })
);

module.exports = router;

