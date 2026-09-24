/**
 * Emit a static HTML file per public route after `vite build`.
 *
 * Why: the site is a client-rendered SPA, so every URL serves the same
 * index.html with the same <title> and Open Graph tags. Search engines run our
 * JS and eventually see the right values, but social crawlers (Slack, X,
 * Facebook, WhatsApp, Discord) do not — every shared link would show the
 * generic homepage card.
 *
 * This writes dist/<route>/index.html with that route's title, description,
 * canonical and OG/Twitter tags baked in. The React app still hydrates and
 * takes over; nginx's `try_files $uri $uri/ /index.html` serves these first.
 *
 * Run automatically by `npm run build`.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const SITE_NAME = 'Nexa Download Manager';
const SITE_URL = (process.env.VITE_SITE_URL || 'https://nexadownloadmanager.com').replace(/\/$/, '');

// Public routes only: anything behind auth must not be indexed or shared.
// [route, title, description, options?] — `{ noindex: true }` serves the page
// but keeps it out of search results (a page that is live but not ready).
const ROUTES = [
  ['/', null, 'A free, open desktop download manager for Windows and Linux. Multi-connection HTTP, HLS/DASH streams, YouTube via yt-dlp, BitTorrent and cloud links in one queue.'],
  ['/download', 'Download', 'Download Nexa Download Manager for Windows or Linux, with SHA-256 checksums and the browser extension.'],
  ['/pricing', 'Pricing', 'Nexa is free to use. Pro removes the 3-download limit and adds AI renaming — $5/month or $45/year, with a 7-day trial and no card required.'],
  ['/compare', 'Nexa vs IDM vs FDM', 'An honest feature comparison of Nexa, Internet Download Manager, Free Download Manager and JDownloader.'],
  ['/features', 'Features', 'In-depth guides to segmented acceleration, the HLS/DASH video grabber, YouTube via yt-dlp, BitTorrent, the browser extension, scheduling and the phone dashboard.'],
  ['/features/acceleration', 'Segmented acceleration', 'How Nexa splits a file across up to 32 connections, steals the tail of the slowest segment, and resumes exactly where it stopped.'],
  ['/features/video-grabber', 'Video grabber', 'How Nexa finds the HLS or DASH stream behind a web player, fetches its segments in parallel and muxes them into a single MP4.'],
  ['/features/youtube-sites', 'YouTube & 1000+ sites', 'Nexa drives yt-dlp: quality picker, playlists, subtitles, and an updater for when a site changes.'],
  ['/features/bittorrent', 'BitTorrent', 'Magnets and .torrent files in the same queue as everything else, on a real libtorrent engine with DHT, PEX and seed-ratio control.'],
  ['/features/browser-extension', 'Browser extension', 'The local bridge for Chrome, Edge, Brave and Firefox, every permission explained, and how to install it today.'],
  ['/features/scheduler', 'Scheduler & speed limits', 'Start downloads at a chosen time, cap bandwidth globally or per download, and shut the machine down when the queue is empty.'],
  ['/features/remote-dashboard', 'Remote dashboard', 'Watch and control the Nexa queue from your phone, behind an access token and TLS.'],
  ['/benchmarks', 'Benchmarks', 'Measured download throughput at 1, 4, 8 and 16 concurrent connections against two real hosts, plus Nexa end to end — with the method and the raw spread.'],
  ['/tutorials', 'Tutorials', 'Video guides planned for Nexa Download Manager. None are recorded yet; every topic has a written guide today.', { noindex: true }],
  ['/security', 'Security & privacy', 'Exactly what Nexa sends, what it never sends, and what every browser-extension permission is for.'],
  ['/faq', 'FAQ', 'Answers about pricing, supported systems, YouTube downloads, safety, refunds and where your files are saved.'],
  ['/about', 'About', 'Who builds Nexa Download Manager, why it exists, and what we will and will not do with your data.'],
  ['/changelog', 'Changelog', 'What changed in each release of Nexa Download Manager.'],
  ['/reviews', 'Reviews', 'What people say about Nexa Download Manager.'],
  ['/contact', 'Contact', 'Get in touch about Nexa Download Manager, report a bug, or register interest in a macOS build.'],
  ['/terms', 'Terms of Service', 'The terms that apply to using Nexa Download Manager and its paid plans.'],
  ['/privacy', 'Privacy Policy', 'Exactly what Nexa stores, what the browser extension can access and why, and what never leaves your computer.'],
  ['/docs', 'Docs', 'Guides for installing Nexa, setting up the browser extension, downloading from YouTube and courses, torrents and the phone dashboard.'],
  ['/docs/install', 'Install', 'Install Nexa Download Manager on Windows or Debian/Ubuntu, and what ships bundled.'],
  ['/docs/extension', 'Browser extension', 'Install the Nexa extension in Chrome, Edge, Brave or Firefox, and fix "engine unavailable".'],
  ['/docs/youtube', 'Downloading from YouTube', 'Pick a quality, grab whole playlists, and fix "authentication required (HTTP 403)".'],
  ['/docs/courses', 'Downloading courses', 'Download enrolled Udemy and Coursera courses with the Nexa browser extension.'],
  ['/docs/torrents', 'Torrents', 'Magnet links, .torrent files, seeding ratio and speed limits in Nexa.'],
  ['/docs/remote', 'Phone dashboard', 'Control your downloads from a phone on the same network, and what TLS is required.'],
  ['/docs/license', 'Signing in & seats', 'Sign in to Nexa with your account, how seats work, manual license keys, and what happens offline.'],
  ['/login', 'Sign in', 'Sign in to your Nexa account.'],
  ['/register', 'Create an account', 'Create a Nexa account and start a 7-day Pro trial — no card required.'],
];

const escape = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const template = readFileSync(join(dist, 'index.html'), 'utf8');

// Replace the CONTENT of a tag matched by attribute, leaving the rest intact.
function setContent(html, matcher, value) {
  const re = new RegExp(`(<meta[^>]*${matcher}[^>]*content=")([^"]*)(")`, 'i');
  if (!re.test(html)) return html;
  return html.replace(re, `$1${escape(value)}$3`);
}

let written = 0;
for (const [route, title, description, options = {}] of ROUTES) {
  const fullTitle = title ? `${title} · ${SITE_NAME}` : SITE_NAME;
  const canonical = `${SITE_URL}${route === '/' ? '/' : route}`;

  let html = template;
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${escape(fullTitle)}</title>`);
  html = html.replace(
    /(<link rel="canonical" href=")([^"]*)(")/i,
    `$1${escape(canonical)}$3`
  );
  html = setContent(html, 'name="description"', description);
  html = setContent(html, 'property="og:title"', fullTitle);
  html = setContent(html, 'property="og:description"', description);
  html = setContent(html, 'property="og:url"', canonical);
  html = setContent(html, 'name="twitter:title"', fullTitle);
  html = setContent(html, 'name="twitter:description"', description);
  if (options.noindex) {
    html = html.replace('</head>', '    <meta name="robots" content="noindex, follow" />\n  </head>');
  }

  // "/" is dist/index.html itself; everything else gets its own directory.
  const target = route === '/' ? join(dist, 'index.html') : join(dist, route, 'index.html');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, html);
  written += 1;
}
console.log(`prerender: wrote ${written} route shell(s) with per-page metadata`);
