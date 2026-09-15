'use strict';

// The installer download limiter must count only fresh starts. The desktop
// updater pulls the installer through the segmented engine — dozens of ranged
// requests per file — and counting each chunk made every auto-update die with
// 429 part-way through (2026-09-13, v0.2.1 rollout).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

delete process.env.RATE_LIMIT_DISABLED;   // exercise the real limiter
const express = require('express');
const { downloadLimiter, apiLimiter } = require('../src/middleware/rateLimiter');

// Mounted exactly like app.js: the global limiter on /api, the download
// limiter on the route — both must let installer continuations through.
function serve() {
  const app = express();
  app.use('/api', apiLimiter);
  app.get('/api/releases/download/:os', downloadLimiter, (req, res) => res.status(200).send('ok'));
  app.get('/api/other', (req, res) => res.status(200).send('ok'));
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function get(server, headers = {}, path = '/api/releases/download/windows') {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  await res.text();
  return res.status;
}

// One test, because the limiters are module-level singletons with in-memory
// stores keyed by client IP: every server here shares one budget.
test('installer transfers: continuations are free, fresh starts get their own budget, the global limiter never counts the route', async () => {
  const server = await serve();
  try {
    // Well past the global limiter's 1000 if the route were counted there.
    for (let i = 0; i < 1100; i++) {
      assert.equal(await get(server, { Range: `bytes=${1000 + i}-${2000 + i}` }), 200,
        `continuation #${i + 1} was rate limited`);
    }
    // The route's own budget (400 fresh starts) is untouched by all of that —
    // a bare request and a probe from byte 0 both count as a fresh start.
    for (let i = 0; i < 400; i++) {
      const headers = i % 2 ? { Range: 'bytes=0-0' } : {};
      assert.equal(await get(server, headers), 200, `fresh start #${i + 1} should pass`);
    }
    assert.equal(await get(server), 429, 'the 401st fresh start must be limited');
    assert.equal(await get(server, { Range: 'bytes=0-1048575' }), 429, 'a from-zero range is a fresh start too');
    // Limited for fresh starts, yet a resume of an in-flight transfer still works.
    assert.equal(await get(server, { Range: 'bytes=5000-6000' }), 200);
    // Exhausting the installer budget never locks the user out of the rest of
    // the API, and a ranged request elsewhere is not exempt (it merely fits
    // inside the untouched global budget here).
    assert.equal(await get(server, {}, '/api/other'), 200);
    assert.equal(await get(server, { Range: 'bytes=5000-6000' }, '/api/other'), 200);
  } finally {
    server.close();
  }
});
