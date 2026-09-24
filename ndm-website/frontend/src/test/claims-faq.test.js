import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The FAQ (/faq) has to describe what the desktop app does. Every phrase banned
 * below is a claim an audit found false; the comment beside it names the code
 * that settles it, so an edit that brings one back fails here with the reason
 * attached.
 */
// The path goes through a variable on purpose: Vite rewrites a literal
// new URL('…', import.meta.url) into an http:// URL, which node:fs cannot open.
const FAQ_SOURCE = '../pages/Faq.jsx';
const faq = readFileSync(fileURLToPath(new URL(FAQ_SOURCE, import.meta.url).href), 'utf8');

// One answer's JSX, found by its question. Some phrases are right in one answer
// and wrong in another (Settings → Video sites holds subtitles, not an updater).
function answer(question) {
  const at = faq.indexOf(`q: '${question}'`);
  if (at < 0) throw new Error(`FAQ question not found: ${question}`);
  const start = faq.indexOf('a: <>', at);
  return faq.slice(start, faq.indexOf('</>,', start));
}

const YOUTUBE_LOGIN = [
  'Why do I get a 403 error on YouTube?',
  'Can I download age-restricted videos?',
  'What about YouTube Premium or purchased videos?',
  'Why is only 360p available for some videos?',
  'Can I download private or unlisted videos?',
];

describe('FAQ says what the app does', () => {
  it('keeps all 55 answers', () => {
    // The page title, the meta description and the e2e row checks count them.
    expect(faq.match(/^\s*q: '/gm)).toHaveLength(55);
  });

  it('gives Free its real limits and Pro a ceiling of 32, never "no cap"', () => {
    // DownloadEngine.cpp:155-160 and schedule() cap only queued plain file
    // downloads at 3 on Free; grabbers, MEGA and torrents call start() at once.
    // SettingsDialog.cpp:318-321: Max simultaneous downloads is 1-32 (default 4).
    // config/plans.js + LicenseManager.h:31: 16 connections per file, 32 paid.
    expect(faq).not.toMatch(/one limit/i);
    expect(faq).not.toMatch(/removes the (concurrency )?cap/i);
    expect(faq).not.toMatch(/caps you at three simultaneous/i);
    expect(faq).not.toMatch(/unlimited/i);
    for (const q of ['Is Nexa completely free?', 'What is the difference between Free and Pro?']) {
      const a = answer(q);
      expect(a, q).toMatch(/three plain file downloads at a time/);
      expect(a, q).toMatch(/up to 32 downloads at once/);
      expect(a, q).toMatch(/16 connections per file/);
      expect(a, q).toMatch(/32 connections per file/);
      expect(a, q).toMatch(/64 themes/);
      // MainWindow.cpp:2036-2044: Smart add is Pro-only too.
      expect(a, q).toMatch(/Smart add/);
    }
    expect(answer('What is the difference between Free and Pro?')).toMatch(/torrents do not count/);
  });

  it('supports Ubuntu 24.04 and bundles yt-dlp and ffmpeg, not aria2', () => {
    // build.yml: the .deb is built and smoke-tested on Ubuntu 24.04, amd64 only,
    // and ships yt-dlp + ffmpeg. aria2 is neither bundled nor run
    // (YtDlpGrabber.cpp:620-632 keeps yt-dlp's own downloader on purpose).
    expect(faq).not.toMatch(/22\.04/);
    expect(faq).not.toMatch(/Debian 12/);
    expect(faq).not.toMatch(/on Debian or Ubuntu/);
    expect(faq).not.toMatch(/aria2/i);
    expect(answer('Which operating systems are supported?')).toMatch(/Ubuntu 24\.04 or newer \(x86-64\)/);
    expect(answer('How do I install Nexa?')).toMatch(/yt-dlp and ffmpeg are bundled/);
  });

  it('updates yt-dlp only through a Nexa update, found under Help', () => {
    // SettingsDialog.cpp:345-358: Video sites holds the subtitle options only.
    // ExternalTools.h:67-85 runs the bundled yt-dlp first; build.yml pins
    // YTDLP_VERSION. MainWindow.cpp:1752: Help → Check for updates….
    expect(faq).not.toMatch(/update(d)? (it|yt-dlp) from Settings/i);
    expect(faq).not.toMatch(/can be updated on its own/);
    expect(faq.match(/Settings → Video sites/g)).toHaveLength(1);
    expect(answer('Does Nexa download subtitles?')).toMatch(/Settings → Video sites/);
    expect(answer('How do I update Nexa?')).toMatch(/no updater of its own/);
    for (const q of ['How do I update Nexa?', YOUTUBE_LOGIN[0], YOUTUBE_LOGIN[3]])
      expect(answer(q), q).toMatch(/Help → Check for updates…/);
  });

  it('says where a copied URL still gets a login, and that YouTube never does', () => {
    // DownloadEngine.cpp:238-275 + BrowserLogin.cpp:196-237: the known login
    // sites read the browser's own jar, from Firefox or a Chromium browser on
    // Linux and from Firefox only on Windows. AuthenticationManager.cpp:39-46
    // and :305-308 drop every credential for YouTube, and YtDlpGrabber never
    // passes the browser's headers on (m_headers is stored and never read).
    const noExtension = answer('Can I use Nexa without the browser extension?');
    expect(noExtension).not.toMatch(/anything behind a login will fail/);
    expect(noExtension).not.toMatch(/one trade-off/);
    expect(noExtension).toMatch(/reads the login from your browser itself/);
    expect(noExtension).toMatch(/only from Firefox on Windows/);
    expect(faq).not.toMatch(/cookies travel with it/);
    expect(faq).not.toMatch(/if your session has access/);
    for (const q of YOUTUBE_LOGIN)
      expect(answer(q), q).toMatch(/Nexa never sends your YouTube login/);
  });

  it('puts the download folder and categories where Settings has them', () => {
    // SettingsDialog.cpp:146-155: Download folder is in General; :276-295 the
    // Categories… button sits beside the sorting checkbox and is disabled
    // whenever sorting is off. There is no Categories section.
    const saved = answer('Where are downloads saved by default?');
    expect(saved).not.toMatch(/Settings → Downloads/);
    expect(saved).not.toMatch(/Settings → Categories/);
    expect(saved).toMatch(/Settings → General → Download folder/);
    expect(saved).toMatch(/Categories… button/);
    expect(saved).toMatch(/only while sorting/);
  });

  it('promises no screenshots and no extension version check', () => {
    // DocsExtension.jsx renders no images. IpcServer.cpp:242-255: ping reports
    // the app's version and nothing compares it with the extension's.
    expect(faq).not.toMatch(/with screenshots/);
    expect(faq).not.toMatch(/too old to speak to it/);
  });

  it('keeps the quality menu in the extension and names the sites instead of 1000+', () => {
    // content.js:312-320 + IpcServer.cpp:326-331: the menu is the extension's.
    // A pasted URL passes no format, which YtDlpGrabber.cpp:350 turns into best.
    // CloudProviders.cpp:164-187 sends only cloud_providers.json's sites to
    // yt-dlp; anything else depends on the extension sniffing a stream.
    expect(faq).not.toMatch(/1000\+/);
    expect(faq).not.toMatch(/thousand/i);
    expect(faq).not.toMatch(/almost any site/i);
    expect(faq).not.toMatch(/Set a default/i);
    expect(answer('Can I download YouTube videos?')).toMatch(/pasted URL downloads the best quality/);
    expect(answer('Can I choose the video quality?')).toMatch(/no default-quality setting/);
    const sites = answer('Which other video sites are supported?');
    expect(sites).not.toMatch(/SoundCloud|Bandcamp|\bTED\b|Internet Archive|public broadcasters/);
    expect(sites).toMatch(/direct, HLS or DASH stream/);
    for (const name of ['Vimeo', 'Twitch', 'TikTok', 'Reddit', 'Dailymotion', 'Bilibili', 'Instagram', 'Facebook'])
      expect(sites).toContain(name);
  });

  it('describes a playlist as one row with its own parallel setting', () => {
    // YtDlpGrabber.cpp:656-700 runs one job with K yt-dlp workers, K from
    // "Playlist videos in parallel" (1-8, default 3; SettingsDialog.cpp:97,
    // :339-342). MainWindow.cpp:3018-3024 shows it as one row of N videos.
    const playlist = answer('How do I download a whole playlist?');
    expect(playlist).not.toMatch(/its own row/);
    expect(playlist).not.toMatch(/concurrency limit/);
    expect(playlist).toMatch(/one row/);
    expect(playlist).toMatch(/Playlist videos in parallel/);
  });

  it('offers the magnet routes that exist, not Ctrl+V or a browser handoff', () => {
    // MainWindow.cpp:1645-1760 binds no paste shortcut, and New download
    // pre-fills only http/https/ftp (:1125-1129). Nothing registers a magnet:
    // handler. background.js:849 "Download with Nexa" covers every link and
    // IpcServer.cpp:302-303 accepts magnet:. Torrents skip the download cap and
    // have their own speed limits (DownloadEngine.cpp:876-905).
    expect(faq).not.toMatch(/Ctrl\+V/);
    expect(faq).not.toMatch(/hand magnet links to Nexa/);
    expect(faq).not.toMatch(/obeys the same limits/);
    const torrent = answer('How do I download a torrent?');
    expect(torrent).toMatch(/Download with Nexa/);
    expect(torrent).toMatch(/Ctrl\+N/);
    expect(answer('Does Nexa support magnet links?')).toMatch(/Download with Nexa/);
  });

  it('troubleshoots with the controls and labels the app has', () => {
    // No per-download connection setting exists (DownloadTask.h:126 is the
    // licence ceiling). DownloadDetailsDialog.cpp:466 labels "Resume capability".
    expect(faq).not.toMatch(/connection count/);
    expect(faq).not.toMatch(/ranges: no/);
    expect(answer('Download speed is slower than I expected')).toMatch(/Resume capability: No/);
    // Settings has no history cleanup; rows go only by Clear completed
    // (MainWindow.cpp:1697, :815). main.cpp:292 → loadPersisted() restores
    // plain file downloads only (DownloadEngine.cpp:978, :1618-1643).
    expect(faq).not.toMatch(/history cleanup/);
    const gone = answer('My downloads disappeared after restarting');
    expect(gone).toMatch(/Clear completed/);
    expect(gone).toMatch(/Only plain file downloads come back after a restart/);
    // DownloadTask.cpp:953-1025: sparse on NTFS, lazy on ext4/APFS/XFS; only
    // FAT32/exFAT reserve the size, and a full disk is a write error.
    expect(faq).not.toMatch(/allocates the full file size before it starts writing/);
    const disk = answer('“Disk full” but I have plenty of space');
    expect(disk).toMatch(/FAT32 or exFAT/);
    expect(disk).toMatch(/write error/);
  });

  it('gives the real settings, database and credential locations', () => {
    // main.cpp: organization and application are both "Nexa", so QSettings is
    // HKCU\Software\Nexa\Nexa or ~/.config/Nexa/Nexa.conf, and the database is
    // AppDataLocation/nexa.db (Portable.cpp:44-61, DownloadEngine.cpp:70-72).
    // CredentialStore.cpp keeps the key and account token in the OS store.
    const where = answer('Where are Nexa’s settings and database stored?');
    expect(where).toContain('%APPDATA%\\Nexa\\Nexa\\nexa.db');
    expect(where).toContain('~/.local/share/Nexa/Nexa/nexa.db');
    expect(where).toContain('HKEY_CURRENT_USER\\Software\\Nexa\\Nexa');
    expect(where).toContain('~/.config/Nexa/Nexa.conf');
    expect(where).toMatch(/Credential Manager/);
    const reset = answer('How do I completely reset Nexa?');
    expect(reset).not.toMatch(/That removes settings/);
    expect(reset).toContain('HKEY_CURRENT_USER\\Software\\Nexa\\Nexa');
    expect(reset).toContain('~/.config/Nexa');
  });
});
