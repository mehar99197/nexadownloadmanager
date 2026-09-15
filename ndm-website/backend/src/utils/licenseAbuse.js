'use strict';

// Detecting a leaked licence key.
//
// Why this exists at all, given seats are already enforced: seat limits cap
// how many machines run the app *at the same time*, not how many people have
// the key. A key posted on a forum and used by five hundred people still shows
// only N concurrent seats — everyone takes a turn — so seat enforcement alone
// never notices. What it does leave behind is a `license_activations` row per
// distinct machine, and those rows are never deleted (releaseSeat only clears
// the lease). Five hundred device rows against a one-seat licence is not
// ambiguous.
//
// This is the one anti-piracy control a cracked client cannot touch: it runs
// entirely on the server, from data the client cannot choose not to send —
// asking for a seat IS the signal.
//
// Kept pure (no DB, no config) so the thresholds can be tested directly.

/**
 * How many distinct devices a licence may accumulate before it looks shared.
 *
 * Deliberately generous, because a legitimate customer changes fingerprints
 * more often than you would think: a reinstall, a replaced network card, a
 * reimaged laptop, a VM rebuilt from a template. Flagging those as piracy
 * costs a paying customer; missing a few leaked keys costs very little, since
 * the seat limit is still doing the actual enforcement underneath.
 *
 * Expressed as a multiple of the seat count plus a flat allowance, so a 5-seat
 * Team licence is not judged by a 1-seat Pro licence's yardstick.
 */
const DEVICES_PER_SEAT_BEFORE_WATCH = 4;
const DEVICES_PER_SEAT_BEFORE_SUSPECTED = 10;
// Added on top so a 1-seat licence gets room for ordinary hardware churn
// before any of this triggers at all.
const FLAT_DEVICE_ALLOWANCE = 3;

// A burst matters more than a slow accumulation: eight new machines in a week
// on a one-seat licence is a leak, while eight over three years is a long
// customer relationship.
const NEW_DEVICES_PER_SEAT_IN_WINDOW = 5;
const SHARING_WINDOW_DAYS = 7;

/**
 * The bar for suspending a licence *without a human looking first*.
 *
 * Deliberately far above the `suspected` threshold, not equal to it. Flagging
 * something for review and cutting off a paying customer are different acts and
 * deserve different evidence: `suspected` only has to be worth a glance, while
 * this has to be a number no honest history produces. Thirty-three distinct
 * machines on a one-seat licence is not a user who reinstalls a lot.
 *
 * Everything about the suspension is recoverable — it presents as `seat_limit`,
 * the key survives, and an admin clears it in one click — but "recoverable"
 * is not a licence to be trigger-happy with somebody's paid software.
 */
const DEVICES_PER_SEAT_BEFORE_SUSPEND = 30;
const NEW_DEVICES_PER_SEAT_BEFORE_SUSPEND = 20;

function thresholds(seats) {
  const n = Math.max(1, Number(seats) || 1);
  return {
    watch: n * DEVICES_PER_SEAT_BEFORE_WATCH + FLAT_DEVICE_ALLOWANCE,
    suspected: n * DEVICES_PER_SEAT_BEFORE_SUSPECTED + FLAT_DEVICE_ALLOWANCE,
    burst: n * NEW_DEVICES_PER_SEAT_IN_WINDOW + FLAT_DEVICE_ALLOWANCE,
    suspend: n * DEVICES_PER_SEAT_BEFORE_SUSPEND + FLAT_DEVICE_ALLOWANCE,
    suspendBurst: n * NEW_DEVICES_PER_SEAT_BEFORE_SUSPEND + FLAT_DEVICE_ALLOWANCE,
  };
}

/**
 * Judge how shared a licence looks.
 *
 * @param {object} input
 * @param {number} input.seats             seats the licence includes
 * @param {number} input.distinctDevices   activation rows, all time
 * @param {number} input.newDevicesInWindow rows first seen in the last window
 * @returns {{level: 'ok'|'watch'|'suspected', reason: string|null,
 *            distinctDevices: number, seats: number, limits: object}}
 *
 * `watch` means "show this to an admin". `suspected` means "this is very
 * probably leaked". Neither suspends anything on its own — see the note in
 * routes/license.js about why acting automatically is the wrong default.
 */
function assessSharing({ seats = 1, distinctDevices = 0, newDevicesInWindow = 0 } = {}) {
  const limits = thresholds(seats);
  const devices = Math.max(0, Number(distinctDevices) || 0);
  const burst = Math.max(0, Number(newDevicesInWindow) || 0);
  const base = {
    distinctDevices: devices,
    seats: Math.max(1, Number(seats) || 1),
    limits,
  };

  if (devices >= limits.suspected) {
    return {
      ...base,
      level: 'suspected',
      reason: `${devices} distinct devices on a ${base.seats}-seat licence`,
    };
  }
  // A burst is treated as `suspected` even below the all-time threshold: a new
  // key that picks up thirty machines in its first week was published
  // somewhere, and waiting for the all-time count to catch up just gives it
  // longer to spread.
  if (burst >= limits.burst && burst >= devices) {
    return {
      ...base,
      level: 'suspected',
      reason: `${burst} new devices in ${SHARING_WINDOW_DAYS} days on a ${base.seats}-seat licence`,
    };
  }
  if (devices >= limits.watch) {
    return {
      ...base,
      level: 'watch',
      reason: `${devices} distinct devices on a ${base.seats}-seat licence`,
    };
  }
  return { ...base, level: 'ok', reason: null };
}

/**
 * Whether the evidence is strong enough to suspend without a human first.
 *
 * Separate from assessSharing() on purpose: that answers "is this worth
 * looking at", and the answer to that should stay sensitive. This answers "is
 * this beyond argument", and the answer to that should stay rare. Wiring the
 * two together — suspending everything flagged — is exactly the mistake that
 * turns a useful signal into support tickets from paying customers.
 *
 * Returns a reason string when it applies, or null.
 */
function autoSuspendReason({ seats = 1, distinctDevices = 0, newDevicesInWindow = 0 } = {}) {
  const limits = thresholds(seats);
  const devices = Math.max(0, Number(distinctDevices) || 0);
  const burst = Math.max(0, Number(newDevicesInWindow) || 0);
  const n = Math.max(1, Number(seats) || 1);

  if (devices >= limits.suspend)
    return `${devices} distinct devices on a ${n}-seat licence`;
  if (burst >= limits.suspendBurst)
    return `${burst} new devices in ${SHARING_WINDOW_DAYS} days on a ${n}-seat licence`;
  return null;
}

module.exports = {
  assessSharing,
  autoSuspendReason,
  thresholds,
  DEVICES_PER_SEAT_BEFORE_SUSPEND,
  NEW_DEVICES_PER_SEAT_BEFORE_SUSPEND,
  SHARING_WINDOW_DAYS,
  DEVICES_PER_SEAT_BEFORE_WATCH,
  DEVICES_PER_SEAT_BEFORE_SUSPECTED,
  FLAT_DEVICE_ALLOWANCE,
  NEW_DEVICES_PER_SEAT_IN_WINDOW,
};
