import api, { unwrap } from './client';

// A registration that started from /register?trial=1 can't start the trial
// until the user is logged in (register never returns a token, and email
// verification may sit in between). Remember the intent locally and let the
// first authenticated page (Dashboard) redeem it.
const PENDING_KEY = 'ndm_pending_trial';

export function markPendingTrial() {
  try {
    localStorage.setItem(PENDING_KEY, '1');
  } catch {
    // storage unavailable — the user can still start the trial from Pricing/Dashboard
  }
}

export function hasPendingTrial() {
  try {
    return localStorage.getItem(PENDING_KEY) === '1';
  } catch {
    return false;
  }
}

export function clearPendingTrial() {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    // ignore
  }
}

/**
 * POST /subscription/start-trial.
 * Resolves `{ started: true, data }` on success, `{ started: false, unavailable: true }`
 * when the account already used its trial (TRIAL_UNAVAILABLE), and rethrows
 * anything else (network, 401, ...).
 */
export async function startTrial() {
  try {
    const data = unwrap(await api.post('/subscription/start-trial'));
    return { started: true, data };
  } catch (err) {
    if (err?.response?.data?.error?.code === 'TRIAL_UNAVAILABLE') {
      return { started: false, unavailable: true };
    }
    throw err;
  }
}

/** Whole days left on a trial (never negative, never NaN). */
export function trialDaysLeft(trialEndsAt) {
  if (!trialEndsAt) return 0;
  const end = new Date(trialEndsAt).getTime();
  // An unparseable date must read as "no trial", not render "NaN days left".
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, Math.ceil((end - Date.now()) / 86_400_000));
}
