'use strict';

const router = require('express').Router();

const config = require('../config/env');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { downloadLimiter } = require('../middleware/rateLimiter');
const { ok, fail } = require('../utils/respond');
const { buildFeed, releaseUrlFor, signFeed } = require('../utils/releaseFeed');
const licenseKeys = require('../config/licenseKeys');
const { artifactFor, artifactOnDisk, sendFile } = require('../utils/releaseFiles');
const { shouldCountDownload } = require('../utils/downloadCounter');
const { downloadOsSchema, feedQuerySchema } = require('../schemas/release.schema');
const Release = require('../models/Release');

/**
 * Is THIS request a download, for the counter's purposes?
 *
 * utils/downloadCounter.js holds the two rules (a fresh start only — no
 * Range, or one from byte 0 that is not the app's one-byte size probe — and
 * one address per release per platform per window) and records the decision,
 * so it is asked exactly once per request. Express routes a HEAD to the GET
 * handler, and a HEAD has no Range header, so without the first line every
 * size probe would look like a fresh start.
 */
function countsAsDownload(req, releaseId, os) {
  if (req.method === 'HEAD') return false;
  return shouldCountDownload({ ip: req.ip, releaseId, os, range: req.headers.range });
}

router.get(
  '/latest',
  asyncHandler(async (req, res) => {
    const release = await Release.findLatest();
    if (!release) return fail(res, 'NO_RELEASE', 'No release available', 404);
    return ok(res, {
      version: release.version, windowsUrl: release.windows_url,
      linuxUrl: release.linux_url, changelog: release.changelog,
      windowsSha256: release.windows_sha256 || null,
      linuxSha256: release.linux_sha256 || null,
      // Sizes let the site show "Download for Windows (86.4 MB)" without a HEAD.
      windowsSize: Number(release.windows_size) || null,
      linuxSize: Number(release.linux_size) || null,
      hasWindowsFile: Boolean(release.windows_file),
      hasLinuxFile: Boolean(release.linux_file),
      downloadCount: Number(release.download_count) || 0,
      publishedAt: release.published_at,
    });
  })
);

/**
 * Public download for the latest build.
 *
 * An uploaded installer is streamed straight from disk with byte-range support
 * so a dropped transfer resumes instead of restarting. A release that only has
 * a legacy external URL still 302s, which is how everything published before
 * uploads existed keeps working.
 *
 * The counter records that a download STARTED (see utils/downloadCounter.js
 * for why completion is not observable) and only when one did: not for a
 * resume, not for the same address retrying inside the window, not for a HEAD,
 * and not for a release whose file turns out to be missing — the 404 is
 * decided first, so a broken release no longer counts every attempt to fetch
 * it. Both paths, the uploaded file and the legacy redirect, go through the
 * same decision. The increment lands before the first byte goes out, so a
 * caller that reads /latest the moment the transfer ends sees it.
 */
router.get(
  '/download/:os', downloadLimiter, validate(downloadOsSchema),
  asyncHandler(async (req, res) => {
    const { os } = req.params;
    const release = await Release.findLatest();
    if (!release) return fail(res, 'NO_RELEASE', `No ${os} release available`, 404);

    const artifact = artifactFor(release, os);
    if (artifact) {
      if (!artifactOnDisk(artifact))
        return fail(res, 'NO_RELEASE', `The ${os} installer is missing from storage`, 404);
      if (countsAsDownload(req, release.id, os)) await Release.incrementDownloadCount(release.id);
      const sent = sendFile(req, res, artifact);
      // The file can still vanish between the check above and the open; say
      // so rather than leave the request hanging.
      if (sent === null)
        return fail(res, 'NO_RELEASE', `The ${os} installer is missing from storage`, 404);
      return sent;
    }

    const url = releaseUrlFor(release, os);
    if (!url) return fail(res, 'NO_RELEASE', `No ${os} release available`, 404);
    if (countsAsDownload(req, release.id, os)) await Release.incrementDownloadCount(release.id);
    return res.redirect(302, url);
  })
);

// Every published version, newest first, for the changelog page. No download
// URLs here: those always go through /download/:os so the counter stays honest.
router.get(
  '/history',
  asyncHandler(async (req, res) => {
    const rows = await Release.listAll();
    return ok(res, {
      releases: rows.map((r) => ({
        version: r.version,
        changelog: r.changelog || '',
        publishedAt: r.published_at,
        downloadCount: Number(r.download_count) || 0,
        isLatest: Boolean(Number(r.is_latest)),
        hasWindows: Boolean(r.windows_file || (r.windows_url && String(r.windows_url).trim())),
        hasLinux: Boolean(r.linux_file || (r.linux_url && String(r.linux_url).trim())),
      })),
    });
  })
);

// Desktop-app update feed. LITERAL body (no envelope) — see CONTRACT.md §2.
router.get(
  '/feed', validate(feedQuerySchema),
  asyncHandler(async (req, res) => {
    const { os } = req.query;
    const release = await Release.findLatest();
    const feed = buildFeed(release, os, config.PUBLIC_API_URL);
    if (!feed) return res.status(404).json({ error: 'no_release' });
    res.set('Cache-Control', 'public, max-age=300');
    // Signed with the licence key, because the app executes what this points
    // at — see signFeed(). Clients from before signing existed ignore the extra
    // field; clients that expect it refuse an unsigned feed.
    return res.status(200).json(signFeed(feed, licenseKeys.privateKey));
  })
);

module.exports = router;
