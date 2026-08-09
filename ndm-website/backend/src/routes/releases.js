'use strict';

const router = require('express').Router();

const asyncHandler = require('../utils/asyncHandler');
const { ok, fail } = require('../utils/respond');
const Release = require('../models/Release');

router.get(
  '/latest',
  asyncHandler(async (req, res) => {
    const release = await Release.findLatest();
    if (!release) return fail(res, 'NO_RELEASE', 'No release available', 404);
    return ok(res, {
      version: release.version, windowsUrl: release.windows_url,
      linuxUrl: release.linux_url, changelog: release.changelog,
      publishedAt: release.published_at,
    });
  })
);

module.exports = router;
