'use strict';

// Quick shape check that the harness itself works before the heavier suites.
const test = require('node:test');
const assert = require('node:assert/strict');
const srv = require('./helpers/testServer');

test('backend integration harness', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();
  await srv.reset();
  const api = srv.client();

  await t.test('health responds with the envelope', async () => {
    const res = await api.get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.status, 'up');
  });

  await t.test('stats reports real numbers, never invented ones', async () => {
    const res = await api.get('/api/stats');
    assert.equal(res.status, 200);
    // An empty database must report zero, not a fabricated baseline.
    assert.equal(res.body.data.users, 0);
    assert.equal(res.body.data.downloads, 0);
  });

  await srv.stop();
});
