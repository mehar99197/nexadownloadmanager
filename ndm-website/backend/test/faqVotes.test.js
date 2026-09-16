'use strict';

/**
 * "Was this helpful?" — the parts that do not need a database.
 *
 * The route stores two counters per question and nothing about the voter, so
 * what is worth pinning here is the boundary: what the endpoint accepts, and
 * that the key really is derived from the question TEXT. The counting itself
 * is covered against a real database in api.integration.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { faqVoteSchema } = require('../src/schemas/faq.schema');
const FaqVote = require('../src/models/FaqVote');

test('faqVoteSchema accepts a question and a boolean verdict', () => {
  assert.deepEqual(
    faqVoteSchema.body.parse({ question: '  Does Nexa work offline?  ', helpful: true }),
    { question: 'Does Nexa work offline?', helpful: true }
  );
  assert.equal(faqVoteSchema.body.parse({ question: 'Why?!?', helpful: false }).helpful, false);
});

test('faqVoteSchema rejects everything that is not one clear vote', () => {
  const bad = [
    { question: 'Does Nexa work offline?' },                         // no verdict
    { question: 'Does Nexa work offline?', helpful: 'yes' },         // a string is not a boolean
    { question: 'Does Nexa work offline?', helpful: 1 },             // nor is 1
    { question: 'no', helpful: true },                               // too short to be a question
    { question: 'x'.repeat(301), helpful: true },                    // beyond the column
    { question: '   ', helpful: true },                              // blank after trimming
    // .strict(): an unknown key is refused rather than ignored, so a client
    // that thinks it is sending a count or an id finds out immediately.
    { question: 'Does Nexa work offline?', helpful: true, votes: 500 },
  ];
  for (const body of bad) {
    assert.equal(
      faqVoteSchema.body.safeParse(body).success, false,
      `expected rejection for ${JSON.stringify(body)}`
    );
  }
});

test('the key is derived from the question text, not from its position', () => {
  // This is the whole reason the API takes text rather than an index: inserting
  // one entry into the FAQ must not hand an existing question's counts to a
  // different one.
  const a = FaqVote.keyFor('Does Nexa work offline?');
  const b = FaqVote.keyFor('Does Nexa work offline?');
  const c = FaqVote.keyFor('Does Nexa work offline');   // one character apart
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{40}$/);
});

test('surrounding whitespace does not split one question into two rows', () => {
  assert.equal(
    FaqVote.keyFor('  Does Nexa work offline?\n'),
    FaqVote.keyFor('Does Nexa work offline?')
  );
});

test('the distinct-question ceiling leaves room for the FAQ to grow', () => {
  // The page has 55 answers today. The ceiling exists to stop a script posting
  // a million distinct strings, not to constrain the FAQ, so it must stay well
  // clear of any plausible size.
  assert.ok(FaqVote.MAX_DISTINCT_QUESTIONS >= 300, 'ceiling is not squeezing real questions');
  assert.ok(FaqVote.MAX_DISTINCT_QUESTIONS <= 5000, 'ceiling is still a bound');
});
