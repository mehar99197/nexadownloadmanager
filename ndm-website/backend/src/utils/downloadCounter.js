'use strict';

/**
 * Decide whether a request to /api/releases/download/:os is a DOWNLOAD.
 *
 * WP-09 — production counted requests, not downloads. A bare
 * `Range: bytes=0-1` (two bytes) incremented the total, which went 611 → 615
 * across four requests, three of which were range probes.
 *
 * Two rules, both needed:
 *
 *  1. Only a fresh start counts — no Range header, or one beginning at byte 0.
 *     A resume is the same download continuing. This also matters for our own
 *     desktop updater, which fetches the installer through the segmented engine
 *     (up to 32 ranged connections plus work-stealing tails): without this a
 *     single 187 MB update would register as dozens of downloads.
 *
 *  2. One address counts once per release PER PLATFORM per window. A browser
 *     that starts, is cancelled and starts again is one person getting one
 *     file, and so is an antivirus scanner or a link-preview fetcher retrying.
 *     Someone who takes both the Windows and the Linux build has taken two
 *     files, so the platform is part of the key — deduplicating on the release
 *     alone would silently undercount that.
 *
 * DOCUMENTED CHOICE: the counter records "a download was STARTED", not "a
 * download completed". Completion is not observable — the client can vanish
 * mid-stream and a 187 MB transfer would otherwise take minutes to attribute —
 * so the honest thing is to count the start and say so. CONTRACT.md states
 * this, and /download's figure is labelled accordingly.
 *
 * In-memory, therefore per-process, exactly like express-rate-limit's default
 * store. Several API instances would each keep their own view and the total
 * could over-count by at most one per instance per window; that is a far
 * smaller error than the one being fixed, and it needs no new dependency.
 */

const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
// Bounded so a long-running process cannot grow this without limit.
const MAX_ENTRIES = 50_000;

const recent = new Map();

/** A Range header that starts anywhere but byte 0 is a resume, not a start. */
function isFreshStart(rangeHeader) {
  const range = String(rangeHeader || '').trim();
  if (range === '') return true;
  return /^bytes=0-/.test(range);
}

function sweep(now) {
  for (const [key, at] of recent) {
    if (now - at > DEDUPE_WINDOW_MS) recent.delete(key);
  }
}

/**
 * shouldCountDownload({ ip, releaseId, os, range }) → boolean
 *
 * Records the decision, so calling it twice for the same request would count
 * once. Call it exactly once per request, before incrementing.
 */
function shouldCountDownload({ ip, releaseId, os, range, now = Date.now() }) {
  if (!isFreshStart(range)) return false;

  const key = `${ip || 'unknown'}|${releaseId}|${os || 'any'}`;
  const last = recent.get(key);
  if (last !== undefined && now - last <= DEDUPE_WINDOW_MS) {
    // Refresh the window: someone retrying for ten minutes stays one download.
    recent.set(key, now);
    return false;
  }

  if (recent.size >= MAX_ENTRIES) sweep(now);
  recent.set(key, now);
  return true;
}

/** Test seam: forget every recorded address. */
function resetDownloadCounter() {
  recent.clear();
}

module.exports = {
  shouldCountDownload,
  isFreshStart,
  resetDownloadCounter,
  DEDUPE_WINDOW_MS,
};
