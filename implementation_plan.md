# Fix Server-Based Downloads (Google Drive, Google Photos)

## Problem Summary

When a user clicks download on a file from **Google Drive** or **Google Photos** (or similar server-based/auth-gated file hosts), Nexa fails to download the actual file. The root causes are:

### Root Cause 1: Extension Blocks Server-Based Downloads Entirely

In [background.js](file:///home/anonhexor0001/Desktop/Work/nexadownloadmanager/extension-chromium/background.js#L42-L57), the `BROWSER_ONLY_HOSTS` blocklist forces Google Drive, `googleusercontent.com`, and GitHub downloads to bypass Nexa completely — the browser handles them instead of handing off to the desktop app. **Google Photos** (`photos.google.com`, `lh3.googleusercontent.com`) is also blocked because the CDN host `googleusercontent.com` is in the list.

```js
const BROWSER_ONLY_HOSTS = [
  "drive.google.com",
  "drive.usercontent.google.com",
  "docs.google.com",
  "googleusercontent.com",   // ← too broad, blocks Google Photos CDN too
  "github.com",
  "githubusercontent.com",
];
```

**Why this is wrong now:** The desktop app (`DownloadTask.cpp`) already has robust Google Drive handling (URL normalization, confirm-page parsing, redirect following with scoped credentials). And `yt-dlp` also has a working GoogleDrive extractor with `--cookies-from-browser`. So the extension shouldn't block these — it should hand them off with cookies.

### Root Cause 2: Google Photos Has No Support At All

- `isDirectFileUrl()` only matches `drive.google.com`, `drive.usercontent.google.com`, and `docs.google.com` — not `photos.google.com`.
- `isGoogleDriveHost()` in `DownloadTask.cpp` similarly doesn't match Photos URLs.
- Google Photos download URLs look like:
  - `https://photos.google.com/photo/AF1Q...` (viewing page)
  - `https://lh3.googleusercontent.com/...` (direct CDN image/video)
- The CDN URL (`lh3.googleusercontent.com`) **is** a direct file link that works with cookies, but the credential-scope logic strips the Google cookie when redirecting to the CDN because `googleusercontent.com` ≠ `google.com` under the current `registrableDomain()` logic.

### Root Cause 3: Credential Scoping Strips Google Cookies on CDN Hops

The `sameCredentialScope()` function in [DownloadTask.cpp](file:///home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/core/DownloadTask.cpp#L64-L69) compares registrable domains. `google.com` vs `googleusercontent.com` are treated as different first parties, so cookies captured from `drive.google.com` are stripped when the download redirects to `drive.usercontent.google.com` or `lh3.googleusercontent.com`. The code already handles `drive.usercontent.google.com` (same registrable domain `google.com`), but `googleusercontent.com` is a separate registrable domain.

## Proposed Changes

### Extension — Background Script

#### [MODIFY] [background.js](file:///home/anonhexor0001/Desktop/Work/nexadownloadmanager/extension-chromium/background.js)

1. **Remove Drive/Docs/GitHub from `BROWSER_ONLY_HOSTS`** — these are now handled properly by the desktop app with cookies from the extension. Keep the list only for hosts that genuinely can't work (none currently).
2. **Add Google Photos and Drive to the `handoff()` flow** — when the URL is from a Google service, export Google cookies (`.google.com` domain) as Netscape cookies.txt and send them alongside the download, so the desktop app can authenticate.
3. **Add Google Drive and Google Photos to `NEXA_AUTH_SITES`** — so their cookies are exported for yt-dlp.

---

### Desktop — C++ Core

#### [MODIFY] [DownloadTask.cpp](file:///home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/core/DownloadTask.cpp)

1. **Extend `isGoogleDriveHost()`** to also recognize `photos.google.com` and `video.google.com`.
2. **Add Google-specific credential scoping** — teach `sameCredentialScope()` that `google.com` and `googleusercontent.com` are the same first party (Google's CDN). Add a small allow-list of known Google CDN sibling domains so cookies survive the redirect hop.

#### [MODIFY] [YtDlpGrabber.cpp](file:///home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/site/YtDlpGrabber.cpp)

1. **Extend `isDirectFileUrl()`** to also match `photos.google.com` URLs that contain a photo/video ID.

#### [MODIFY] [BrowserLogin.cpp](file:///home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/auth/BrowserLogin.cpp)

1. **Add `drive.google.com` and `photos.google.com` to `authSites()`** so the auto-browser-login flow works for them.

---

### Firefox Extension (Mirror Changes)

#### [MODIFY] Extension files in `extension-firefox/` (if they exist and mirror chromium)

Mirror the same `BROWSER_ONLY_HOSTS` and auth-site changes.

## Open Questions

> [!IMPORTANT]
> **Google Photos scope**: Google Photos URLs can be:
> - Photo view pages (`photos.google.com/photo/...`) — these need yt-dlp (no direct download link)
> - Direct CDN links (`lh3.googleusercontent.com/...`) — these work with cookies via HTTP
> 
> Should we support both, or only direct CDN links? (Recommended: support both — yt-dlp has a `GooglePhotos` extractor.)

> [!IMPORTANT]
> **GitHub**: The current code also blocks GitHub in `BROWSER_ONLY_HOSTS`. GitHub release assets and raw files DO work with the native HTTP path if cookies are sent. Should we un-block GitHub too? (Recommended: yes, un-block it with cookie forwarding.)

## Verification Plan

### Automated Tests
```bash
# Build the project
cmake -B build -G Ninja
cmake --build build

# Run existing unit tests to ensure no regressions
./build/nexa_auth_test
./build/nexa_format_test
```

### Manual Verification
1. Install the modified extension in Chrome
2. Test downloading a Google Drive shared file link → should download via Nexa instead of browser
3. Test downloading a Google Photos image/video → should download via Nexa
4. Test downloading a GitHub release asset → should download via Nexa
5. Test that YouTube downloads still work (not broken by credential scope changes)
6. Test that non-Google file downloads still work normally
