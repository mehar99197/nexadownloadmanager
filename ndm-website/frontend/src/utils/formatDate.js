/**
 * Dates the reader cannot misread.
 *
 * `toLocaleDateString()` with no options renders 7 October 2026 as "10/7/2026"
 * — which half the world reads as 10 July. Every date on this site is one a
 * customer may act on (a renewal, an expiry, a signup date), so the month is
 * always spelled out. The locale still comes from the browser, so the order of
 * day and month follows the reader's own convention.
 */

/** "7 October 2026" — for a date the reader may act on. Null when unusable. */
export function formatDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/** "7 Oct 2026" — the same date where space is tight (table cells, meta rows). */
export function formatDateShort(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default formatDate;
