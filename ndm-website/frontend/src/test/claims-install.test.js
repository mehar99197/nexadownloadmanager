import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * What the download, docs, install and extension pages say about the packages
 * and the extension, checked against what the product does.
 *
 * Every assertion here pins a sentence that was once false on these pages.
 * The comment above each one names the source that settles it, so the next
 * edit can be checked the same way instead of trusted. The page sources are
 * read as text: the claims are plain copy, and a string check is what catches
 * a stale sentence being pasted back in.
 */

// Vite rewrites a literal `new URL('…', import.meta.url)` into a root-relative
// asset URL, which lands on C:\src\… instead of beside this file, so the base
// goes through a variable its transform leaves alone.
const HERE = import.meta.url;
const read = (rel) => readFileSync(new URL(`../pages/${rel}`, HERE), 'utf8');

const download = read('Download.jsx');
const docs = read('Docs.jsx');
const install = read('docs/DocsInstall.jsx');
const extension = read('docs/DocsExtension.jsx');
const ALL = { download, docs, install, extension };

describe('what the installers ship', () => {
  // build.yml bundles yt-dlp, ffmpeg and ffprobe and nothing else, and
  // YtDlpGrabber.cpp never hands yt-dlp an external downloader
  // ("aria2c is NOT used").
  it.each(Object.entries(ALL))('%s page does not claim aria2', (_name, src) => {
    expect(src).not.toMatch(/aria2/i);
  });

  // yt-dlp runs with --js-runtimes node/deno/bun (YtDlpGrabber.cpp), and no
  // package ships one of them, so "nothing else to install" is not true for
  // YouTube.
  it.each(Object.entries(ALL))('%s page does not say nothing else needs installing', (_name, src) => {
    expect(src).not.toMatch(/nothing else (?:needs installing|to install)|everything the app needs/);
    expect(src).not.toMatch(/works out of the box/);
  });

  it('the install guide and the download page name the JavaScript runtimes', () => {
    for (const src of [install, download]) {
      expect(src).toMatch(/Deno/);
      expect(src).toMatch(/Node\.js/);
      expect(src).toMatch(/Bun/);
    }
  });

  // There is no yt-dlp updater: build.yml pins YTDLP_VERSION, and the only
  // update path is the app's own Help → Check for updates… (MainWindow.cpp).
  it('the install guide does not promise a yt-dlp updater in Settings', () => {
    expect(install).not.toMatch(/update its copy of yt-dlp|Update yt-dlp/i);
    expect(install).toMatch(/Check for updates/);
  });

  // The app hands yt-dlp only the sites in resources/cloud_providers.json
  // (isSiteVideo / routesThroughYtDlp), not everything yt-dlp can fetch.
  it.each(Object.entries(ALL))('%s page does not promise 1000+ sites', (_name, src) => {
    expect(src).not.toMatch(/1000\+|thousand (?:other )?sites/i);
  });
});

describe('the Linux package', () => {
  // Built on ubuntu-latest and install-tested only in a clean ubuntu:24.04
  // container (build.yml verify-offline); glibc comes from the host.
  it('is offered for Ubuntu 24.04 and newer only', () => {
    expect(download).toMatch(/24\.04/);
    expect(install).toMatch(/24\.04/);
    for (const src of Object.values(ALL)) {
      expect(src).not.toMatch(/22\.04/);
      expect(src).not.toMatch(/Debian 12/);
      expect(src).not.toMatch(/Ubuntu\s*\/\s*Debian/);
    }
  });

  // Qt and libtorrent are bundled in /usr/lib/nexa as shared libraries; Depends
  // lists only libc6, libstdc++6, libgcc-s1, the GL libraries and python3
  // (build.yml).
  it('is described as self-contained, not as using the distribution Qt', () => {
    expect(install).not.toMatch(/Qt 6 runtime from your distribution/);
    expect(install).not.toMatch(/resolves the Qt dependencies/);
    expect(install).not.toMatch(/compiled into the app itself/);
    expect(install).toMatch(/\/usr\/lib\/nexa/);
  });
});

describe('where things live', () => {
  // AppDataLocation with organisation and application both "Nexa"
  // (main.cpp, Portable.cpp); nexa.db is opened there (DownloadEngine.cpp).
  it('names the data folder with its application subfolder', () => {
    for (const src of Object.values(ALL)) {
      expect(src).not.toMatch(/%APPDATA%\\Nexa(?!\\Nexa)/);
      expect(src).not.toMatch(/~\/\.local\/share\/Nexa(?!\/Nexa)/);
    }
    expect(install).toMatch(/%APPDATA%\\Nexa\\Nexa/);
    expect(install).toMatch(/~\/\.local\/share\/Nexa\/Nexa/);
  });

  // Extension cookies become temporary cookies-<uuid>.txt files in a private
  // nexa-auth folder, deleted at exit and swept at start, and HTTP downloads
  // send them too (AuthenticationManager.cpp).
  it('describes site-login cookies as temporary files used by every download', () => {
    expect(install).not.toMatch(/per-domain <Code>cookies\.txt<\/Code>/);
    expect(install).not.toMatch(/used only by yt-dlp/);
    expect(install).toMatch(/nexa-auth/);
  });
});

describe('the browser extension', () => {
  // content.js: the on-video button reads "Download with NDM";
  // background.js: "Download with Nexa" is the right-click menu item.
  it('names the on-video button as it reads', () => {
    for (const src of [download, extension, docs]) {
      expect(src).not.toMatch(/Download with Nexa(?:&rdquo;|”|")\s*button/);
      expect(src).not.toMatch(/floating Nexa button/);
    }
    expect(download).toMatch(/Download with NDM/);
    expect(extension).toMatch(/Download with NDM/);
  });

  // NativeHostRegistrar.cpp writes host manifests for Chrome, Chromium, Edge
  // and Brave only.
  it('names only the Chromium browsers the app registers a host for', () => {
    expect(download).not.toMatch(/other Chromium browsers/);
    expect(download).toMatch(/Brave and Chromium/);
  });

  // extension-firefox/build.sh makes the unsigned AMO upload, and
  // packaging/extension-ids.env has no signed .xpi yet.
  it('tells Firefox users the add-on is temporary until the listing is live', () => {
    expect(download).toMatch(/temporary add-on/i);
  });

  // Edge keeps the Developer mode switch in its left pane.
  it('says where Developer mode is in Edge as well as Chrome and Brave', () => {
    expect(extension).toMatch(/left pane/);
  });

  // NativeHostRegistrar.cpp registers the host as com.nexa.host; nexa-host is
  // the program the manifest points at.
  it('gives the registered host name', () => {
    expect(extension).not.toMatch(/host is called <Code>nexa-host<\/Code>/);
    expect(extension).toMatch(/com\.nexa\.host/);
  });

  // nexa-host.cpp is 237 lines.
  it('does not overstate the size of the bridge', () => {
    expect(extension).not.toMatch(/about 300 lines/);
  });

  // background.js takes over a default list of file types, editable in the
  // Options page's File types section.
  it('says which downloads are taken over', () => {
    expect(extension).not.toMatch(/Click any download link as usual/);
    expect(extension).toMatch(/File types/);
  });

  // popup.html: "Take over downloads" and "Pause on this site" switches.
  it('points at the popup switches for letting the browser keep a download', () => {
    expect(extension).not.toMatch(/Hold the extension/);
    expect(extension).toMatch(/Take over downloads/);
    expect(extension).toMatch(/Pause on this site/);
  });
});

describe('extension troubleshooting', () => {
  // nexa-host.cpp starts `nexa --background` and polls for about 6 s.
  it('says the bridge starts the app when it is not running', () => {
    expect(extension).not.toMatch(/only relays to a live app/);
    expect(extension).toMatch(/in the background/);
    expect(extension).toMatch(/six seconds/);
  });

  // The repo manifest carries a "key", the app rewrites host manifests on every
  // launch, and extra ids come from NEXA_EXTRA_EXTENSION_IDS or the
  // nativeHost/extraChromeIds setting (NativeHostRegistrar.cpp).
  it('does not tell people to hand-edit a manifest the app rewrites', () => {
    expect(extension).not.toMatch(/into the manifest&apos;s <Code>allowed_origins<\/Code>/);
    expect(extension).toMatch(/NEXA_EXTRA_EXTENSION_IDS/);
    expect(extension).toMatch(/extraChromeIds/);
  });

  // nexa-host waits for a framed message on stdin and prints no diagnostics;
  // the extension's Options page has "Export diagnostics" and the app has
  // "Export logs…".
  it('points at the diagnostics the extension and the app export', () => {
    expect(extension).not.toMatch(/Run the host by hand/);
    expect(extension).not.toMatch(/LOCALAPPDATA/);
    expect(extension).toMatch(/Export diagnostics/);
    expect(extension).toMatch(/Export logs/);
  });
});
