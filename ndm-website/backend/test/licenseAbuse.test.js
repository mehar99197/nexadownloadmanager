'use strict';

/**
 * Key-sharing detection thresholds.
 *
 * These decide whether a paying customer shows up in an admin review queue, so
 * both directions matter: missing a leaked key costs a little revenue, but
 * flagging an honest customer who replaced a laptop costs trust. The tests
 * below pin both edges deliberately.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assessSharing, thresholds, SHARING_WINDOW_DAYS,
} = require('../src/utils/licenseAbuse');

test('a normal single-seat licence is not flagged', () => {
  const r = assessSharing({ seats: 1, distinctDevices: 1, newDevicesInWindow: 1 });
  assert.equal(r.level, 'ok');
  assert.equal(r.reason, null);
});

test('ordinary hardware churn on one seat stays clear', () => {
  // A reinstall, a replaced network card, a new laptop over a couple of years.
  // Every one of these changes the fingerprint, and none of them is piracy.
  for (const devices of [2, 3, 4, 5, 6]) {
    const r = assessSharing({ seats: 1, distinctDevices: devices, newDevicesInWindow: 1 });
    assert.equal(r.level, 'ok', `${devices} devices over time should not flag`);
  }
});

test('a clearly leaked key is flagged as suspected', () => {
  const r = assessSharing({ seats: 1, distinctDevices: 200, newDevicesInWindow: 40 });
  assert.equal(r.level, 'suspected');
  assert.match(r.reason, /200 distinct devices/);
});

test('the middle ground is a watch, not an accusation', () => {
  const limits = thresholds(1);
  const r = assessSharing({ seats: 1, distinctDevices: limits.watch, newDevicesInWindow: 1 });
  assert.equal(r.level, 'watch');
});

test('a burst of new devices is suspected even before the all-time count is', () => {
  // A key published this week: the all-time count has not caught up yet, and
  // waiting for it would just give the leak longer to spread.
  const limits = thresholds(1);
  const burst = limits.burst;
  assert.ok(burst < limits.suspected, 'the burst rule must be able to fire first');
  const r = assessSharing({ seats: 1, distinctDevices: burst, newDevicesInWindow: burst });
  assert.equal(r.level, 'suspected');
  assert.match(r.reason, new RegExp(`${SHARING_WINDOW_DAYS} days`));
});

test('a long-standing licence is not condemned by old devices alone', () => {
  // Same device count as the burst case, but accumulated slowly. This is the
  // false positive the burst rule must not create.
  const limits = thresholds(1);
  const r = assessSharing({
    seats: 1, distinctDevices: limits.burst, newDevicesInWindow: 1,
  });
  assert.notEqual(r.level, 'suspected');
});

test('a Team licence is judged by its own seat count, not a Pro licence\'s', () => {
  // Five seats legitimately means five machines, plus churn on each.
  const team = assessSharing({ seats: 5, distinctDevices: 12, newDevicesInWindow: 5 });
  assert.equal(team.level, 'ok');

  // The same numbers on a single seat are not fine.
  const solo = assessSharing({ seats: 1, distinctDevices: 12, newDevicesInWindow: 5 });
  assert.notEqual(solo.level, 'ok');
});

test('thresholds scale with seats', () => {
  const one = thresholds(1);
  const five = thresholds(5);
  assert.ok(five.watch > one.watch);
  assert.ok(five.suspected > one.suspected);
  assert.ok(five.burst > one.burst);
});

test('missing, zero and nonsense input never flags anyone', () => {
  // This runs on the activation path; bad input must fail safe, not accuse.
  for (const input of [{}, { seats: 0, distinctDevices: 0 },
                       { seats: null, distinctDevices: null, newDevicesInWindow: null },
                       { seats: 'x', distinctDevices: 'y', newDevicesInWindow: 'z' },
                       { seats: 1, distinctDevices: -5, newDevicesInWindow: -5 }]) {
    assert.equal(assessSharing(input).level, 'ok', JSON.stringify(input));
  }
});

test('the verdict carries the numbers it judged on', () => {
  const r = assessSharing({ seats: 2, distinctDevices: 9, newDevicesInWindow: 2 });
  assert.equal(r.distinctDevices, 9);
  assert.equal(r.seats, 2);
  assert.ok(r.limits.watch > 0 && r.limits.suspected > r.limits.watch);
});

test('escalation is monotonic — more devices never lowers the level', () => {
  const rank = { ok: 0, watch: 1, suspected: 2 };
  let previous = 0;
  for (let devices = 0; devices <= 60; devices += 1) {
    const level = rank[assessSharing({ seats: 1, distinctDevices: devices, newDevicesInWindow: 0 }).level];
    assert.ok(level >= previous, `level dropped at ${devices} devices`);
    previous = level;
  }
});

// --- auto-suspend: a much higher bar than flagging ---------------------------
//
// Flagging asks "worth a look?" and should stay sensitive. Suspending cuts off
// somebody's paid software without a human, so it has to stay rare. Wiring the
// two to the same number is the mistake that turns a useful signal into support
// tickets, so the gap between them is asserted here directly.

const { autoSuspendReason } = require('../src/utils/licenseAbuse');

test('nothing a normal customer does triggers an automatic suspension', () => {
  for (const devices of [1, 2, 5, 10, 15, 20]) {
    assert.equal(
      autoSuspendReason({ seats: 1, distinctDevices: devices, newDevicesInWindow: 2 }),
      null,
      `${devices} devices over time must not auto-suspend`
    );
  }
});

test('a licence can be flagged without being suspended', () => {
  // The whole middle band exists for a human to look at.
  const limits = thresholds(1);
  const devices = limits.suspected;
  assert.equal(assessSharing({ seats: 1, distinctDevices: devices }).level, 'suspected');
  assert.equal(autoSuspendReason({ seats: 1, distinctDevices: devices }), null,
    'suspected must not by itself mean suspended');
});

test('the suspend bar is well above the flag bar', () => {
  const limits = thresholds(1);
  assert.ok(limits.suspend > limits.suspected * 2,
    `suspend (${limits.suspend}) should be far above suspected (${limits.suspected})`);
  assert.ok(limits.suspendBurst > limits.burst * 2);
});

test('an unmistakably leaked key does auto-suspend', () => {
  const reason = autoSuspendReason({ seats: 1, distinctDevices: 200, newDevicesInWindow: 50 });
  assert.ok(reason, 'a key on 200 machines must be caught');
  assert.match(reason, /200 distinct devices/);
});

test('a published key is caught by burst before its all-time count catches up', () => {
  const limits = thresholds(1);
  const reason = autoSuspendReason({
    seats: 1, distinctDevices: limits.suspendBurst, newDevicesInWindow: limits.suspendBurst,
  });
  assert.ok(reason);
  assert.match(reason, /new devices/);
});

test('a Team licence is judged against its own seat count', () => {
  // 40 devices on 5 seats is 8 per seat — a lot, but not the 30-per-seat bar.
  assert.equal(autoSuspendReason({ seats: 5, distinctDevices: 40 }), null);
  // The same 40 on a single seat is not explicable.
  assert.ok(autoSuspendReason({ seats: 1, distinctDevices: 40 }));
});

test('missing or nonsense input never suspends anyone', () => {
  for (const input of [{}, { seats: 0, distinctDevices: 0 },
                       { seats: null, distinctDevices: null },
                       { seats: 'x', distinctDevices: 'y', newDevicesInWindow: 'z' },
                       { seats: 1, distinctDevices: -100 }]) {
    assert.equal(autoSuspendReason(input), null, JSON.stringify(input));
  }
});

test('suspension implies flagging — the two never disagree in direction', () => {
  // If it is severe enough to suspend, assessSharing must already call it
  // suspected. A licence that was suspended but reads 'ok' would be invisible
  // in the review queue.
  for (const devices of [50, 100, 500]) {
    assert.ok(autoSuspendReason({ seats: 1, distinctDevices: devices }));
    assert.equal(assessSharing({ seats: 1, distinctDevices: devices }).level, 'suspected');
  }
});
