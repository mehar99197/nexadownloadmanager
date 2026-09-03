'use strict';

const router = require('express').Router();

const config = require('../config/env');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { downloadLimiter } = require('../middleware/rateLimiter');
const { ok, fail } = require('../utils/respond');
const { buildFeed, releaseUrlFor, signFeed } = require('../utils/releaseFeed');
const licenseKeys = require('../config/licenseKeys');
const { artifactFor, sendFile } = require('../utils/releaseFiles');
const { downloadOsSchema, feedQuerySchema } = require('../schemas/release.schema');
const Release = require('../models/Release');

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
 * The counter is only bumped for a fresh download (no Range header, or a range
 * starting at 0) — otherwise every resumed chunk would inflate the total.
 */
router.get(
  '/download/:os', downloadLimiter, validate(downloadOsSchema),
  asyncHandler(async (req, res) => {
    const { os } = req.params;
    const release = await Release.findLatest();
    if (!release) return fail(res, 'NO_RELEASE', `No ${os} release available`, 404);

    const artifact = artifactFor(release, os);
    if (artifact) {
      const range = req.headers.range;
      const isFreshStart = !range || /^bytes=0-/.test(String(range).trim());
      if (isFreshStart) await Release.incrementDownloadCount(release.id);
      const sent = sendFile(req, res, artifact);
      // sendFile returns null when the row points at a file that is gone.
      if (sent === null) {
        return fail(res, 'NO_RELEASE', `The ${os} installer is missing from storage`, 404);
      }
      return sent;
    }

    const url = releaseUrlFor(release, os);
    if (!url) return fail(res, 'NO_RELEASE', `No ${os} release available`, 404);
    await Release.incrementDownloadCount(release.id);
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
