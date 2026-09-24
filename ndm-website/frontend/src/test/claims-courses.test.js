import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * /docs/courses must describe what Nexa does with a course today. Each phrase
 * checked below was on the page and was false:
 *
 * - A whole course in one go. A modern Udemy lecture URL reaches yt-dlp's
 *   course extractor, which cannot read the course from Udemy's current pages
 *   (src/site/YtDlpGrabber.cpp, src/auth/AuthUtils.cpp: "Udemy course download
 *   is not supported"), and yt-dlp has no Coursera extractor at all
 *   (extension-chromium/content.js). Lectures download one at a time.
 * - A "Whole course" toggle and a quality list. The course-site panel offers
 *   "Entire course — all lectures", "This lecture only" and "Audio only (m4a)".
 * - A "login/course-access" message. The real one starts "login required".
 * - A yt-dlp updater, and a cookies.txt import in Site logins. Neither exists.
 * - Cookies "stored per domain". They are temporary files deleted on exit.
 *
 * The page also never said that course sites need Pro, which the app enforces
 * (resources/cloud_providers.json "proOnly", DownloadEngine::addDownload).
 */

// Not new URL('../pages/…', import.meta.url): Vite rewrites that literal
// pattern into a dev-server asset URL (http://localhost:5173/src/…), which
// node:fs refuses. import.meta.url itself is the real file: URL.
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../pages/docs/DocsCourses.jsx'), 'utf8');

// Roughly what a reader sees: tags dropped, entities decoded, whitespace folded.
const text = source
  .replace(/\{' '\}/g, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&rarr;/g, '→')
  .replace(/&ldquo;/g, '“')
  .replace(/&rdquo;/g, '”')
  .replace(/&mdash;/g, '—')
  .replace(/&hellip;/g, '…')
  .replace(/&apos;/g, "'")
  .replace(/\s+/g, ' ');

const description = (/description:\s*'([^']*)'/.exec(source) || [])[1] || '';

describe('/docs/courses says what Nexa does with a course', () => {
  it('does not promise a whole course in one go', () => {
    expect(text).not.toMatch(/every lecture/i);
    expect(text).not.toMatch(/enumerates/i);
    expect(text).not.toMatch(/sections numbered/i);
    expect(text).not.toMatch(/specialisation/i);
    expect(description).not.toBe('');
    expect(description).not.toMatch(/whole course/i);
    expect(text).toMatch(/does not support downloading a whole course/i);
  });

  it('names the controls that exist, not a "Whole course" toggle', () => {
    expect(text).not.toMatch(/toggle\s*“?\s*Whole course/i);
    expect(text).not.toMatch(/whole-course toggle/i);
    expect(text).not.toMatch(/Pick a quality/i);
    expect(text).not.toMatch(/right-click → Download with Nexa/);
    expect(text).toContain('Download with NDM');
    expect(text).toContain('This lecture only');
    expect(text).toContain('Entire course — all lectures');
  });

  it('drops the parallel-lectures claim and says subtitles are opt-in', () => {
    expect(text).not.toMatch(/up to your concurrency limit/i);
    expect(text).not.toMatch(/Subtitles are fetched/i);
    // SettingsDialog: "Download and embed subtitles", off unless turned on.
    expect(text).toMatch(/Subtitles are off by default/);
    expect(text).toContain('Download and embed subtitles');
  });

  it('quotes error messages the app really shows', () => {
    expect(text).not.toContain('login/course-access');
    expect(text).toContain('login required');
    expect(text).toContain('Udemy course download is not supported');
  });

  it('points at app controls that exist', () => {
    expect(text).not.toMatch(/Update yt-dlp/i);
    expect(text).not.toMatch(/Settings → Video → /);
    expect(text).toContain('Check for updates…');
    // Site logins offers a site, a browser and "Use browser login": no file import.
    expect(text).toContain('Use browser login');
    if (/Site logins/i.test(text)) expect(text).not.toMatch(/cookies\.txt/i);
  });

  it('says where course cookies really go', () => {
    expect(text).not.toMatch(/stored per domain/i);
    expect(text).toMatch(/deleted when Nexa (exits|closes)/i);
  });

  it('states that course sites need Pro or Team, and that the trial counts', () => {
    expect(text).toMatch(/Pro or Team/);
    expect(text).toContain('needs Nexa Pro');
    expect(text).toMatch(/7-day/);
    expect(description).toMatch(/Pro/);
  });
});
