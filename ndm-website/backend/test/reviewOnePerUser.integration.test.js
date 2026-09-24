'use strict';

/**
 * One review per account — enforced by the database, not by a read-then-write.
 *
 * Review.upsertByUserId looked the user's review up and inserted one when it
 * found none. reviews.user_id carried only a plain index, so two POSTs in
 * flight together (a double-click, a retried request) both saw "none" and both
 * inserted: the account then had two reviews, and once approved the public
 * average and breakdown counted that person twice.
 *
 * The fix is a UNIQUE index on reviews.user_id plus a single
 * INSERT … ON DUPLICATE KEY UPDATE. A database that already holds duplicates
 * is de-duplicated (newest row kept) by the boot-time migration before the
 * index is added — and only while the index is missing.
 */

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.EMAIL_VERIFICATION_REQUIRED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const srv = require('./helpers/testServer');
const { initSchema } = require('../src/config/schema');

async function userIdOf(email) {
  return (await srv.query('SELECT id FROM users WHERE email = ?', [email]))[0].id;
}

async function reviewIndexes() {
  return srv.query(
    `SELECT index_name AS name, non_unique AS nonUnique FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = 'reviews' AND column_name = 'user_id'`
  );
}

test('one review per account', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();

  await t.test('reviews posted at the same moment leave exactly one row', async () => {
    await srv.reset();
    const api = srv.client();
    const u = await srv.makeUser(api, 'dupreviewer');
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      api.post('/api/reviews', { rating: (i % 5) + 1, comment: `Attempt number ${i}` }, { token: u.token })));
    for (const r of results) assert.equal(r.status, 201, r.text);

    const rows = await srv.query('SELECT id, rating, status FROM reviews WHERE user_id = ?', [await userIdOf(u.email)]);
    assert.equal(rows.length, 1, `one row, got ${rows.length}`);
    // Every answer describes that one row.
    assert.ok(results.every((r) => r.body.data.id === rows[0].id));

    // Approved, the public average counts the person once.
    await srv.query("UPDATE reviews SET status = 'approved'");
    const pub = await api.get('/api/reviews');
    assert.equal(pub.body.data.totalCount, 1);
    assert.equal(pub.body.data.averageRating, rows[0].rating);
  });

  // The HTTP requests above are staggered by auth and body parsing, which can
  // hide the race; calling the model directly is the tightest version of it.
  await t.test('concurrent upserts for one account cannot create a second row', async () => {
    await srv.reset();
    const Review = require('../src/models/Review');
    const api = srv.client();
    const u = await srv.makeUser(api, 'racereviewer');
    const userId = await userIdOf(u.email);
    const saved = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      Review.upsertByUserId(userId, { userName: 'Racer', rating: (i % 5) + 1, comment: `Race ${i}` })));
    const rows = await srv.query('SELECT id FROM reviews WHERE user_id = ?', [userId]);
    assert.equal(rows.length, 1, `one row, got ${rows.length}`);
    assert.ok(saved.every((r) => r && r.id === rows[0].id));
  });

  await t.test('editing keeps the same row and sends it back to moderation', async () => {
    await srv.reset();
    const api = srv.client();
    const u = await srv.makeUser(api, 'editreviewer');
    const first = await api.post('/api/reviews', { rating: 5, comment: 'Great first impression.' }, { token: u.token });
    assert.equal(first.status, 201, first.text);
    await srv.query("UPDATE reviews SET status = 'approved' WHERE id = ?", [first.body.data.id]);
    const edited = await api.post('/api/reviews', { rating: 3, comment: 'Changed my mind a bit.' }, { token: u.token });
    assert.equal(edited.status, 201, edited.text);
    assert.equal(edited.body.data.id, first.body.data.id);
    assert.equal(edited.body.data.rating, 3);
    assert.equal(edited.body.data.comment, 'Changed my mind a bit.');
    assert.equal(edited.body.data.status, 'pending');
  });

  await t.test('the migration de-duplicates an old database, keeping the newest review', async () => {
    await srv.reset();
    const api = srv.client();
    const a = await srv.makeUser(api, 'olddupe');
    const b = await srv.makeUser(api, 'oldsingle');
    const aId = await userIdOf(a.email);
    const bId = await userIdOf(b.email);

    // Put the table back the way a pre-fix database has it: a plain index only.
    await srv.query('ALTER TABLE reviews ADD INDEX idx_user_id (user_id)').catch(() => {});
    await srv.query('ALTER TABLE reviews DROP INDEX uq_reviews_user').catch(() => {});
    assert.ok((await reviewIndexes()).every((i) => Number(i.nonUnique) === 1), 'no unique index left');

    const ins = 'INSERT INTO reviews (user_id, user_name, rating, comment, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)';
    await srv.query(ins, [aId, 'A', 1, 'oldest', 'approved', '2025-01-01 00:00:00', '2025-01-01 00:00:00']);
    await srv.query(ins, [aId, 'A', 4, 'newest', 'pending', '2025-03-01 00:00:00', '2025-03-01 00:00:00']);
    await srv.query(ins, [aId, 'A', 2, 'middle', 'approved', '2025-02-01 00:00:00', '2025-02-01 00:00:00']);
    await srv.query(ins, [bId, 'B', 5, 'only one', 'approved', '2024-01-01 00:00:00', '2024-01-01 00:00:00']);

    await initSchema();
    await initSchema(); // and again: a second boot is a no-op

    const aRows = await srv.query('SELECT comment FROM reviews WHERE user_id = ?', [aId]);
    assert.deepEqual(aRows.map((r) => r.comment), ['newest']);
    const bRows = await srv.query('SELECT comment FROM reviews WHERE user_id = ?', [bId]);
    assert.deepEqual(bRows.map((r) => r.comment), ['only one']);

    const idx = await reviewIndexes();
    assert.ok(idx.some((i) => i.name === 'uq_reviews_user' && Number(i.nonUnique) === 0), 'unique index added');
    assert.ok(!idx.some((i) => i.name === 'idx_user_id'), 'the redundant plain index is gone');

    // The database now refuses a second row outright.
    await assert.rejects(srv.query(ins, [bId, 'B', 1, 'second', 'pending', '2025-01-01 00:00:00', '2025-01-01 00:00:00']),
      (err) => err.code === 'ER_DUP_ENTRY');
  });

  await t.test('a fresh database gets the unique index from CREATE TABLE, twice cleanly', async () => {
    await srv.query('DROP TABLE reviews');
    await initSchema();
    await initSchema();
    const idx = await reviewIndexes();
    assert.ok(idx.some((i) => i.name === 'uq_reviews_user' && Number(i.nonUnique) === 0));
    assert.ok(!idx.some((i) => i.name === 'idx_user_id'));
  });

  await srv.stop();
});
