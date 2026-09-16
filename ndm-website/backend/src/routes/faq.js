'use strict';

const router = require('express').Router();

const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { faqVoteLimiter } = require('../middleware/rateLimiter');
const { ok } = require('../utils/respond');
const { faqVoteSchema } = require('../schemas/faq.schema');
const FaqVote = require('../models/FaqVote');

// POST /api/faq/vote — one "Was this helpful?" click. Anyone may vote; there is
// nothing to authenticate and nothing about the voter is stored.
//
// The reply is `{ recorded: true }` even when the vote was dropped for hitting
// the distinct-question ceiling. That is not a lie by omission: the reader is
// being told their click was received, which it was, and the alternative is an
// error message about an internal table limit that means nothing to them and
// invites a retry loop. What the ceiling protects is the table, not the answer.
router.post(
  '/vote', faqVoteLimiter, validate(faqVoteSchema),
  asyncHandler(async (req, res) => {
    const { question, helpful } = req.body;
    await FaqVote.record(question, helpful);
    return ok(res, { recorded: true });
  })
);

module.exports = router;
