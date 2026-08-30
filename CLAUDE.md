# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
# Configure (first time)
cmake -B build -G Ninja

# Build all targets
cmake --build build

# Build with tests enabled
cmake -B build -G Ninja -DNEXA_BUILD_TESTS=ON
cmake --build build

# Run unit tests
ctest --test-dir build --output-on-failure
node tests/ExtensionProviderConfigTest.js && node tests/ExtensionSettingsTest.js
node tests/ExtensionContentTest.js            # on-video button + quality dropdown (jsdom from ndm-website/frontend)
(cd ndm-website/backend && npm test)          # integration suites need MySQL; see backend/test/README.md
(cd ndm-website/frontend && npm test)          # vitest component tests
(cd ndm-website/frontend && npm run test:e2e)  # playwright, uses system Chrome

# Regenerate translation sources after changing any tr() string
python3 tools/extract-translations.py

# Package for distribution
cd build && cpack -G DEB    # Linux .deb
cd build && cpack -G NSIS   # Windows installer

# Package browser extension
extension-chromium/package.sh   # outputs nexa-chrome.zip + nexa-edge.zip
```

## Targets

| Target | Description |
|--------|-------------|
| `nexa` | Main Qt desktop GUI app |
| `nexa-host` | Native messaging bridge (tiny stdio exe) |
| `nexa_auth_test` | Auth unit tests (requires `NEXA_BUILD_TESTS=ON`) |
| `nexa_format_test` | UI formatter unit tests |
| `nexa_theme_test` | Every theme: palette completeness, WCAG contrast per role, unique accent + motion trio, every motion style paints |
| `nexa_mega_crypto_test` | MEGA key folding, attribute decryption, AES-CTR + chunked CBC-MAC vs a reference |
| (ctest) | `public_url`, `cloud_providers`, `range_integrity`, `database_persistence`, `themes` also run |

## Architecture

The app has a unified download queue that treats HTTP files, HLS/DASH streams, YouTube (via yt-dlp), and BitTorrent identically — same signals, same scheduler, same UI row.

**Core data flow:**
```
Browser Extension → nexa-host (stdio) → IpcServer (unix socket "nexa-ipc")
                                               ↓
User pastes URL ──────────────────────→ DownloadEngine
                                               ↓
                    ┌──────────────────────────┼────────────────────────┐
                    ▼                          ▼                        ▼
             DownloadTask              HlsGrabber / YtDlpGrabber   TorrentManager
          (segmented HTTP)             (subprocess: ffmpeg/yt-dlp)  (libtorrent)
                    ↓                          ↓                        ↓
                                      MainWindow (Qt UI) via signals
```

**Key design decisions:**
- **Single-threaded:** All async I/O runs on Qt's event loop — no worker threads, no mutexes.
- **Dynamic re-segmentation:** When a segment worker finishes early, it steals the tail of the longest remaining segment (IDM-style speed, no threads).
- **Self-registering native host:** On every launch, `NativeHostRegistrar` refreshes browser manifests so no manual install is needed.
- **Browser extension auto-install:** on every launch `extinstall::registerExtensions()` (`src/ipc/ExtensionInstaller.cpp`) detects installed browsers and hands each one the extension *from its own store* — Chromium family via an "external extension" entry (HKCU registry on Windows, `External Extensions/<id>.json` on macOS, `/usr/share/<browser>/extensions/<id>.json` or a `normal_installed` managed policy on Linux), Firefox via an `ExtensionSettings` policy pointing at a signed `.xpi`. The store ids live in **one** file, `packaging/extension-ids.env` (bundled in the qrc, sourced by `packaging/register-browser-extensions` from the .deb postinst, parsed into NSIS lines by `build.yml`); an empty id makes that browser report "waiting for the store listing" in the setup guide instead of silently doing nothing. Linux hooks are system-wide, so the app only verifies them at runtime; `sudo nexa --register-extensions` writes them for non-.deb installs. Snap/flatpak browsers cannot read any of these hooks and are reported as manual. Nothing can auto-install an unpublished extension.
- **Domain-scoped auth:** `AuthenticationManager` maintains per-domain `cookies.txt` files that are passed as `--cookies` flags to yt-dlp.
- **MEGA in-process:** `MegaGrabber` decrypts AES-128-CTR as bytes stream in (OpenSSL libcrypto, already a libtorrent dependency) and verifies MEGA's chunked CBC-MAC before marking done — no openssl CLI, no temp file, no GUI stall.
- **Ads (Free plan only):** `AdService` polls `GET /api/ads?placement=app_banner` and `AdBanner` draws the strip above the download list. Entitlement is checked **twice on purpose** — `AdService` refuses to fetch or emit once the licence reports pro/team, and the server independently returns `{adFree:true, ads:[]}` for a paid licence token. `AD_FREE_PLANS` in `backend/src/utils/ads.js` is the single source of truth; an absent/forged/expired token resolves to `free` (sees ads), never to ad-free. The client re-validates every link is `https` even though the server already does. Admins manage ads in the admin panel (`/admin/ads`).
- **License offline grace:** `LicenseManager` caches the last server-confirmed plan; a network failure keeps a paid plan for 7 days. A 7-day Pro trial is signalled by `trial: true` from `/api/license/validate`.
- **Seats are concurrent, not permanent:** a licence covers N machines *at a time*. The device id is a SHA-256 of the primary MAC (lowest-numbered up Ethernet/Wi-Fi interface, so VPN/Docker adapters can't change it) plus `machineUniqueId` — the raw MAC never leaves the machine. `LicenseManager` heartbeats every 5 min to hold a 15-min server-side lease and calls `releaseSeat()` on exit; a crash frees the seat when the lease lapses. A full licence answers `reason:"seat_limit"`, which keeps the key and says "close Nexa elsewhere" — it is deliberately **not** treated as a bad licence.
- **Entitlements come from the server:** `/api/license/validate` returns a `features` object (and embeds it in the signed token). `Entitlements` in `LicenseManager.h` defaults to the **Free** set, so a build that is offline before its first validation gates rather than leaks. `DownloadEngine::applyLicensePlan` reads it for the concurrency cap, AI rename and `authSiteDownloads`; login-gated course sites (Udemy, Coursera, LinkedIn Learning) are refused in `addDownload` with `downloadBlocked`. Free gets the two core themes — `ThemeGalleryDialog` still renders every paid theme's real preview behind a PRO badge, because the gallery is the upgrade's best advert.
- **Update feed:** `UpdateChecker` polls `https://nexadownloadmanager.com/api/releases/feed?os=<platform>` (`{version,url,notes,sha256}`); the installer is downloaded through the engine with the checksum enforced, then launched. Admins now **upload** the installer itself (raw `application/octet-stream` PUT, streamed to disk, SHA-256 computed in flight) instead of pasting a URL and a hash; the download route serves it with byte-range support so a dropped transfer resumes.
- **Scheduler persistence:** scheduled jobs live in the SQLite `scheduled` table (URL/time/name only — never headers) and re-arm on startup.
- **Theming:** every colour comes from `theme::current()`; one stylesheet template is generated per theme. Never hard-code a colour in a widget. 64 built-in themes live in `src/ui/Theme.cpp`: Nexa Dark and Nexa Light are hand-tuned palettes, the rest are derived from a one-line `Recipe` (ground, panel, border, two text tones, three brand stops, five status hues) by `build()`. Adding a theme = adding a `Recipe` row. `ThemeGalleryDialog` renders each as a live miniature of the real layout; `tests/ThemeContrastTest.cpp` asserts WCAG contrast for every role in every theme.
- **Row hover is painted by the view, not by QSS:** there is deliberately no `QTableWidget::item:hover` rule. Qt applies it per cell and the cells that carry widgets never show it, so a row lit up block by block. `ReorderTable` (MainWindow.cpp) paints one band under the hovered row with a short `QVariantAnimation` fade — a plain hover, no travelling highlight. Moves over cell widgets stop at that widget, so the band is fed from an application event filter, not from the viewport's `mouseMoveEvent`.
- **Motion is part of the theme:** `Palette::motion` names the gauge style (`Meter`: arc/ring/bars/needle/orbit/wave), sparkline style (`Spark`: line/area/bars/dots/steps/ribbon), loading animation (`Loader`: bounce/shimmer/stripes/pulse/comet/dash/segments/wave), progress fill (`Fill`: gradient/solid/striped/glow/stepped) and a `tempo`. Everything that moves is painted by `src/ui/Motion.cpp` (`paintGauge`, `paintSpark`, `paintLoader`, `paintFill`) and `motion::ThemedBar` replaces `QProgressBar` wherever a bar is shown. `motion::clock()` is the one animation phase (seconds × tempo); `motion::Ticker` is the one repaint timer, retained only by widgets that currently need frames. The theme test refuses two themes with the same gauge/spark/loader trio or the same accent, and paints every style with every palette.
- **Translations:** user-facing strings go through `tr()`. `tools/extract-translations.py` regenerates `translations/*.ts`; CMake compiles them when Qt LinguistTools is present.
- **Ad scheduling columns are DATETIME, not TIMESTAMP:** `ads.starts_at`/`ends_at` hold admin-chosen instants that can be years out, and TIMESTAMP stops at 2038-01-19 (scheduling past it is a MySQL error, not a warning). `initSchema` retypes them idempotently via `ensureColumnType`.
- **Database timezone:** the MySQL pool pins every connection to UTC (`config/db.js`). Without it `NOW()` and the driver disagree on any server not already on UTC, and every stored date reads back offset.

## Key Source Locations

| Path | Role |
|------|------|
| `src/core/DownloadEngine.{h,cpp}` | Top-level controller — owns all tasks, grabbers, torrents, scheduler |
| `src/core/DownloadTask.{h,cpp}` | One HTTP download: probing, segmentation, pause/resume, persistence |
| `src/core/Database.{h,cpp}` | SQLite: `downloads` + `segments` tables, segment offset persistence |
| `src/core/Types.h` | `DownloadState`, `SegmentInfo`, `HeaderList` shared types |
| `src/ipc/IpcServer.{h,cpp}` | Local socket listener, 4-byte framed JSON protocol |
| `src/ipc/NativeHostRegistrar.{h,cpp}` | Writes native host manifests for Chrome/Firefox/Edge/Brave |
| `src/grabber/HlsGrabber.{h,cpp}` | .m3u8 fetch → segment download → FFmpeg mux |
| `src/site/YtDlpGrabber.{h,cpp}` | yt-dlp subprocess wrapper, playlist parallelism |
| `src/torrent/TorrentManager.{h,cpp}` | libtorrent session (DHT, PEX, rate limits, seed ratio) |
| `src/auth/AuthUtils.{h,cpp}` | Cookie export + domain-scoped auth for authed sites |
| `src/ui/MainWindow.{h,cpp}` | Qt desktop UI: download table, toolbar, system tray |
| `src/ui/Theme.{h,cpp}` | Theme catalogue (64 looks, each with its own motion) → the whole app stylesheet; palettes are derived from seed `Recipe`s |
| `src/ui/ThemeGalleryDialog.{h,cpp}` | Themes gallery: live app-miniature card per theme (with its spark + loader), search, applies on click |
| `src/ui/Motion.{h,cpp}` | Theme-styled gauge / sparkline / loader / fill painters, `ThemedBar`, the shared `Ticker` |
| `src/ads/AdService.{h,cpp}` | Fetches + rotates Free-plan promos; hard no-op on a paid plan |
| `src/ui/AdBanner.{h,cpp}` | The sponsored strip above the download list (hides itself when there is nothing) |
| `src/ui/Localization.{h,cpp}` | Loads `nexa_<lang>.qm`, handles right-to-left |
| `src/ui/FirstRunWizard.{h,cpp}` | First-launch setup: folder → extension → test download |
| `src/ui/LinkGrabberDialog.{h,cpp}` | IDM-style "download all links" picker |
| `src/core/ProxyConfig.{h,cpp}` | HTTP/SOCKS5 proxy for Qt and the external tools |
| `src/core/Portable.{h,cpp}` | Portable mode (`portable.txt` beside the exe) |
| `src/core/VirusScanner.{h,cpp}` | Optional post-download scan via Defender / ClamAV |
| `src/core/DownloadImport.{h,cpp}` | Parse IDM `.ef2`, JDownloader `.crawljob`, link lists |
| `src/web/WebServer.{h,cpp}` | REST API + dashboard for phone remote control |
| `src/ai/AiClient.{h,cpp}` | Anthropic API: smart rename + natural-language scheduling |
| `native-host/nexa-host.cpp` | Bridge: reads stdio native messages, relays to IpcServer |
| `extension-chromium/background.js` | MV3 service worker: intercept, sniff, quality pick, cookie capture |
| `extension-chromium/content.js` | Page-injected: the on-video Download button + its quality dropdown, HLS/DASH detection |

## IPC Protocol

**nexa-host → IpcServer:** 4-byte little-endian length prefix + UTF-8 JSON over `QLocalSocket("nexa-ipc")`.

```json
// Incoming (from browser extension via nexa-host)
{
  "type": "download",
  "url": "https://...",
  "headers": [["cookie", "val"], ["user-agent", "Mozilla/..."]],
  "suggestedName": "Title.mp4",
  "siteFormat": "1080",
  "playlist": false
}

// Reply
{ "ok": true, "id": 42 }

// Other message types (same framing):
{ "type": "ping" }                      // → { ok, version, plan, active, queued }
{ "type": "show" }                      // → { ok } — raise the main window
{ "type": "list-formats", "url": … }    // → yt-dlp qualities for the picker
{ "type": "links", "pageUrl", "pageTitle",
  "links": [ { "url", "text", "kind": "link|image|media" } ], "headers": [[name, value]] }
                                        // → { ok, count } and opens the link-grabber dialog
```
`download` also accepts `ask: true` (extension option "ask before handing off"),
which makes the app treat the handoff as unconfirmed so its confirm prompt runs.

Single-instance guard: on launch, `main.cpp` probes the socket — if alive, forwards CLI URLs and exits.

## External Runtime Dependencies

These must be on `PATH` or bundled (the `.deb` bundles them):
- `ffmpeg` — HLS/DASH muxing
- `yt-dlp` — YouTube and 1000+ site support
- `aria2c` — optional accelerated HTTP fallback

## Runtime Auth Sites

Extension captures cookies for: Udemy, Vimeo, Coursera, Skillshare, Pluralsight, LinkedIn Learning. List is in `extension-chromium/background.js` (`AUTH_SITES` array).
