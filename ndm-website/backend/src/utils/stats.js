'use strict';

/**
 * Public statistics for the home page strip.
 *
 * The numbers are real (users table + summed download counter), and that is
 * exactly the problem while the product is young: "7 users" is honest but
 * reads as a warning. Below the configured floor a figure is simply omitted
 * — the site hides that tile — rather than rounded up or invented. Nothing
 * here ever produces a number larger than the true one.
 */
function asCount(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return Number(value);
}

function publicStats({ users, downloads }, { minUsers = 0, minDownloads = 0 } = {}) {
  const out = {};
  const u = asCount(users);
  const d = asCount(downloads);
  if (Number.isFinite(u) && u >= Math.max(0, Number(minUsers) || 0)) out.users = u;
  if (Number.isFinite(d) && d >= Math.max(0, Number(minDownloads) || 0)) out.downloads = d;
  return out;
}

module.exports = { publicStats };
