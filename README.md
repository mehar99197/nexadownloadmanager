# Nexa Download Manager

A cross-platform, multi-connection download manager built to **beat IDM** —
segmented downloads, pause/resume, browser integration via native messaging,
media-stream grabbing, and more. C++ / Qt 6.

> Full roadmap & rationale: see the approved plan in
> `~/.claude/plans/` and the architecture notes below.

## What works today (Phase 0–6)

- **Segmented download engine** — splits a file into up to 16 byte-range
  connections (HTTP `Range`), writes each part in place into a pre-allocated
  file, and merges with zero final copy.
- **Pause / resume** — per-segment progress persisted to SQLite; resumes after
  app restart from exactly where it stopped.
- **Redirect + range-support detection** via a `bytes=0-0` probe.
- **Qt desktop UI** — live table of downloads with progress bars & speed.
- **Native messaging bridge** (`nexa-host`) + **IPC server** in the engine.
- **Browser extensions** (Chrome + Chromium MV3 + Firefox) — intercept downloads,
  capture cookies/UA/referrer, sniff HLS/DASH/media, right-click handoff.
- **HLS/DASH stream grabber** — parses `.m3u8` master + media playlists,
  picks the highest-bitrate variant, downloads all segments in parallel,
  passes through `#EXT-X-KEY` decryption, and muxes to MP4 with FFmpeg
  (`-c copy`, no re-encode). DASH `.mpd` handled via FFmpeg directly.
  *Verified end-to-end: a generated HLS stream grabs to a valid h264+aac MP4.*
- **Queue + scheduler** — a concurrency limit (default 4) keeps N downloads
  active and auto-promotes queued ones as slots free; `scheduleDownload()`
  starts a download at a future time. *Verified: with `--max=2`, 6 batched
  downloads never exceeded 2 concurrent and all were byte-correct.*
- **Batch add** — expands numeric ranges (`file[1-20].jpg`) and multi-URL
  lists into individual downloads.
- **Auto-categorize** — completed files are sorted into `Video/`, `Audio/`,
  `Documents/`, `Compressed/`, `Programs/`, `Images/`, `Other/`.
- **BitTorrent** — magnet links and `.torrent` files download in the *same*
  app via libtorrent (DHT + peer exchange), with live peers/seeds/speed and
  pause/resume. Something IDM can't do at all. *Verified end-to-end: a full
  755 MB Debian ISO downloaded from a live swarm with a SHA256 matching
  Debian's official checksum exactly.*

## Build

Prerequisites (Debian/Kali):

```bash
sudo apt-get update
sudo apt-get install -y cmake ninja-build qt6-base-dev libqt6sql6-sqlite \
                        libtorrent-rasterbar-dev ffmpeg
```

`ffmpeg` is needed at runtime for the stream grabber;
`libtorrent-rasterbar-dev` for BitTorrent.

Configure & build:

```bash
cmake -B build -G Ninja
cmake --build build
```

This produces `build/nexa` (the app) and `build/nexa-host` (the bridge).

## Run

```bash
./build/nexa                                       # open the UI
./build/nexa "https://example.com/big.iso"         # HTTP/FTP download
./build/nexa "https://site/playlist.m3u8"          # grab an HLS/DASH video
./build/nexa "magnet:?xt=urn:btih:..."             # BitTorrent
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

- ~~Phase 4: HLS/DASH grabber → mux to MP4 with FFmpeg.~~ ✅ done
- ~~Phase 5: queues, scheduler, batch import, auto-categorize.~~ ✅ done
- Phase 6: ~~BitTorrent (libtorrent)~~ ✅ done · AI features · remote web dashboard.
- Phase 7: installers, auto-update.

### CLI flags

```
nexa [--max=N] [--no-categorize] [--batch] [--resume-all] <url|pattern>...
  --max=N          max simultaneous downloads (queue the rest)
  --no-categorize  save straight to the download dir (no type subfolders)
  --batch          exit once all downloads/streams finish (for scripts)
  --resume-all     resume downloads interrupted in the previous run
  pattern          e.g. "http://host/file[1-20].jpg" expands to 20 downloads
```
