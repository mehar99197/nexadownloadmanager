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
./build/nexa_auth_test
./build/nexa_format_test

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
- **Domain-scoped auth:** `AuthenticationManager` maintains per-domain `cookies.txt` files that are passed as `--cookies` flags to yt-dlp.

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
| `src/web/WebServer.{h,cpp}` | REST API + dashboard for phone remote control |
| `src/ai/AiClient.{h,cpp}` | Anthropic API: smart rename + natural-language scheduling |
| `native-host/nexa-host.cpp` | Bridge: reads stdio native messages, relays to IpcServer |
| `extension-chromium/background.js` | MV3 service worker: intercept, sniff, quality pick, cookie capture |
| `extension-chromium/content.js` | Page-injected: floating download button, HLS/DASH detection |

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
```

Single-instance guard: on launch, `main.cpp` probes the socket — if alive, forwards CLI URLs and exits.

## External Runtime Dependencies

These must be on `PATH` or bundled (the `.deb` bundles them):
- `ffmpeg` — HLS/DASH muxing
- `yt-dlp` — YouTube and 1000+ site support
- `aria2c` — optional accelerated HTTP fallback

## Runtime Auth Sites

Extension captures cookies for: Udemy, Vimeo, Coursera, Skillshare, Pluralsight, LinkedIn Learning. List is in `extension-chromium/background.js` (`AUTH_SITES` array).
