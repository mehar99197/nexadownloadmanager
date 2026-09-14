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
const { downloadLimiter } = require('../src/middleware/rateLimiter');

function serve() {
  const app = express();
  app.get('/download/:os', downloadLimiter, (req, res) => res.status(200).send('ok'));
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function get(server, headers = {}) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/download/windows`, { headers });
  await res.text();
  return res.status;
}

// One test, because downloadLimiter is a module-level singleton with an
// in-memory store keyed by client IP: every server here shares one budget.
test('only fresh starts consume the download budget; ranged continuations never do', async () => {
  const server = await serve();
  try {
    for (let i = 0; i < 60; i++) {
      assert.equal(await get(server, { Range: `bytes=${1000 + i}-${2000 + i}` }), 200,
        `continuation #${i + 1} was rate limited`);
    }
    // Sixty continuations later the full budget of 30 fresh starts remains —
    // a bare request and a probe from byte 0 both count as a fresh start.
    for (let i = 0; i < 30; i++) {
      const headers = i % 2 ? { Range: 'bytes=0-0' } : {};
      assert.equal(await get(server, headers), 200, `fresh start #${i + 1} should pass`);
    }
    assert.equal(await get(server), 429, 'the 31st fresh start must be limited');
    assert.equal(await get(server, { Range: 'bytes=0-1048575' }), 429, 'a from-zero range is a fresh start too');
    // Limited for fresh starts, yet a resume of an in-flight transfer still works.
    assert.equal(await get(server, { Range: 'bytes=5000-6000' }), 200);
  } finally {
    server.close();
  }
});
