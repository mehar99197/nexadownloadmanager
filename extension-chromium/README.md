# Nexa Browser Integration — Chrome / Edge / Brave

One Manifest V3 extension runs in **all Chromium browsers** (Google Chrome,
Microsoft Edge, Brave, Opera, Vivaldi). It intercepts downloads, captures the
tab's cookies / User-Agent / referrer, sniffs HLS/DASH/media streams, and hands
everything to the Nexa desktop app over native messaging.

> Firefox uses the sibling `../extension-firefox/` build (same code, its own MV3 manifest — Firefox runs the background script as an event page instead of a service worker).

## Install (unpacked, for development / the challenge demo)

The steps are identical across Chromium browsers — only the URL differs:

| Browser | Open this |
|---------|-----------|
| Chrome  | `chrome://extensions` |
| Edge    | `edge://extensions` |
| Brave   | `brave://extensions` |

1. Build the desktop app first so `build/nexa-host` exists (see the top-level README).
2. Open the extensions page above and turn on **Developer mode**.
3. Click **Load unpacked** and select this `extension-chromium/` folder.
4. Copy the **extension ID** shown on the card.
5. Register the native-messaging host with that ID:
   ```bash
   ../native-host/install.sh ../build/nexa-host <extension-id>
   ```
   (The installer writes the host manifest for Chrome, Edge, Brave and Firefox.)
6. Reload the extension. Click any download link — the browser hands it to Nexa.

The manifest carries a fixed `key`, so an unpacked/dev install always gets the
ID `cbogjffoidaepbcbogbfibnldhkckhpb` — the ID the installers and the desktop
app's native-host allowlist already know.

## Package for the stores

```bash
./package.sh
```

produces four zips in `../dist/`:

| Zip | Manifest `key` | Use |
|-----|----------------|-----|
| `nexa-chrome.zip`, `nexa-edge.zip` | kept | Development / side-loading — the extension ID stays `cbogjffoidaepbcbogbfibnldhkckhpb`. |
| `nexa-chrome-store.zip`, `nexa-edge-store.zip` | **removed** | Upload to the Chrome Web Store / Microsoft Edge Add-ons. The stores refuse a manifest with a `key` and assign their own extension ID. |

The Chrome and Edge artefacts are identical; they are named per store for
convenience. `package.sh` fails if the store zip still contains a `key`.

**After publishing:** the store assigns a new extension ID. The desktop app
only accepts native-messaging connections from allowlisted IDs, so add the
store-assigned ID to the app's allowlist — the app reads extra IDs from the
`NEXA_EXTRA_EXTENSION_IDS` environment variable (comma-separated) / its
settings, and its `NativeHostRegistrar` writes them into the browser host
manifests on the next launch.

## Toolbar popup, options, shortcut

- **Popup** (click the toolbar icon): connection status (pings the app and
  auto-launches it through the native host), master **Take over downloads**
  switch, **Pause on this site**, **Grab all links on this page**, **Grab media
  on this page**, **Open Nexa**, and the last 8 handoffs.
- **Options** (popup → Options, or the extension's *Details → Extension
  options*): minimum size to take over, file-type list (or *All file types*),
  paused sites, ask-before-start, floating-button and notification switches,
  and **Export diagnostics** (copies settings + last errors as JSON — no
  cookies or credentials).
- **Shortcut:** `Alt+Shift+N` sends the current page to Nexa (change it at
  `chrome://extensions/shortcuts`).
- **Badge:** the toolbar icon shows how many media streams were sniffed on the
  active tab; a red `!` for 10 s means the app / native host could not be
  reached.

Settings live in `chrome.storage.local`:

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `true` | Master switch for download interception. |
| `minSizeMB` | `0` | Files smaller than this stay in the browser when the size is known (`0` = all sizes). |
| `interceptTypes` | common archive/installer/media/document extensions | Extensions to take over; `["*"]` = every file type. Downloads without a detectable extension are always offered to Nexa. |
| `disabledHosts` | `[]` | Hosts (and their subdomains) where Nexa neither intercepts nor sniffs. |
| `askBeforeHandoff` | `false` | Sends `ask: true` so the app confirms before starting. |
| `showFloatingButton` | `true` | The "Download with NDM" button shown over videos. |
| `notifyOnHandoff` | `true` | "Sent to Nexa: …" system notification. |
| `recent` | `[]` | Last 8 handoffs (name, host, time, ok/failed) shown in the popup. |
| `lastErrors` | `[]` | Last 20 errors, included in the diagnostics export. |

## What it does

- **Download interception** — `chrome.downloads.onCreated` → cancel → hand to Nexa
  (subject to the size / type / paused-site settings above).
- **Header capture** — `chrome.cookies` plus the short-lived headers from the
  browser's real ChatGPT/AI attachment request (including `Authorization` when
  present), so authenticated / CDN links don't 403. The capture and the
  quality-probe cache are mirrored to `chrome.storage.session` (memory only,
  cleared when the browser closes) so they survive service-worker restarts.
- **Verified file sources** — browser downloads from **ChatGPT**, **Google
  Gemini**, **Google Drive**, and **Google Photos** have been tested end to end,
  including signed/CDN-backed attachments and browser-provided filenames.
- **AI provider registry** — request-context capture is configured for **Claude**,
  **Grok**, **Perplexity**, **Mistral Le Chat**, **DeepSeek**, **Poe**,
  **Character.AI**, **Pi**, and **You.com**. Their browser-owned attachment
  hosts are mapped to the correct credential scope before Nexa replays requests.
- **Video grabber (IDM-style)** — when a page is playing video, a compact
  **Download** button appears over the top-right of the player (on hover, and
  briefly when the page opens). Click it and the available **qualities**
  (parsed from the HLS master playlist — 1080p / 720p / …) drop down from the
  button; pick one and that exact stream is grabbed and muxed to MP4, named
  from the page title and sorted into `Video/`.
- **YouTube** — on a `youtube.com/watch` (or Shorts) page the button offers
  Best / 1080p / 720p / 480p / 360p / Audio. The desktop app downloads the
  chosen quality with **yt-dlp** (handles signatures/SABR + video+audio mux).
  Requires `yt-dlp` installed on the system.
- **Coursera, Skillshare, Threads** — yt-dlp has no extractor for these sites,
  so the button lists the video the page is actually streaming (start it
  playing first) instead of yt-dlp qualities.
- **Media sniffing** — `webRequest` detects `.m3u8` / `.mpd` / `.mp4` / media.
- **Context menus** — "Download with Nexa", "Download video/audio with Nexa",
  "Download all links on page" (sends ONE `links` message with every http(s)
  link — deduped, capped at 2000 — and the app opens its grabber dialog). There
  is no whole-course entry: yt-dlp cannot read a whole Udemy course, so a
  lecture is sent on its own from the Download button.

## Native-messaging protocol (extension → `nexa-host` → app)

| Message | Reply |
|---------|-------|
| `{ "type": "ping" }` | `{ "ok": true, "version": "0.1.0", "plan": "free"\|"pro"\|"team", "active": n, "queued": n }` |
| `{ "type": "download", "url", "referrer", "userAgent", "cookies", "filename", "quality", "playlist", "userInitiated", "ask", "headers": {…} }` | `{ "ok": true, "id": n }` |
| `{ "type": "links", "pageUrl", "pageTitle", "links": [{ "url", "text", "kind": "link"\|"image"\|"media" }…], "headers": [["cookie", "…"], ["user-agent", "…"], ["referer", "…"]] }` | `{ "ok": true, "count": n }` |
| `{ "type": "list-formats", "url" }` | `{ "ok": true, "qualities": […], "audioFormats": […] }` |
| `{ "type": "show" }` | `{ "ok": true }` |

## Privacy

The extension talks only to the locally installed Nexa app through the
browser's native-messaging bridge; it never sends browsing data to a server.
Cookies and request headers are forwarded to the app solely for the download
you asked for. Full policy: <https://nexadownloadmanager.com/privacy>.

## Tests

```bash
node tests/ExtensionProviderConfigTest.js   # provider registry (both copies)
node tests/ExtensionSettingsTest.js         # settings predicates + links/ping payloads (both copies)
```
