# Nexa Download Manager — Beat IDM Battle Plan

## Context

**The challenge:** A CS teacher bet the team they *can't* build something more advanced than Internet Download Manager (IDM). This plan is the blueprint to win that bet.

**Why this is winnable:** IDM is a closed-source, paid, **Windows-only** app with a dated UI and no torrent / cloud / mobile / AI support. We exploit every one of those gaps.

**Decisions locked with the user:**
- Platform: **Cross-platform desktop** (Windows / macOS / Linux)
- Stack: **C++ with Qt 6** (native speed + truly cross-platform — the only cross-platform option of the two the user picked)
- Scope: **Kitchen sink** — match every IDM feature, then add the advantages
- Browser extensions: **Chromium (Chrome/Edge/Brave) + Firefox**

**Intended outcome:** A working cross-platform downloader with a segmented multi-connection engine, browser extensions that hand off downloads via native messaging, a media/stream grabber, a torrent client, and AI-assisted features — clearly surpassing IDM.

---

## How IDM Works (the target we're beating)

IDM = **3 cooperating pieces**:

1. **Desktop engine** — segmented multi-threaded HTTP/FTP downloader with pause/resume (HTTP `Range` headers), queues, scheduler, speed limiter, media grabber (HLS/DASH), auto-categorize.
2. **Browser extension ("IDM Integration Module")** — intercepts clicks/downloads, sniffs `.m3u8`/`.mpd`/media URLs, captures the tab's **cookies + headers + referrer + user-agent**, cancels the browser download, hands off to the engine.
3. **The bridge** — browsers cannot launch a `.exe` directly. IDM uses **Native Messaging**: extension ⇄ JSON-over-stdio ⇄ a tiny native host ⇄ the engine. Fallback: clipboard / file-type monitoring.

**The #1 thing clones get wrong:** the bridge and the header/cookie capture. Get those right and the rest is execution.

---

## Target Architecture (Nexa)

```
┌─────────────────────────────────────────────────────────────┐
│  Browser Extension (MV3 Chromium + Firefox WebExtension)     │
│  • download/click interception (chrome.downloads, webRequest)│
│  • media sniffer (m3u8/mpd/mp4)                              │
│  • capture cookies + headers + referrer + UA                │
└───────────────┬─────────────────────────────────────────────┘
                │ Native Messaging (JSON over stdio)
┌───────────────▼─────────────────────────────────────────────┐
│  nexa-host  (small C++ native-messaging executable)          │
│  • validates message, relays to engine over local socket     │
└───────────────┬─────────────────────────────────────────────┘
                │ Local IPC (QLocalSocket / named pipe / loopback)
┌───────────────▼─────────────────────────────────────────────┐
│  Nexa Engine (C++/Qt core — runs as the app + tray daemon)   │
│  ┌─────────────┬──────────────┬───────────────┬───────────┐  │
│  │ Download    │ Stream       │ Torrent       │ Scheduler │  │
│  │ Engine      │ Grabber      │ Engine        │ + Queues  │  │
│  │ (segmented) │ (HLS/DASH)   │ (libtorrent)  │           │  │
│  └─────────────┴──────────────┴───────────────┴───────────┘  │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Persistence (SQLite) · Settings · History · Resume    │    │
│  └──────────────────────────────────────────────────────┘    │
└───────────────┬─────────────────────────────────────────────┘
                │ Qt Widgets / QML UI  +  optional local web dashboard
┌───────────────▼─────────────────────────────────────────────┐
│  Modern UI (QML/Qt Quick) + system tray + notifications      │
└─────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Language | **C++17/20** | Native speed, matches IDM's class |
| App framework | **Qt 6** (Widgets or **QML/Qt Quick**) | Cross-platform UI + networking + threading |
| HTTP/networking | **Qt Network** (`QNetworkAccessManager`) or **libcurl** | Range requests, proxies, TLS |
| Torrent | **libtorrent-rasterbar** | Battle-tested BitTorrent |
| HLS/DASH mux | **FFmpeg** (libav* or CLI) | Segment download + mux to MP4 |
| Storage | **SQLite** (Qt SQL) | History, queue, resume state, segments |
| Native host | small standalone **C++** exe | Native messaging stdio protocol |
| Extensions | **MV3** (Chromium) + **WebExtension** (Firefox), JS/TS | Interception + sniffing |
| Build | **CMake** + (optional) **Conan/vcpkg** | Cross-platform builds |
| Packaging | **Inno Setup** (Win) · **.dmg** (Mac) · **AppImage/.deb** (Linux) | Native installers |

---

## Feature Roadmap (phased — kitchen sink)

### Phase 0 — Foundations
- CMake project skeleton, Qt6 app shell, tray icon, SQLite schema, settings store.
- Logging, crash handling, single-instance lock.

### Phase 1 — Core Download Engine (the heart — must be excellent)
- **Segmented download:** split file into N parts via HTTP `Range`; N adaptive (2–32) based on size + server support (`Accept-Ranges`).
- One `QThread`/worker per segment; merge on completion.
- **Pause / resume** persisted to SQLite (per-segment offsets) → survives app/OS restart.
- **Auto-retry / reconnect** on dropped connections; dynamic re-allocation of idle threads to slow segments.
- Speed **limiter / throttle**; global + per-download.
- Protocols: HTTP, HTTPS, FTP; **proxy** (HTTP/SOCKS5, authenticated); cookies, custom headers, referrer, user-agent.
- Checksum verify (MD5/SHA-256) — **IDM doesn't auto-verify; we do.**

### Phase 2 — Native Messaging Bridge
- `nexa-host` C++ exe implementing the [native messaging protocol](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) (4-byte length prefix + JSON over stdio).
- Register host manifests for Chrome/Edge/Brave + Firefox (platform-specific paths/registry).
- Relay messages to running engine via `QLocalSocket`; auto-launch engine if not running.

### Phase 3 — Browser Extensions (Chromium MV3 + Firefox)
- Intercept downloads (`chrome.downloads.onDeterminingFilename` / cancel + handoff).
- **Capture cookies (`chrome.cookies`), request headers, referrer, UA** for the URL — essential for authed downloads.
- Context-menu "Download with Nexa" + "Download all links / images".
- Floating **"Download this video"** button injected on pages with media.
- `webRequest` sniffer to detect `.m3u8` / `.mpd` / media streams → offer quality picker.

### Phase 4 — Media / Stream Grabber (beat IDM here)
- Parse **HLS (.m3u8)** master + variant playlists; download all `.ts`/fMP4 segments in parallel; **mux to MP4 via FFmpeg**.
- **MPEG-DASH (.mpd)** support (video+audio adaptation sets, pick quality).
- Subtitle + audio-track extraction; **whole-playlist** download.
- Format/quality/resolution picker UI.

### Phase 5 — Queues, Scheduler, Automation
- Multiple **queues** with concurrency limits.
- **Scheduler:** start/stop times, recurring syncs, "download then sleep/shutdown/quit."
- Batch downloads, **import URL list**, wildcard/range batch (`file[1-100].jpg`).
- Auto-categorize by type into folders; post-download actions (open, scan, run command).

### Phase 6 — Advantages IDM Doesn't Have (these win the bet)
- **BitTorrent + magnet** support (libtorrent) — one app for HTTP *and* torrents.
- **Cloud downloads** — paste a Google Drive / Mega / direct cloud link, server-side fetch.
- **Checksum + malware scan** hook (VirusTotal API / local AV) on completion.
- **AI features** (Claude API):
  - Smart auto-categorization & rename from content.
  - Natural-language scheduling ("download these every night at 2am").
  - Bulk **link extraction** from a pasted page / smart playlist parsing.
  - Optional summarize/describe downloaded docs.
- **Remote control web dashboard** (local HTTP server) — start/monitor downloads from phone/browser.
- **Cross-device sync** of queue/history (optional account or self-hosted).
- Modern **dark/light theming**, drag-and-drop, global hotkeys.

### Phase 7 — Polish & Packaging
- Installers for all 3 OSes; auto-update; onboarding; i18n; accessibility.

---

## Proposed Project Structure

```
Nexa Download Manager/
├── CMakeLists.txt
├── engine/                  # C++/Qt core
│   ├── core/                # DownloadEngine, Segment, Worker, Throttler
│   ├── protocols/           # http, ftp, hls, dash
│   ├── torrent/             # libtorrent wrapper
│   ├── grabber/             # m3u8/mpd parsers + ffmpeg mux
│   ├── ipc/                 # QLocalServer, message router
│   ├── db/                  # SQLite schema + DAOs
│   ├── scheduler/           # queues + cron-like scheduling
│   └── ai/                  # Claude API client (optional features)
├── ui/                      # QML/Qt Quick front-end
├── native-host/             # nexa-host native messaging exe + manifests
│   ├── nexa-host.cpp
│   └── manifests/           # chrome.json, firefox.json + install scripts
├── extension-chromium/      # MV3: manifest.json, background SW, content, popup
├── extension-firefox/       # WebExtension variant
├── dashboard/               # optional local web remote-control UI
├── installers/              # inno setup / dmg / appimage scripts
└── docs/                    # architecture, protocol specs, demo script for teacher
```

---

## Key Technical Notes (where clones fail — get these right)

1. **Segment merge integrity:** write each segment to its own offset in a pre-allocated sparse file (`QFile::resize`) rather than separate temp files + concat — avoids a huge final copy and corruption.
2. **Resume correctness:** persist `(segmentIndex, startByte, endByte, bytesDone)` to SQLite after every flush; on restart, re-issue `Range: bytes=start+done-end`.
3. **Server capability detection:** check `Accept-Ranges: bytes` + `Content-Length` via a `HEAD` (or ranged `GET`) before segmenting; fall back to single stream if unsupported.
4. **Header/cookie fidelity:** the engine must replay the *exact* cookies/UA/referrer the extension captured, or authed/CDN links 403.
5. **Native messaging:** message framing is a **little-endian uint32 length prefix** then UTF-8 JSON; host path registration differs per browser/OS — script it.
6. **FFmpeg muxing:** download HLS segments in order to a temp dir, then `ffmpeg -i playlist -c copy out.mp4` (no re-encode = fast).

---

## Verification / Demo Plan (proving you beat IDM to the teacher)

1. **Speed test:** download the same large file (e.g. a Linux ISO) in Nexa vs IDM vs plain browser — show Nexa's segmented engine matching/beating IDM. Graph segment threads live.
2. **Resume test:** start a big download, kill the app / pull network, relaunch → confirm it resumes from disk, not from zero.
3. **Extension handoff:** click a download link in Chrome and Firefox → browser cancels, Nexa takes over with captured cookies (test on an authed/CDN URL).
4. **Stream grab:** open a page with an HLS/DASH video → floating button → pick quality → muxed MP4 output.
5. **Torrent:** add a magnet link → downloads in the *same* app (IDM can't).
6. **AI demo:** type "download all these and sort by type, then shut down PC at finish" → show it scheduled.
7. **Cross-platform:** run the same build on Windows + Linux (+ Mac if available) — the killer slide, since **IDM is Windows-only.**
8. **Remote control:** start a download from your phone's browser via the local dashboard.

Build/run during dev: `cmake -B build && cmake --build build && ./build/nexa` (with Qt6 + libtorrent + FFmpeg installed via vcpkg/Conan).

---

## Suggested Build Order (so you always have something working)

1. Phase 0 + Phase 1 single-connection download → **then** add segmentation. (Always-runnable.)
2. Phase 2 + 3 bridge + extension (Chromium first, then Firefox).
3. Phase 4 stream grabber.
4. Phase 5 queues/scheduler.
5. Phase 6 advantages (torrent → AI → remote → cloud), in that order of impact.
6. Phase 7 packaging for the demo.

> **Where to start coding:** Phase 0 skeleton + Phase 1 engine. That single segmented downloader is 60% of "is this real?" — nail it first, demo it, then expand.
