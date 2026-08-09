# Nexa Browser Integration — Chrome / Edge / Brave

One Manifest V3 extension runs in **all Chromium browsers** (Google Chrome,
Microsoft Edge, Brave, Opera, Vivaldi). It intercepts downloads, captures the
tab's cookies / User-Agent / referrer, sniffs HLS/DASH/media streams, and hands
everything to the Nexa desktop app over native messaging.

> Firefox uses the sibling `../extension-firefox/` build (same code, MV2 wrapper).

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

## Package for the stores

```bash
./package.sh          # produces ../dist/nexa-chrome.zip and ../dist/nexa-edge.zip
```

Upload `nexa-chrome.zip` to the Chrome Web Store and `nexa-edge.zip` to the
Microsoft Edge Add-ons portal (the artefacts are identical; they're named per
store for convenience).

## What it does

- **Download interception** — `chrome.downloads.onCreated` → cancel → hand to Nexa.
- **Header capture** — `chrome.cookies` plus the short-lived headers from the
  browser's real ChatGPT/AI attachment request (including `Authorization` when
  present), so authenticated / CDN links don't 403.
- **Verified file sources** — browser downloads from **ChatGPT**, **Google
  Gemini**, **Google Drive**, and **Google Photos** have been tested end to end,
  including signed/CDN-backed attachments and browser-provided filenames.
- **AI provider registry** — request-context capture is configured for **Claude**,
  **Grok**, **Perplexity**, **Mistral Le Chat**, **DeepSeek**, **Poe**,
  **Character.AI**, **Pi**, and **You.com**. Their browser-owned attachment
  hosts are mapped to the correct credential scope before Nexa replays requests.
- **Video grabber (IDM-style)** — when a page is playing video, a floating
  **"Download Video"** pill appears. Click it to see the available
  **qualities** (parsed from the HLS master playlist — 1080p / 720p / …); pick
  one and that exact stream is grabbed and muxed to MP4, named from the page
  title and sorted into `Video/`.
- **YouTube** — on a `youtube.com/watch` (or Shorts) page the pill offers
  Best / 1080p / 720p / 480p / 360p / Audio. The desktop app downloads the
  chosen quality with **yt-dlp** (handles signatures/SABR + video+audio mux).
  Requires `yt-dlp` installed on the system.
- **Media sniffing** — `webRequest` detects `.m3u8` / `.mpd` / `.mp4` / media.
- **Context menus** — "Download with Nexa", "Download all links on page".
