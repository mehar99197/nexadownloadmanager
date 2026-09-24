import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The YouTube guide (/docs/youtube) and the YouTube feature page
 * (/features/youtube-sites) have to describe what the desktop app does, not
 * what yt-dlp could do in theory. Every phrase banned below is a claim an
 * audit found false; the comment beside it names the code that settles it, so
 * an edit that brings one back fails here with the reason attached.
 *
 * The site list is checked against resources/cloud_providers.json, the
 * registry the app routes by. A provider that starts going to yt-dlp has to be
 * named on both pages before this passes, and a Pro-only one has to be marked
 * Pro on the feature page.
 */
// Held in a variable: Vite rewrites a literal `new URL('…', import.meta.url)`
// as an asset import, which under jsdom points at nothing.
const HERE = import.meta.url;
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, HERE).href), 'utf8');

const docs = read('../pages/docs/DocsYoutube.jsx');
const feature = read('../pages/features/FeatureYoutubeSites.jsx');
const pages = { docs, feature };

// How each provider the app sends to yt-dlp is named on the pages.
const PAGE_NAMES = {
  youtube: ['YouTube'],
  meta: ['Facebook', 'Instagram', 'Threads'],
  udemy: ['Udemy'],
  vimeo: ['Vimeo'],
  coursera: ['Coursera'],
  skillshare: ['Skillshare'],
  pluralsight: ['Pluralsight'],
  linkedin: ['LinkedIn'],
  apple_music: ['Apple Music'],
  tiktok: ['TikTok'],
  twitter: ['X (Twitter)'],
  reddit: ['Reddit'],
  dailymotion: ['Dailymotion'],
  twitch: ['Twitch'],
  bilibili: ['Bilibili'],
};
// LinkedIn is one host; only /learning is the Pro course site.
const PRO_NAMES = { linkedin: 'LinkedIn Learning' };
// movie-box.co matches isSiteVideoUrl only through `isSiteVideo`, while its own
// entry says routesThroughYtDlp:false, which looks unintended. It stays off the
// public pages until that is settled in the app.
const DELIBERATELY_UNLISTED = ['moviebox'];

describe('YouTube & video sites pages say what the app does', () => {
  it('lists the sites the app sends to yt-dlp instead of claiming 1000+', () => {
    for (const [name, src] of Object.entries(pages)) {
      expect(src, name).not.toMatch(/1000\+/);
      expect(src, name).not.toMatch(/thousand/i);
      expect(src, name).not.toMatch(/anything yt-dlp can fetch/);
      expect(src, name).toMatch(/YouTube & video sites/);
      // Every other site: only what the extension sniffs (direct/HLS/DASH).
      expect(src, name).toMatch(/direct, HLS or DASH stream/);
      // Apple Music is routed to yt-dlp, and AuthUtils.cpp reports it as DRM.
      expect(src, name).toMatch(/Apple Music[^.]*DRM-protected/);
      // Udemy keeps the lecture URL for a course job (YtDlpGrabber.cpp:467-482);
      // Coursera has no yt-dlp extractor (content.js:89-93).
      expect(src, name).toMatch(/one lecture at a time/);
      expect(src, name).toMatch(/Pro plan/);
    }
    // Sites the old sample named that the app never sends to yt-dlp.
    expect(feature).not.toMatch(
      /SoundCloud|Bandcamp|Mixcloud|Rumble|Odysee|Bitchute|BBC iPlayer|Tumblr|Bluesky|Internet Archive|\bKick\b|\bTED\b/,
    );
    expect(feature).not.toMatch(/Udemy, Coursera, LinkedIn Learning and similar/);
  });

  it('does not present sites the bundled yt-dlp cannot read as yt-dlp downloads', () => {
    // `yt-dlp --list-extractors` for the bundled 2026.08.19 (build.yml YTDLP_VERSION)
    // has no Coursera, Skillshare or Threads extractor, though the app routes all
    // three to it. What works there is the stream the extension sniffs: Coursera's
    // on-video menu offers it (content.js:897-909), and the popup's "Grab media on
    // this page" sends it from any site (popup.html, background.js grabLinks).
    // AuthUtils.cpp answers a whole Udemy course with "not supported".
    for (const [name, src] of Object.entries(pages)) {
      expect(src, name).toMatch(/Coursera and Skillshare have no yt-dlp support/);
      expect(src, name).toMatch(/no Threads support/);
      expect(src, name).toMatch(/Grab media on this page/);
      expect(src, name).toMatch(/whole courses are not supported/);
      expect(src, name).not.toMatch(/Twitch,\s+Bilibili and Threads/);
      expect(src, name).not.toMatch(/Skillshare and Pluralsight/);
    }
  });

  it('names every provider the registry routes to yt-dlp, and marks the Pro-only ones', () => {
    const registry = JSON.parse(read('../../../../resources/cloud_providers.json')).providers;
    // The same test CloudProviders::isSiteVideoUrl applies (src/auth/CloudProviders.cpp).
    const routed = registry.filter((p) => p.isSiteVideo || p.routesThroughYtDlp);
    expect(routed.length).toBeGreaterThan(10);
    const proGroup = feature.match(/group: 'Courses \(Pro plan\)',\s*sites:\s*'([^']+)'/)?.[1] ?? '';
    const docsProLine = docs.match(/Courses, Pro plan only:<\/strong>([^\n]*)/)?.[1] ?? '';
    // tests/CloudProvidersTest.cpp pins exactly five Pro-only course sites.
    expect(registry.filter((p) => p.proOnly)).toHaveLength(5);
    for (const p of routed) {
      if (DELIBERATELY_UNLISTED.includes(p.id)) continue;
      expect(PAGE_NAMES, `provider "${p.id}" goes to yt-dlp: name it on both pages and in PAGE_NAMES`)
        .toHaveProperty(p.id);
      for (const siteName of PAGE_NAMES[p.id]) {
        expect(docs, `docs page should name ${siteName}`).toContain(siteName);
        expect(feature, `feature page should name ${siteName}`).toContain(siteName);
      }
      if (p.proOnly) {
        const proName = PRO_NAMES[p.id] ?? PAGE_NAMES[p.id][0];
        expect(proGroup, `${p.id} is Pro-only on the feature page`).toContain(proName);
        expect(docsProLine, `${p.id} is Pro-only on the docs page`).toContain(proName);
      }
    }
  });

  it('promises no yt-dlp updater: yt-dlp changes only with a Nexa update', () => {
    // SettingsDialog.cpp's Video sites section holds subtitle options only;
    // build.yml pins YTDLP_VERSION; ExternalTools.h looks in the app folder, then PATH.
    for (const [name, src] of Object.entries(pages)) {
      expect(src, name).not.toMatch(/Update yt-dlp/);
      expect(src, name).not.toMatch(/update yt-dlp from Settings/i);
      expect(src, name).not.toMatch(/an updater/i);
      expect(src, name).not.toMatch(/data folder/);
      expect(src, name).toMatch(/Check for updates/);
      expect(src, name).toMatch(/only when you install a Nexa update/);
    }
    expect(feature).not.toMatch(/same week, for everyone/);
  });

  it('has no paste shortcut, no quality picker in the app and no default quality', () => {
    // MainWindow.cpp: New download is Ctrl+N and pre-fills a copied link; the
    // dialog passes an empty format, which formatForQuality turns into "best".
    for (const [name, src] of Object.entries(pages)) {
      expect(src, name).not.toMatch(/Ctrl\+V/);
      expect(src, name).not.toMatch(/set a default/i);
      expect(src, name).not.toMatch(/thumbnail/i);
      expect(src, name).toMatch(/Ctrl\+N/);
      expect(src, name).toMatch(/best quality/);
      expect(src, name).toMatch(/no default-quality setting/);
    }
    expect(docs).not.toMatch(/probes the page with yt-dlp and shows what it found/);
    expect(feature).not.toMatch(/Nexa probes it and shows what it found/);
    expect(feature).not.toMatch(/how long it is/);
  });

  it('never asks for a cookies.txt, and never says a login fixes YouTube', () => {
    // SiteLoginsDialog.cpp offers a site, a browser and "Use browser login";
    // AuthenticationManager::isExcludedHost drops every credential for YouTube.
    for (const [name, src] of Object.entries(pages)) {
      expect(src, name).not.toMatch(/cookies\.txt/);
      expect(src, name).not.toMatch(/Settings &rarr; Site logins/);
      expect(src, name).toMatch(/Tools &rarr; Site logins/);
      expect(src, name).toMatch(/Use browser login/);
      expect(src, name).toMatch(/YouTube never uses your login/);
    }
    expect(docs).not.toMatch(/fresh cookies fix it/);
    expect(docs).not.toMatch(/weeks later, re-export/);
    expect(feature).not.toMatch(/re-export or/);
    expect(feature).not.toMatch(/extension supplies your cookies/);
  });

  it('offers M4A audio and MP4 video, and embeds no chapters', () => {
    // IpcServer.cpp lists m4a audio only; YtDlpGrabber.cpp merges into mp4.
    for (const [name, src] of Object.entries(pages)) {
      expect(src, name).not.toMatch(/MKV/);
      expect(src, name).not.toMatch(/MP3/i);
      expect(src, name).toMatch(/M4A/);
      expect(src, name).toMatch(/one MP4/);
      // No codec filter in formatForQuality, so a lower height is no route to H.264.
      expect(src, name).not.toMatch(/pick 1080p or (lower|below)/);
    }
    expect(feature).not.toMatch(/AAC, FLAC/);
    expect(feature).not.toMatch(/Embedded when the site provides them/);
  });

  it('describes a playlist as one row with its own parallel setting', () => {
    // YtDlpGrabber.cpp: one grabber per playlist, "%1/%2 videos · … · %3 downloading",
    // only DRM-protected videos counted on the finished row.
    for (const [name, src] of Object.entries(pages)) {
      expect(src, name).not.toMatch(/video 4 of 37/);
      expect(src, name).not.toMatch(/one row per entry/i);
      expect(src, name).not.toMatch(/its own row/);
      expect(src, name).not.toMatch(/skipped with a note/);
      expect(src, name).not.toMatch(/3 on Free/);
      expect(src, name).toMatch(/Playlist videos in parallel/);
      expect(src, name).toMatch(/4\/37 videos · 1\.2 GB · 3 downloading/);
      expect(src, name).toMatch(/Download whole course \/ playlist/);
      // DownloadEngine::schedule and activeCount only count DownloadTasks; the
      // site-wide wording for the Free plan's limit.
      expect(src, name).toMatch(/Free runs 3 direct downloads at once \(videos and torrents not counted\)/);
    }
    expect(feature).not.toMatch(/retried individually/);
  });

  it('names the extension button by its label', () => {
    // content.js: const BRAND = "Download with NDM".
    for (const [name, src] of Object.entries(pages)) {
      expect(src, name).toMatch(/Download with NDM/);
      expect(src, name).not.toMatch(/Nexa\s+button/);
    }
  });

  it('does not credit yt-dlp downloads with the queue, the segmented engine or a restore', () => {
    // DownloadEngine.cpp starts them directly and saves only DownloadTasks;
    // the Linux .deb depends on python3 (build.yml).
    expect(feature).not.toMatch(/a queue, the segmented HTTP engine/);
    expect(feature).not.toMatch(/no Python on your machine/);
    expect(feature).not.toMatch(/two streams, in parallel/);
    expect(feature).not.toMatch(/Video or Audio folder/);
    expect(feature).toMatch(/python3/);
    expect(feature).toMatch(/not restored after you restart Nexa/);
    expect(feature).toMatch(/one after the other/);
  });
});
