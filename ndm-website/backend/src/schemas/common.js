'use strict';

const { z } = require('zod');

/**
 * An https:// URL, and nothing else.
 *
 * `z.string().url()` accepts every scheme the WHATWG parser understands —
 * `javascript:`, `data:`, `file:` and plain `http:` all pass. Every URL an
 * admin stores here is eventually either fetched by the desktop app or opened
 * in somebody's browser, so the scheme is pinned where the value enters rather
 * than at each of the places that later use it.
 *
 * Two copies of this had already grown apart: ad links were pinned, release
 * artifact URLs were not, so an installer could be stored as `http://` (a
 * plaintext download the site's /download/:os redirect would happily send a
 * visitor to) or as `javascript:` (stored XSS in the admin panel).
 */
// 500 is not arbitrary: releases.windows_url / linux_url and ads.image_url /
// target_url are all VARCHAR(500), and a value that passes validation only to
// overflow its column turns a rejected form into a 500 after the fact.
const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    try { return new URL(value).protocol === 'https:'; } catch { return false; }
  }, 'Must be an https:// URL');

module.exports = { httpsUrl };
