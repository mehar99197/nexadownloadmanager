# Nexa Download Manager

A cross-platform, multi-connection download manager built to **beat IDM** —
segmented downloads, pause/resume, browser integration via native messaging,
media-stream grabbing, and more. C++ / Qt 6.

> Full roadmap & rationale: see the approved plan in
> `~/.claude/plans/` and the architecture notes below.

## What works today (Phase 0–3)

- **Segmented download engine** — splits a file into up to 16 byte-range
  connections (HTTP `Range`), writes each part in place into a pre-allocated
  file, and merges with zero final copy.
- **Pause / resume** — per-segment progress persisted to SQLite; resumes after
  app restart from exactly where it stopped.
- **Redirect + range-support detection** via a `bytes=0-0` probe.
- **Qt desktop UI** — live table of downloads with progress bars & speed.
- **Native messaging bridge** (`nexa-host`) + **IPC server** in the engine.
- **Browser extensions** (Chromium MV3 + Firefox) — intercept downloads,
  capture cookies/UA/referrer, sniff HLS/DASH/media, right-click handoff.

## Build

Prerequisites (Debian/Kali):

```bash
sudo apt-get update
sudo apt-get install -y cmake ninja-build qt6-base-dev libqt6sql6-sqlite
```

Configure & build:

```bash
cmake -B build -G Ninja
cmake --build build
```

This produces `build/nexa` (the app) and `build/nexa-host` (the bridge).

## Run

```bash
./build/nexa                                   # open the UI
./build/nexa "https://example.com/big.iso"     # or download from the CLI
```

Use **Add URL** in the toolbar (it auto-fills a URL from your clipboard).

## Install the browser integration

1. Build the project (so `build/nexa-host` exists).
2. **Chromium:** go to `chrome://extensions`, enable Developer Mode,
   *Load unpacked* → select `extension-chromium/`. Copy the generated
   **extension id**.
3. Register the native host:
   ```bash
   ./native-host/install.sh ./build/nexa-host <chrome-extension-id>
   ```
4. **Firefox:** run `extension-firefox/build.sh`, then load
   `extension-firefox/manifest.json` via `about:debugging` → *This Firefox*
   → *Load Temporary Add-on*. The same `install.sh` already registered the
   Firefox host.

## Architecture

```
Browser Extension ──native messaging (framed JSON)──▶ nexa-host
        │                                                  │
        │ captures cookies / UA / referrer / media URLs    │ local socket (nexa-ipc)
        ▼                                                  ▼
   right-click / intercept                          Nexa Engine (Qt)
                                                     ├─ DownloadEngine
                                                     ├─ DownloadTask (segments)
                                                     ├─ SegmentDownloader ×N
                                                     ├─ IpcServer
                                                     └─ Database (SQLite)
```

## Roadmap (next)

- Phase 4: HLS/DASH grabber → mux to MP4 with FFmpeg.
- Phase 5: queues, scheduler, batch import.
- Phase 6: BitTorrent (libtorrent), AI features, remote web dashboard.
- Phase 7: installers, auto-update.
