'use strict';

const crypto = require('crypto');

const { query, execute, queryOne } = require('../config/db');

/**
 * "Was this helpful?" under each FAQ answer.
 *
 * Two counters per question and nothing else. A vote tells us nothing worth
 * keeping about the person who cast it, so nothing about them is kept: no IP,
 * no account, no per-visitor timestamp. What the table answers is the only
 * question the feature exists for — which answers are failing their readers.
 */

// The endpoint is public and takes the question text, so the set of keys is
// attacker-chosen. Without a ceiling, a script posting a million distinct
// strings is a million rows. The FAQ has 55 answers; 500 leaves room for it to
// triple and still refuses a flood. Votes for keys that ALREADY exist are never
// refused, so real readers are unaffected once the table is warm.
const MAX_DISTINCT_QUESTIONS = 500;

function keyFor(question) {
  return crypto.createHash('sha1').update(String(question).trim()).digest('hex');
}

/**
 * Record one vote. Returns true when it was counted, false when the question is
 * new and the table is already at its ceiling.
 *
 * The UPDATE is attempted first and the INSERT only happens when it changed
 * nothing, so the common path is a single statement and the row count is only
 * consulted for a genuinely new question.
 */
async function record(question, helpful) {
  const text = String(question).trim().slice(0, 300);
  if (!text) return false;
  const key = keyFor(text);
  const column = helpful ? 'yes_count' : 'no_count';

  const updated = await execute(
    `UPDATE faq_votes SET ${column} = ${column} + 1 WHERE question_key = ?`,
    [key]
  );
  if (updated.affectedRows > 0) return true;

  const row = await queryOne('SELECT COUNT(*) AS n FROM faq_votes');
  if (row && Number(row.n) >= MAX_DISTINCT_QUESTIONS) return false;

  // INSERT ... ON DUPLICATE KEY, not a plain INSERT: two readers voting on the
  // same new question at the same moment both get here, and the loser of that
  // race must still be counted rather than throwing a duplicate-key error.
  await execute(
    `INSERT INTO faq_votes (question_key, question, yes_count, no_count)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE ${column} = ${column} + 1`,
    [key, text, helpful ? 1 : 0, helpful ? 0 : 1]
  );
  return true;
}

/**
 * Every question that has been voted on, worst first — an answer with many
 * "no" votes is the one to rewrite. Ordered by no_count before the ratio so a
 * single "no" on an otherwise unread answer does not outrank a page that is
 * failing hundreds of people.
 */
async function all({ limit = 200 } = {}) {
  const rows = await query(
    `SELECT question, yes_count, no_count, updated_at
       FROM faq_votes
      ORDER BY no_count DESC, yes_count DESC
      LIMIT ?`,
    [Number(limit)]
  );
  return rows.map((r) => ({
    question: r.question,
    yes: Number(r.yes_count),
    no: Number(r.no_count),
    updatedAt: r.updated_at,
  }));
}

module.exports = { record, all, keyFor, MAX_DISTINCT_QUESTIONS };
