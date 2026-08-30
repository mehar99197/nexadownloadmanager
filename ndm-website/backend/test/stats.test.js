'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { publicStats } = require('../src/utils/stats');

test('publicStats passes figures at or above the floor through unchanged', () => {
  assert.deepEqual(
    publicStats({ users: 120, downloads: 5000 }, { minUsers: 50, minDownloads: 100 }),
    { users: 120, downloads: 5000 }
  );
  assert.deepEqual(
    publicStats({ users: 50, downloads: 100 }, { minUsers: 50, minDownloads: 100 }),
    { users: 50, downloads: 100 }
  );
});

test('publicStats omits (never rounds up) a figure below the floor, independently per field', () => {
  assert.deepEqual(
    publicStats({ users: 7, downloads: 2 }, { minUsers: 50, minDownloads: 100 }), {}
  );
  assert.deepEqual(
    publicStats({ users: 7, downloads: 900 }, { minUsers: 50, minDownloads: 100 }), { downloads: 900 }
  );
  assert.deepEqual(
    publicStats({ users: 70, downloads: 9 }, { minUsers: 50, minDownloads: 100 }), { users: 70 }
  );
});

test('publicStats: no floor shows everything; bad input is dropped', () => {
  assert.deepEqual(publicStats({ users: 1, downloads: 0 }), { users: 1, downloads: 0 });
  assert.deepEqual(publicStats({ users: 'x', downloads: null }), {});
  assert.deepEqual(publicStats({ users: 3, downloads: 3 }, { minUsers: -5, minDownloads: 'abc' }), { users: 3, downloads: 3 });
});
