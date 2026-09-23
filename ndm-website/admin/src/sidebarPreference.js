/**
 * Whether the sidebar is folded to a rail of icons on a desktop.
 *
 * The reader's choice, kept in this browser. It is read synchronously, so the
 * panel and its boot outline (PanelSkeleton) are drawn at the chosen width
 * from their first frame, instead of opening wide and then folding. Storage
 * that refuses — a private window, blocked site data — leaves the sidebar
 * open, and a choice made then still holds for the visit.
 */
const KEY = 'nexa-admin-sidebar';

export function readRail() {
  try {
    return window.localStorage.getItem(KEY) === 'rail';
  } catch {
    return false;
  }
}

export function keepRail(rail) {
  try {
    window.localStorage.setItem(KEY, rail ? 'rail' : 'open');
  } catch {
    // Not kept past this visit; nothing else depends on it.
  }
}
