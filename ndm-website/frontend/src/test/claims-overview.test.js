/**
 * The overview and detail pages, held to what the app actually does.
 *
 * Every claim below was checked against the desktop source (src/, resources/,
 * extension-chromium/) or the backend; each block names where. These read the
 * page sources rather than rendering them on purpose: several of the strings
 * are meta descriptions or prerendered <head> tags, which no rendered test
 * ever sees, and a false sentence there is just as public as one on the page.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Held in a variable on purpose: Vite rewrites a `new URL(…, import.meta.url)`
// it can see as an asset import, which under jsdom resolves to nothing.
const HERE = import.meta.url;
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, HERE)), 'utf8');

// Whitespace collapsed and the few entities JSX prose uses decoded, so a phrase
// that wraps across two source lines still matches as one sentence.
const plain = (s) =>
  s
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&rarr;/g, '→')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&times;/g, '×')
    .replace(/&amp;/g, '&')
    .replace(/\{' '\}/g, ' ')
    .replace(/\s+/g, ' ');

const FILES = {
  home: 'pages/Home.jsx',
  about: 'pages/About.jsx',
  features: 'pages/Features.jsx',
  compare: 'pages/Compare.jsx',
  changelog: 'pages/Changelog.jsx',
  tutorials: 'pages/Tutorials.jsx',
  pricing: 'pages/Pricing.jsx',
  prerender: '../scripts/prerender.mjs',
  featureShell: 'pages/features/FeatureShell.jsx',
  docsShell: 'pages/docs/DocsShell.jsx',
  acceleration: 'pages/features/FeatureAcceleration.jsx',
  scheduler: 'pages/features/FeatureScheduler.jsx',
};

const src = Object.fromEntries(Object.entries(FILES).map(([k, p]) => [k, plain(read(`../${p}`))]));

// Short failure messages: the file and the phrase, never the whole file.
const says = (key, phrase) =>
  expect(src[key].includes(phrase), `${FILES[key]} should say: ${phrase}`).toBe(true);
const doesNotSay = (key, phrase) =>
  expect(src[key].includes(phrase), `${FILES[key]} still says: ${phrase}`).toBe(false);
const nowhere = (re) => {
  for (const [key, text] of Object.entries(src)) {
    expect(text.match(re)?.[0] ?? null, `${FILES[key]} still matches ${re}`).toBeNull();
  }
};

// Free is capped at 16 connections per file and a paid plan at 32
// (src/license/LicenseManager.h Entitlements, LicenseManager.cpp
// setFeaturesForPlan, DownloadTask::preferredSegmentCount).
describe('connections per file', () => {
  it('never gives 32 without saying it is the Pro figure and that Free gets 16', () => {
    for (const [key, text] of Object.entries(src)) {
      for (const m of text.matchAll(/up to (?:32|thirty-two) connections/gi)) {
        const near = text.slice(m.index, m.index + 60);
        expect(near, FILES[key]).toMatch(/\bPro\b/);
        expect(near, FILES[key]).toMatch(/\((?:16|sixteen) on Free\)/);
      }
    }
  });

  it('labels the homepage tile as the Pro figure', () => {
    doesNotSay('home', "value: 'Up to 32'");
    says('home', "value: '32 on Pro', label: 'connections per file'");
  });
});

// DownloadTask::tryResegment: a finished connection takes the back half of the
// segment with the MOST bytes left, and only when at least 4 MB remain.
describe('dynamic re-segmentation', () => {
  it('describes taking half of the biggest range left, not the slowest segment', () => {
    nowhere(/slowest (?:segment|one)/i);
    says('featureShell', 'takes half of the biggest range left');
    says('compare', 'biggest range still in flight');
    says('compare', '4 MB or more');
    says('prerender', 're-splits the biggest range left');
  });
});

// Only DownloadTask rows are persisted and restored (DownloadEngine::loadPersisted);
// HTTP resumes only when the server honours ranges (DownloadEngine::isResumable).
describe('resuming', () => {
  it('scopes resume to direct downloads on servers that support it', () => {
    doesNotSay('home', 'Resume anywhere');
    doesNotSay('home', 'never means starting over');
    says('home', 'Direct downloads save their progress');
    says('home', 'on any server that supports resuming');
  });
});

// yt-dlp is pinned per build (.github/workflows/build.yml YTDLP_VERSION) and
// nothing in src/ updates it.
describe('yt-dlp updates', () => {
  it('says yt-dlp is updated with each Nexa release, not by an updater', () => {
    nowhere(/an updater/i);
    nowhere(/updates between releases/i);
    doesNotSay('features', 'how to update it when a site changes');
    for (const key of ['features', 'prerender', 'featureShell']) says(key, 'updated with each Nexa release');
  });
});

// Only the sites flagged in resources/cloud_providers.json go to yt-dlp
// (CloudProviders::isSiteVideoUrl) — sixteen of them, not a thousand.
describe('video sites', () => {
  it('claims no 1000+ sites anywhere', () => {
    nowhere(/1,?000\+|thousand/i);
    says('featureShell', "label: 'YouTube & video sites'");
    says('docsShell', "label: 'YouTube & video sites'");
    says('prerender', "['/features/youtube-sites', 'YouTube & video sites'");
    says('features', 'YouTube & video sites via yt-dlp');
    says('compare', "label: 'YouTube & video sites via yt-dlp'");
  });

  it('puts the quality picker where it lives: the on-video button', () => {
    doesNotSay('docsShell', "blurb: 'Quality picker,");
    says('docsShell', 'Picking a quality from the on-video button');
  });
});

// The five course sites are proOnly (cloud_providers.json, DownloadEngine::addDownload),
// and only single lectures work (YtDlpGrabber.cpp Udemy note, content.js Coursera).
describe('courses', () => {
  it('says course downloads go one lecture at a time, not whole courses, on Pro or Team', () => {
    const meta = src.prerender.match(/\['\/docs\/courses'[^\]]*\]/)[0];
    expect(meta).not.toContain('enrolled Udemy and Coursera courses');
    expect(meta).toContain('one at a time');
    expect(meta).toContain('whole courses are not supported');
    expect(meta).toContain('Pro or Team');

    const nav = src.docsShell.match(/\{ to: '\/docs\/courses'[^}]*\}/)[0];
    expect(nav).toContain('one at a time');
    expect(nav).toContain('Pro or Team');

    doesNotSay('features', 'download a course,');
    says('features', 'download a course lecture,');
  });
});

// The 3-at-once cap is DownloadEngine::schedule(), which only counts HTTP tasks —
// direct downloads; Pro takes the Max simultaneous downloads setting, 1–32
// (SettingsDialog.cpp).
describe('plans', () => {
  it('limits Free to 3 direct downloads at once, not 3 downloads of any kind', () => {
    nowhere(/3 concurrent downloads/);
    // One name for that set everywhere, the plan cards' own: direct downloads.
    nowhere(/file[ -]downloads?/i);
    nowhere(/3-download (?:cap|limit)/);
    says('pricing', 'with 3 direct downloads at once');
    says('compare', 'Yes — 3 direct downloads at once, forever');
    says('about', 'Free: 3 direct downloads at once; Pro: up to 32');
  });

  it('gives Pro up to 32 downloads at once, never unlimited', () => {
    nowhere(/unlimited on Pro|Pro and Team: unlimited|Pro removes it|lifts the concurrency cap/i);
    says('acceleration', 'Pro and Team: up to 32');
    says('scheduler', 'up to 32 on Pro');
    says('about', 'Pro runs up to 32 direct downloads at once instead of 3');
    says('prerender', 'Pro runs up to 32 direct downloads at once instead of 3');
  });

  it('lists what Pro actually adds', () => {
    says('about', 'AI renaming and Smart add');
  });
});

// AI rename posts the file name and a query-less URL, Smart add the typed text,
// to nexadownloadmanager.com/api/ai (src/ai/AiClient.cpp, DownloadEngine.cpp),
// which calls Anthropic (backend utils/aiProxy.js).
describe('what leaves your machine', () => {
  it('names the AI exception next to "nothing is proxied"', () => {
    says('about', 'Nothing is proxied through our servers');
    says('about', 'URL without the query string');
    says('about', 'passes them to Anthropic');
  });
});

// The global RateLimiter is handed only to DownloadTasks, and the per-download
// cap exists only for them (DownloadEngine::supportsSpeedLimit); torrents have
// libtorrent limits of their own (TorrentManager::setSpeedLimits).
describe('speed limits', () => {
  it('scopes the speed cap to direct downloads', () => {
    doesNotSay('home', 'Set global and per-download speed limits');
    doesNotSay('prerender', 'cap bandwidth globally');
    doesNotSay('scheduler', 'cap bandwidth globally');
    doesNotSay('scheduler', 'A global cap across everything');
    doesNotSay('scheduler', 'a real ceiling on the app');
    doesNotSay('scheduler', 'KB/s across all HTTP downloads');
    doesNotSay('scheduler', 'The global cap covers HTTP downloads');
    doesNotSay('scheduler', 'Speed limits apply to HTTP');
    doesNotSay('scheduler', 'For everything:');
    doesNotSay('featureShell', 'cap the bandwidth while you work');
    doesNotSay('features', 'cap the bandwidth,');
    says('home', 'Cap the speed of direct downloads');
    says('featureShell', 'cap the speed of direct downloads while you work');
    says('features', 'cap the speed of direct downloads,');
    says('scheduler', 'stream and MEGA downloads are not capped');
  });
});

// The list columns are FILE, SIZE, PROGRESS, SPEED, STATUS, CATEGORY
// (MainWindow.cpp); "Time left" is a field of DownloadDetailsDialog.
describe('the download list', () => {
  it('does not promise an ETA in the list', () => {
    doesNotSay('home', 'ETA at a glance');
    says('home', 'time left in each download');
  });
});

// Open streams go to FFmpeg (HlsGrabber::muxViaFfmpegDirect); only a stream
// behind a login is fetched segment by segment, in parallel, by Nexa.
describe('video grabber', () => {
  it('says only login-gated streams are fetched in parallel by Nexa', () => {
    nowhere(/fetches its segments in parallel|fetched in parallel and muxed/);
    says('featureShell', 'the ones behind your login are fetched in parallel');
    says('prerender', 'through FFmpeg, or in parallel when the stream needs your login');
  });
});

// /api/releases/download/:os always serves the latest release, and only
// /latest carries checksums (backend routes/releases.js).
describe('changelog', () => {
  it('points at the latest build only', () => {
    doesNotSay('changelog', 'Checksums and installers are on the download page');
    says('changelog', "The latest build's installer and its SHA-256 checksum are on the download page");
  });
});

// Tools → Grab Website… (MainWindow.cpp, WebsiteGrabberDialog.cpp) crawls a
// site and queues files, but walks pages without saving them (SiteCrawler.cpp).
describe('compare: the site grabber', () => {
  it('marks it partial and says what it does not do', () => {
    expect(src.compare).toMatch(/label: 'Whole-site spider \/ grabber', values: \['partial', true,/);
    says('compare', 'Grab Website…');
    says('compare', 'saves none of the pages');
    doesNotSay('compare', 'Nexa has a link grabber for one page');
    doesNotSay('compare', 'You need the site spider');
    says('compare', 'You need a browsable offline copy of a website');
  });
});

// No docs or feature page covers Google Drive, categories or AI rename, and
// FeatureShell's Figure renders nothing in a production build.
describe('tutorials', () => {
  it('promises neither screenshots nor a guide for every topic', () => {
    doesNotSay('tutorials', 'with screenshots');
    doesNotSay('tutorials', 'every one of them already has a written guide');
    doesNotSay('tutorials', 'Every topic above exists as a written guide');
    nowhere(/every topic has a written guide/i);
    says('tutorials', 'most of them already have a written guide');
    says('tutorials', 'most topics have a written guide today');
    says('prerender', 'most topics have a written guide today');
  });
});

describe('segmented acceleration page', () => {
  // DownloadTask::sendProbe: a Range: bytes=0-0 GET (HEAD only for Google
  // Drive); onProbeFinished: ranges only on a 206.
  it('describes the probe as a one-byte ranged GET that a 206 has to answer', () => {
    doesNotSay('acceleration', 'falling back to a ranged');
    doesNotSay('acceleration', 'Nexa detects <Code>Accept-Ranges</Code>');
    doesNotSay('acceleration', 'did not advertise');
    says('acceleration', '206 Partial Content');
  });

  // No connection-count control anywhere (MainWindow row menu, SettingsDialog);
  // a failing segment is retried kMaxRetries = 5 times, then the task errors.
  it('points at no connection setting and no back-off that do not exist', () => {
    doesNotSay('acceleration', 'backs off to what the server allows');
    doesNotSay('acceleration', 'the setting is per-download in the right-click menu');
    doesNotSay('acceleration', 'drop that download to 4 connections');
    doesNotSay('acceleration', 'the scheduler can do both for you');
    says('acceleration', 'retried five times');
  });

  // DownloadTask::onSizeDiscovered clamps the one open-ended segment; nothing re-splits it.
  it('keeps an unknown-size download on one connection', () => {
    doesNotSay('acceleration', 're-segmented if the size becomes known');
    says('acceleration', 'stays on one even if the size turns up mid-transfer');
  });

  // onProbeFinished (validatorChanged) and onSegmentObjectChanged both drop the
  // partial file and start again without a message.
  it('says a changed file is restarted, silently', () => {
    doesNotSay('acceleration', 'it says so and restarts');
    doesNotSay('acceleration', 'The file on the server changed');
    says('acceleration', 'starts again from the first byte');
  });

  // DownloadDetailsDialog: per-connection "Downloaded" column, "Resume capability" field.
  it('names the fields the details window really has', () => {
    doesNotSay('acceleration', "that connection's throughput");
    doesNotSay('acceleration', 'ranges: no');
    says('acceleration', 'Resume capability: No');
    says('acceleration', 'Connection details');
  });

  // DownloadTask::growFileAsync sizes the file on a QThread.
  it('says the file is sized on a worker thread', () => {
    doesNotSay('acceleration', 'no worker threads');
    doesNotSay('acceleration', 'Windows freezes for a few seconds');
    says('acceleration', 'worker thread');
  });

  // File → New download… is QKeySequence::New and pre-fills a copied link.
  it('adds a download with Ctrl+N, not a paste shortcut that does not exist', () => {
    doesNotSay('acceleration', 'Ctrl+V');
    says('acceleration', 'Ctrl+N');
  });

  it('says the 3.1× and 2.7× came from a plain range client, not from Nexa', () => {
    says('acceleration', 'plain range-request client rather than Nexa itself');
  });

  it('does not describe a connections-per-file field', () => {
    doesNotSay('acceleration', 'connections-per-file');
  });
});

describe('scheduler page', () => {
  // MainWindow::maybeRunWhenDone runs after a completion, needs allTerminal()
  // and no scheduled jobs; the countdown dialog is the only place to cancel.
  it('says when the after-downloads action runs and where to cancel it', () => {
    doesNotSay('scheduler', 'cancellable from the dialog or the tray');
    doesNotSay('scheduler', 'everything finished, failed or paused');
    says('scheduler', 'nothing else is left running, queued, paused or scheduled');
  });

  // SettingsDialog.cpp: "When all downloads finish" → "Do nothing" / … .
  it("uses the setting's real name and values", () => {
    doesNotSay('scheduler', 'When everything is done');
    doesNotSay('scheduler', 'back to “Nothing”');
    says('scheduler', 'When all downloads finish');
  });

  it('does not list connections per file as something you can set', () => {
    doesNotSay('scheduler', 'interacts with the speed cap rather than overriding it');
    says('scheduler', 'Not a setting: Nexa picks it from the file size');
  });

  // MainWindow::showRowMenu has Move to top / up / down; the Downloads menu does not.
  it('reorders from the row menu, not the Downloads menu', () => {
    doesNotSay('scheduler', 'move the selection with the Downloads menu');
    says('scheduler', 'Move to top, Move up and Move down');
  });

  // No such setting; the Windows installer writes a Run key, Linux has nothing.
  it('points at no start-with-system setting', () => {
    doesNotSay('scheduler', 'start-with-system');
    says('scheduler', 'the installer already starts Nexa');
  });

  // A captured link is added at once (MainWindow::onClipboardUrl); scheduling is
  // one URL at a time in New download.
  it('does not pair clipboard capture with scheduling', () => {
    doesNotSay('scheduler', 'set them all to start at night');
    says('scheduler', 'a copied link you accept starts right away');
  });
});
