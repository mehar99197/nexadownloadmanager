'use strict';
/** utils/loginLockout.js — the pure parts (the SQL is covered by the integration suite). */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config/env');
const { isLocked, lockMinutesForLevel } = require('../src/utils/loginLockout');

test('locks escalate 15 → 30 → 60 and stay capped at an hour', () => {
  config.LOGIN_LOCKOUT_MINUTES = 15;
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(lockMinutesForLevel), [15, 30, 60, 60, 60, 60]);
});

test('isLocked reads locked_until against the clock', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');
  assert.equal(isLocked(null, now), false);
  assert.equal(isLocked({ locked_until: null }, now), false);
  assert.equal(isLocked({ locked_until: '2026-09-15T12:14:59Z' }, now), true);
  assert.equal(isLocked({ locked_until: '2026-09-15T11:59:59Z' }, now), false);
  assert.equal(isLocked({ locked_until: 'not a date' }, now), false);
});
