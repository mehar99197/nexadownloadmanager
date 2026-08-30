# Nexa Download Manager — Deep Project Audit

**Audit date:** 2026-08-07  
**Repository:** `/home/anonhexor0001/Desktop/Work/nexadownloadmanager`  
**Branch:** `fix/windows-native-host-hklm`  
**HEAD at audit start:** `ae3666f` (`ci(windows): install unzip for static-ffmpeg extraction; drop unused ffmpeg pkg`)  
**Audit type:** Static source audit + local build/test/package verification  
**Audit language:** Roman Urdu with technical English identifiers preserved

> Yeh report current working tree ke against hai, sirf `HEAD` commit ke against nahi. Audit start par working tree already dirty tha aur recent desktop, extension, branding, website, cloud-provider, aur planning changes uncommitted/untracked thay. Generated `node_modules`, frontend/admin `dist`, screenshots, Playwright logs, aur build cache ko implementation evidence nahi maana gaya.

## 1. Executive Summary

### Overall verdict

Project ka current state **feature-rich beta / pre-production** hai. Desktop downloader ka core kaafi mature nazar aata hai aur local C++ build, unit tests, frontend builds, backend syntax checks, extension syntax checks, aur Debian packaging locally pass hue. Lekin project ko production release ya public paid launch ke liye abhi approve nahi kiya ja sakta.

### Release decision

**Release status: BLOCKED**

Sab se important blockers:

1. Production environment missing secrets par known development JWT/license/database defaults use karta hai.
2. JWT token purpose (`access`, `reset`, `verify-email`) verify functions enforce nahi kartin.
3. Stripe webhook processing failure ke bawajood HTTP 200 return ho sakta hai, aur event idempotency nahi hai.
4. C++ desktop app mein website license validation ka koi actual integration nahi mila.
5. LAN dashboard default HTTP par chal sakta hai; token plaintext network par ja sakta hai.
6. LAN dashboard arbitrary `http/https` targets download kar sakta hai, jis se SSRF/internal-network access risk banta hai.
7. macOS ko website/marketing mein advertise kiya gaya hai, lekin release schema, CI, aur native packaging mein macOS build absent hai.
8. Chromium extension packaging command missing `popup.html`/`popup.js` ki wajah se fail hoti hai.
9. Firefox extension ke generated source files `.gitignore` ke through ignored hain aur `extension-firefox/build.sh` repository mein maujood nahi.
10. Website documentation MongoDB/Mongoose describe karti hai, jabke actual backend MySQL2 aur raw SQL use karta hai.

### Positive assessment

- Desktop architecture modular hai: `DownloadEngine`, `DownloadTask`, segment workers, HLS/DASH, yt-dlp, torrent, auth, IPC, dashboard, AI, aur UI separate components mein divided hain.
- HTTP segmented downloads ke liye persistence, retry, rate limiting, redirects, range probing, dynamic re-segmentation, aur file preallocation ka serious implementation maujood hai.
- Native host aur local IPC mein frame-size limits, stale socket handling, user access restriction, aur Linux binary ownership checks add kiye gaye hain.
- Browser credential handling mein domain scoping, cookie deduplication, bearer-token validation, private temporary files, aur YouTube auth exclusion jaise defensive controls hain.
- Existing auth/formatter tests pass karte hain aur C++ project warning-enabled build mein bhi compile hota hai.

## 2. Audit Scope and Method

### Audited areas

- Desktop application: C++17, Qt 6, SQLite, libtorrent, QProcess-based external tools.
- Core download lifecycle: probing, redirects, segmentation, resume, retries, queue, scheduler, persistence.
- Media/site integrations: HLS/DASH, FFmpeg, yt-dlp, Mega, BitTorrent.
- Browser integration: Chromium MV3, Firefox manifest/background/content flow, native messaging.
- Local/remote boundaries: `QLocalSocket` IPC, native host, TCP dashboard, token authentication.
- Authentication and credentials: cookies, bearer headers, browser-login profiles, temp auth files.
- Website backend: Express, MySQL2, JWT, refresh cookies, license endpoint, Stripe webhook, admin API.
- Website frontend/admin: routes, API clients, pricing, billing, release publishing, auth state.
- CI/CD and packaging: GitHub Actions, Linux Debian package, Windows NSIS workflow, extension packaging.
- Documentation and implementation-plan consistency.

### Method

1. Repository inventory, Git state, recent commits, and source-tree inspection.
2. Architecture and data-flow tracing across desktop, extensions, native host, and website.
3. Security-sensitive pattern search for auth, cookies, bearer tokens, local sockets, subprocesses, SQL, CORS, admin access, Stripe, and secrets.
4. Local build, test, syntax, packaging, warning-enabled build, and dependency-audit commands.
5. Documentation-vs-implementation cross-check.
6. Findings ko severity, evidence, impact, remediation, aur acceptance criteria ke saath classify kiya gaya.

### Status meanings

| Status | Meaning |
|---|---|
| `Complete` | Code present hai aur available local verification se pass hua. |
| `Implemented / E2E unverified` | Feature code mein hai, lekin real external service/device/swarm/manual scenario verify nahi hua. |
| `Partial` | Core implementation present hai, lekin important production behavior missing ya constrained hai. |
| `Pending` | Planned/expected work abhi implement nahi hui. |
| `Blocked` | Current defect, missing dependency, missing artifact, ya environment ki wajah se release/verification rukti hai. |

## 3. Repository Inventory

### First-party source counts

| Area | Approximate files | Main technology |
|---|---:|---|
| `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src` | 54 | C++ / Qt 6 |
| `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/tests` | 2 | C++ executable tests |
| `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/native-host` | 3 | C++ / shell |
| `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/extension-chromium` | 9 | Chrome MV3 JavaScript |
| `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/extension-firefox` | 7 on disk, only manifest tracked | Firefox WebExtension |
| `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src` | 39 | Node.js / Express / MySQL2 |
| `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/frontend/src` | 29 | React / Vite |
| `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/admin/src` | 24 | React / Vite |

### Working-tree hygiene

Audit start par Git status mein existing modifications aur untracked files thay, including:

- Modified C++ core, auth, IPC, extension, branding, resource, and CMake files.
- New/untracked cloud-provider registry, Mega grabber, website backend/frontend/admin, implementation plan, resources, screenshots, and Playwright artifacts.
- Build/package artifacts bhi working tree mein appear ho rahe thay after local packaging.

Final merge se pehle changes ko logical commits mein split karna zaroori hai:

1. Desktop/core implementation.
2. Browser/native-host changes.
3. Website backend/frontend/admin.
4. Branding/assets.
5. Documentation.

## 4. Architecture Audit

### 4.1 Desktop application

Primary flow:

```text
Browser extension
  -> Native Messaging framed JSON
  -> nexa-host
  -> QLocalSocket("nexa-ipc")
  -> IpcServer
  -> DownloadEngine
  -> DownloadTask / HlsGrabber / YtDlpGrabber / MegaGrabber / TorrentManager
  -> Qt UI, SQLite persistence, optional WebServer dashboard
```

Relevant implementation locations:

- `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/core/DownloadEngine.{h,cpp}` — top-level orchestration, queue, scheduling, all download backends.
- `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/core/DownloadTask.{h,cpp}` — HTTP probing, ranges, resume, retries, redirects, persistence.
- `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/core/SegmentDownloader.{h,cpp}` — one byte-range worker.
- `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/core/Database.{h,cpp}` — SQLite task/segment persistence.
- `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/grabber/HlsGrabber.{h,cpp}` — HLS parsing, parallel segments, FFmpeg mux.
- `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/site/YtDlpGrabber.{h,cpp}` — yt-dlp subprocess and playlist parallelism.
- `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/site/MegaGrabber.{h,cpp}` — Mega URL parsing, fetch, decrypt.
- `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/torrent/TorrentManager.{h,cpp}` — libtorrent session.
- `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/ipc/IpcServer.{h,cpp}` — local framed IPC.
- `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/native-host/nexa-host.cpp` — browser bridge.
- `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/web/WebServer.{h,cpp}` — local dashboard and REST API.

Design strength: Qt event-loop based asynchronous networking architecture ko relatively simple rakhta hai aur explicit worker-thread locking avoid karta hai. Design risk: many protocols ek large controller mein converge karte hain, isliye integration tests aur lifecycle ownership ko production release se pehle grow karna hoga.

### 4.1.1 Udemy Enrolled Course Download — Full Flow

Yeh flow detailed explanation hai ke kaise Nexa ek Udemy enrolled course ko download karta hai, browser extension se lekar parallel lecture download tak.

#### Step 1 — Browser Extension (content.js / background.js)

1. **User right-clicks** Udemy course/lecture page par → selects **"Download whole course with Nexa"** (`nexa-course` context menu).
2. `handoff(url, tab, referrer, filename, quality, playlist=true, userInitiated=true)` trigger hota hai.
3. `authDomainFor(url)` → host `www.udemy.com` ke liye `"udemy.com"` return karta hai (NEXA_AUTH_SITES derived from PROVIDER_CONFIG).
4. `exportCookiesAsNetscape("udemy.com", url)` sabhi `*.udemy.com` cookies ko Netscape format mein export karta hai.
5. Payload assemble hota hai:
   ```json
   {
     "type": "download",
     "url": "https://www.udemy.com/course/<slug>/learn/lecture/<id>#overview",
     "playlist": true,
     "userInitiated": true,
     "authDomain": "udemy.com",
     "authCookiesText": "<netscape formatted cookies>",
     "cookies": "cookie1=val1; cookie2=val2",
     "userAgent": "Mozilla/5.0 ...",
     "referrer": "<tab url>"
   }
   ```
6. `sendNative(payload)` → Chrome native messaging → `nexa-host` process.

#### Step 2 — Native Host Bridge (nexa-host.cpp)

1. Browser se **4-byte LE length-prefixed JSON** stdin par receive hota hai.
2. Pehle running engine se connect karne ki koshish karta hai (`QLocalSocket` → `/tmp/nexa-ipc`).
3. Agar engine nahi milta → `launchEngine()` → `nexa --background` process start → 40 retries (150ms each, total ~6s).
4. Engine se **same length-prefixed frame format** mein reply receive karta hai.
5. Reply browser ko wapas frame karta hai (`{ok: true, id: <taskId>}`).

#### Step 3 — IPC Server (IpcServer.cpp → handlePayload)

1. **Scheme validation**: `http`, `https`, ya `magnet` allow — `file://` reject.
2. **Host validation**: Host empty hone par reject. Private-network targets `isPublicHttpUrl()` ke through reject.
3. **Auth domain validation**: Domain format check (`[A-Za-z0-9.-]{1,253}`), `sameDomain` (host endsWith `.domain`), `approvedSibling` (CloudProviders::sameCredentialScope).
4. **Cookie registration decision** (critical fix — 2026-08-11):
   ```cpp
   const bool isYtDlpSite = YtDlpGrabber::isSiteVideoUrl(url);
   const bool hasBrowserCookies = isYtDlpSite
       && am->resolve(url).kind == DomainAuth::Kind::BrowserCookies;
   if (!cookiesText.isEmpty() && !hasBrowserCookies)
       ar = am->registerCookieData(authDomain, cookiesText);
   ```
   - Udemy ke liye `isYtDlpSite=true` + `hasBrowserCookies=true` → **SKIP** cookie registration.
   - BrowserCookies preserved → yt-dlp gets `--cookies-from-browser chrome`.
   - Fallback: agar browser detect nahi hua → extension cookies use hote hain (`--cookies <file>`).
5. **Headers assembly**: CR/LF injection guard, forbidden headers reject.
6. **addDownload()**: `addDownload(url, ..., playlist=true, userInitiated=true, publicNetworkOnly=true)`.

#### Step 4 — Download Engine (DownloadEngine.cpp → addDownload)

1. **Browser login refresh**: `refreshBrowserLoginFor(url)` → finds `"udemy.com"` → resolve returns `BrowserCookies` → refreshes profile-specific browser cookies.
2. **Auth resolution**: `ytDlpArgs(url)` → `resolve(url)` → `BrowserCookies` → returns `{"--cookies-from-browser", "chrome"}`.
3. **Pre-flight**: `validateFor(url)` → BrowserCookies always valid.
4. **Route**: `isSiteVideoUrl(url)` → true → creates `YtDlpGrabber(playlist=true, authArgs={"--cookies-from-browser","chrome"})`.
5. **Start**: `g->setPlaylistConcurrency(3); g->start();`

#### Step 5 — YtDlpGrabber (URL Decision — critical fix)

```cpp
const bool isUdemy = host == "udemy.com" || host.endsWith(".udemy.com");
if (isUdemy && !m_playlist)
    runUrl = normalizeUdemyUrl(m_url, false);  // single lecture: canonical form
// playlist: keep ORIGINAL URL — UdemyCourseIE extracts course ID from lecture page
```

**Why**: yt-dlp's `UdemyCourseIE` cannot extract course ID from course landing pages (`/<slug>/` or `/course/<slug>/`) — modern Udemy no longer embeds `ng-init` JSON or `data-course-id` attributes. But lecture pages (`/learn/lecture/<id>`) DO expose the course ID. So playlist mode preserves the original lecture URL.

#### Step 6 — Parallel Playlist Download (startPlaylistParallel)

- `K = m_plConcurrency` (default 3) workers spawn hote hain.
- Har worker: `--yes-playlist --playlist-items "j::K"` round-robin slice.
- Worker 0: items 1,4,7,... | Worker 1: items 2,5,8,... | Worker 2: items 3,6,9,...
- `commonArgs()` includes: `--cookies-from-browser chrome`, `--concurrent-fragments 16`, `--merge-output-format mp4`.
- Progress tracking: `onPlOutput()` parses speed/percentage, `emitPlaylistProgress()` throttled at 400ms.
- DRM detection: `[udemy] <id>` lines → `m_drmVideoIds` → surfaced in completion message.
- Completion: `countPlaylistDone()` → unique saved videos → `"saved N videos"` or error.

#### Flow Diagram

```text
┌─────────────────────────────────────────────────────────────────────┐
│ BROWSER EXTENSION (Chromium MV3)                                    │
│                                                                     │
│  content.js: context menu "Download whole course with Nexa"         │
│       │                                                             │
│       ▼                                                             │
│  background.js: handoff(url, tab, playlist=true)                    │
│       │ authDomainFor() → "udemy.com"                               │
│       │ exportCookiesAsNetscape() → Netscape cookie text            │
│       │ sendNative({url, playlist, authDomain, authCookiesText})    │
└───────┼─────────────────────────────────────────────────────────────┘
        │  Native Messaging (4-byte LE framed JSON)
        ▼
┌─────────────────────────────────────────────────────────────────────┐
│ NATIVE HOST (nexa-host)                                             │
│                                                                     │
│  readMessage(stdin) → relayToEngine(QLocalSocket "nexa-ipc")        │
│  engine nahi mila → launchEngine("nexa --background") → retry       │
│  engine reply → writeMessage(stdout) → browser ko response          │
└───────┼─────────────────────────────────────────────────────────────┘
        │  QLocalSocket (4-byte LE framed JSON)
        ▼
┌─────────────────────────────────────────────────────────────────────┐
│ IPC SERVER (IpcServer::handlePayload)                                │
│                                                                     │
│  URL validation (scheme, host, public-network check)                │
│  Auth domain validation (format, sameDomain/approvedSibling)        │
│  Cookie decision:                                                   │
│    isYtDlpSite && hasBrowserCookies? → SKIP registerCookieData      │
│    (preserves --cookies-from-browser)                               │
│    else → registerCookieData() → --cookies <temp-file>              │
│  Headers assembly + sanitization                                    │
│  addDownload(url, playlist=true, userInitiated=true)                │
└───────┼─────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────┐
│ DOWNLOAD ENGINE (DownloadEngine::addDownload)                        │
│                                                                     │
│  refreshBrowserLoginFor(url) → detects Chrome/Firefox profile       │
│  ytDlpArgs(url) → resolve() → BrowserCookies                        │
│    returns ["--cookies-from-browser", "chrome"]                     │
│  validateFor(url) → pre-flight auth check                           │
│  isSiteVideoUrl(url) → true (udemy.com in kAuthSites)               │
│  Creates YtDlpGrabber(id, url, authArgs, playlist=true)             │
└───────┼─────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────┐
│ YT-DLP GRABBER (YtDlpGrabber::start)                                │
│                                                                     │
│  Udemy + playlist? → keep ORIGINAL lecture URL                      │
│    (UdemyCourseIE extracts course ID from lecture page)             │
│  Udemy + !playlist? → normalizeUdemyUrl() canonical form            │
│  commonArgs() → --cookies-from-browser chrome + all yt-dlp flags    │
│  startPlaylistParallel() → 3 workers, round-robin slices            │
│       │                                                             │
│       ├─ Worker 0: --playlist-items "1::3" → lectures 1,4,7,...     │
│       ├─ Worker 1: --playlist-items "2::3" → lectures 2,5,8,...     │
│       └─ Worker 2: --playlist-items "3::3" → lectures 3,6,9,...     │
│                                                                     │
│  onPlOutput() → parse progress, speed, DRM detection                │
│  onPlProcFinished() → count saved, surface errors                   │
└───────┼─────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────┐
│ YT-DLP (External Process)                                           │
│                                                                     │
│  UdemyCourseIE: downloads lecture page → extracts course ID         │
│  Fetches /api-2.0/courses/<id>/cached-subscriber-curriculum-items   │
│  Enumerates all lectures → playlist_result                          │
│  UdemyIE (per lecture): downloads video + audio, merges via FFmpeg  │
│  Saves to output directory with --restrict-filenames                 │
└─────────────────────────────────────────────────────────────────────┘
```

#### yt-dlp Udemy Extractors

yt-dlp ke **do extractors** Udemy ke liye hain:

| Extractor | Match Pattern | Use |
|-----------|--------------|-----|
| `UdemyIE` | `/<slug>/learn/v4/t/lecture/<id>` ya `#/lecture/<id>` | Single lecture download |
| `UdemyCourseIE` | `/<first-path-segment>` (e.g., `/course/<slug>/` ya `/<slug>/`) | Whole course enumeration |

**Key finding (2026-08-11)**: `UdemyCourseIE` modern Udemy course landing pages se course ID extract nahi kar pata (page ab AngularJS `ng-init` ya `data-course-id` attributes embed nahi karta). **Lekin** lecture pages (`/learn/lecture/<id>`) se course ID successfully extract kar leta hai jab `--yes-playlist` flag use hota hai. Is liye Nexa playlist mode mein original lecture URL preserve karta hai.

#### Key Files Involved

| File | Role |
|------|------|
| `extension-chromium/background.js` | Cookie export, context menu, native messaging |
| `extension-chromium/content.js` | Udemy page detection, lecture URL regex |
| `native-host/nexa-host.cpp` | stdin→socket bridge, engine launch, frame relay |
| `src/ipc/IpcServer.cpp` | URL/auth validation, cookie registration decision, download dispatch |
| `src/ipc/IpcProtocol.h` | 8MB max frame size constant |
| `src/core/DownloadEngine.cpp` | Auth resolution, browser login refresh, grabber creation |
| `src/core/DownloadEngine.h` | `refreshBrowserLoginFor()`, `providers()`, `m_plConcurrency` |
| `src/site/YtDlpGrabber.cpp` | URL normalization, yt-dlp args, parallel playlist workers |
| `src/site/YtDlpGrabber.h` | `normalizeUdemyUrl()`, `udemyCourseSlug()`, `startPlaylistParallel()` |
| `src/auth/AuthenticationManager.cpp` | `registerCookieData()`, `ytDlpArgs()`, `resolve()`, `registerBrowserCookies()` |
| `src/auth/AuthenticationManager.h` | `DomainAuth::Kind::BrowserCookies`, `DomainAuth::Kind::CookieFile` |
| `src/auth/BrowserLogin.cpp` | `detectBrowser()`, `bestProfileForDomain()`, `authSites()` |
| `src/auth/CookieFile.cpp` | Netscape cookie parse, deduplication, cookie header assembly |
| `src/auth/CloudProviders.cpp` | Provider registry: auth sites, hosts, credential siblings |
| `resources/cloud_providers.json` | Udemy provider config: `isSiteVideo: true`, `isAuthSite: true` |

### 4.2 Website

Actual website architecture:

```text
React frontend / React admin
  -> Axios REST client
  -> Express API
  -> MySQL2 connection pool
  -> SQL schema initialized at startup
```

Actual database/config evidence:

- `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/package.json:4` says MySQL2 API.
- `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/config/db.js:3` imports `mysql2/promise`.
- `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/config/schema.js:7` onward creates MySQL tables.
- `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/CONTRACT.md:9` onward still describes Mongoose/MongoDB and Mongoose documents.

Yeh cosmetic mismatch nahi. Is se onboarding, deployment, model expectations, schema migrations, backup strategy, aur future development affect hoti hai.

## 5. Completed / Implemented Items

Yeh items current code mein present hain. `Complete` ka matlab code presence + local check hai; jahan real service/device test nahi hua, wahan `Implemented / E2E unverified` explicitly likha gaya hai.

### Desktop and core

| Capability | Status | Evidence / notes |
|---|---|---|
| Qt 6 desktop application | `Complete` | `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/CMakeLists.txt:14` and main/UI sources. |
| HTTP/HTTPS download engine | `Implemented / E2E unverified` | `DownloadTask` + `SegmentDownloader` present. |
| Range probing and segmented downloads | `Implemented / E2E unverified` | Range probe, preallocation, per-segment offsets, dynamic re-segmentation present. |
| Pause/resume persistence | `Implemented / E2E unverified` | SQLite task/segment tables and restore path present. |
| Retry and short-read handling | `Implemented / E2E unverified` | Segment retry/short-finish logic present. |
| Global HTTP rate limiting | `Implemented / E2E unverified` | `RateLimiter` shared across segment workers. |
| Queue and max concurrency | `Implemented / E2E unverified` | `DownloadEngine::schedule()` manages pending IDs. |
| Batch URL/range expansion | `Implemented / E2E unverified` | `addBatch()` and `expandPattern()` present. |
| Future scheduling | `Partial` | In-memory `QTimer` scheduling exists, but scheduled jobs are not persisted across restart. |
| Auto-categorization | `Implemented / E2E unverified` | Settings/UI and category path logic present. |
| HLS parsing and FFmpeg mux | `Implemented / E2E unverified` | HLS path handles playlist/segments/mux; no partial resume. |
| DASH via FFmpeg | `Implemented / E2E unverified` | Direct FFmpeg path present. |
| yt-dlp site support | `Implemented / E2E unverified` | Absolute bundled-tool lookup and playlist workers present. |
| BitTorrent/libtorrent | `Implemented / E2E unverified` | DHT/PEX/session/rate/seed handling present. |
| Mega integration | `Partial` | Code exists, but cryptographic correctness needs protocol fixtures and independent verification. |
| AI smart rename | `Implemented / E2E unverified` | Anthropic client, retry, filename sanitization, callback flow present. |
| AI natural-language add/schedule | `Implemented / E2E unverified` | JSON extraction and URL/schedule validation present. |
| Update checker | `Partial` | User-facing update notice exists; feed signature/metadata authenticity is not implemented. |
| Error logging | `Implemented / E2E unverified` | Opt-in rotating log handler present. |

### Authentication and credentials

| Capability | Status | Evidence / notes |
|---|---|---|
| Netscape cookie parsing | `Complete` | Covered by `AuthTest`. |
| Cookie domain/path matching | `Complete` | Tests cover host suffix and RFC6265 path behavior. |
| Cookie deduplication | `Complete` | Tests cover host-specific cookie preference. |
| Browser cookie mode | `Implemented / E2E unverified` | `--cookies-from-browser` arguments generated. |
| Bearer-token validation | `Implemented / E2E unverified` | RFC-style charset validation and private config file path used. |
| Sensitive header scoping | `Implemented / E2E unverified` | Cookies/Authorization are intentionally scoped before network replay. |
| YouTube auth exclusion | `Complete` | Covered by `AuthTest` safeguard. |

### Browser/native integration

| Capability | Status | Evidence / notes |
|---|---|---|
| Native messaging framing | `Implemented / E2E unverified` | 4-byte little-endian frame protocol in host and IPC server. |
| Native host engine autostart | `Implemented / E2E unverified` | `nexa-host` launches sibling engine after connection failure. |
| Linux/Chromium registration script | `Implemented / E2E unverified` | `native-host/install.sh` validates Chrome ID. |
| Chromium MV3 extension | `Implemented / E2E unverified` | Manifest, background, content script, cookies, webRequest, context menus. |
| Firefox extension code parity | `Partial` | Files exist locally but are ignored/not tracked; build script missing. |
| HLS/DASH/media sniffing | `Implemented / E2E unverified` | Background/content flow present. |
| Cookie/header forwarding | `Implemented / E2E unverified` | Extension forwards cookies, UA, referrer, selected captured headers. |

### Website

| Capability | Status | Evidence / notes |
|---|---|---|
| Express backend route structure | `Complete` | Auth, user, subscription, license, reviews, releases, admin, webhooks. |
| MySQL schema bootstrap | `Implemented / E2E unverified` | Startup schema creation present. |
| User registration/login | `Implemented / E2E unverified` | bcrypt cost 12, access token, refresh cookie. |
| Email verify/reset flows | `Implemented / E2E unverified` | Token generation and mock/live email utility present. |
| User portal | `Implemented / E2E unverified` | Dashboard, billing, profile, download, reviews pages. |
| Admin panel | `Implemented / E2E unverified` | Users, subscriptions, reviews, releases, activity, dashboard. |
| License validation endpoint | `Implemented / C++ integration missing` | Backend endpoint exists, desktop consumer absent. |
| Stripe checkout/webhook | `Partial` | Live/mock abstraction exists; production hardening and idempotency missing. |
| Review moderation | `Implemented / E2E unverified` | Public approved reviews and admin moderation routes. |
| Release publishing | `Partial` | Windows/Linux fields work; macOS field missing despite frontend card. |
| Frontend production build | `Complete` | Vite build passed. |
| Admin production build | `Complete` | Vite build passed. |

## 6. Verification Results

### Passed checks

| Check | Command / result | Status |
|---|---|---|
| Existing C++ build | `cmake --build /home/anonhexor0001/Desktop/Work/nexadownloadmanager/build --parallel 2` | `PASS`; no work required. |
| Existing CTest suite | `ctest --test-dir /home/anonhexor0001/Desktop/Work/nexadownloadmanager/build --output-on-failure` | `PASS`; 2/2 tests. |
| Fresh out-of-tree C++ build | CMake configure + build under `/tmp/nexa-audit-build` with tests | `PASS`. |
| Fresh CTest suite | `ctest --test-dir /tmp/nexa-audit-build --output-on-failure` | `PASS`; 2/2 tests. |
| Warning-enabled C++ compile | `-Wall -Wextra -Wpedantic` | `PASS with warnings`. |
| Frontend build | `cd /home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/frontend && npm run build` | `PASS`. |
| Admin build | `cd /home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/admin && npm run build` | `PASS`. |
| Backend syntax | `node --check` over backend `src` | `PASS`. |
| Extension syntax | `node --check` over Chromium/Firefox JS | `PASS`. |
| Debian package generation | `cpack --config build/CPackConfig.cmake -G DEB` | `PASS` locally. |
| Backend health without DB connection | In-process server + `GET /api/health` | `PASS`; returned HTTP 200. |

### Failed, blocked, or incomplete checks

| Check | Result | Consequence |
|---|---|---|
| Chromium extension package | `FAIL`: `extension-chromium/package.sh:9` requires missing `popup.html` and `popup.js`. | Store/package release blocked. |
| Firefox extension build | `BLOCKED`: README references `extension-firefox/build.sh`, file is missing. | Reproducible Firefox package unavailable. |
| Website full runtime | `BLOCKED`: MySQL at `127.0.0.1:3306` unavailable. | DB-backed registration, billing, license, admin, webhook E2E not run. |
| C++ real download E2E | `NOT RUN` | No live HTTP fixture/server, HLS fixture, torrent swarm, or protected-site test executed. |
| Browser native-messaging E2E | `NOT RUN` | No installed Chrome/Firefox extension + manifest handshake test. |
| Windows build/package | `NOT RUN` | Linux host; workflow inspected but not executed locally. |
| macOS build/package | `BLOCKED` | No macOS CMake/CI/package job. |
| Backend automated tests | `NOT PRESENT` | Backend package has no test script; CI has no backend test job. |
| C++ core integration tests | `NOT PRESENT` | Only auth and formatter tests are registered. |
| Static analyzer | `NOT RUN` | `clang-tidy`, `cppcheck`, and `shellcheck` unavailable. |
| Dependency audit | Findings present | Backend production tree: 1 high; frontend: 2 moderate; admin: 2 moderate. |

### Warning-enabled build warnings

- `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/site/MegaGrabber.cpp:462` — unused variable `pct`.
- `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/tests/AuthTest.cpp:28` — ignored `QFile::open()` return value.

These warnings build ko fail nahi kartin, lekin production code/tests ke liye CI warning policy define honi chahiye.

## 7. Findings — Critical / P0

### SEC-001 — Production secrets silently fall back to known development values

**Severity:** Critical  
**Status:** Implemented / tests pass  
**Evidence:** `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/config/env.js:15-30`

`JWT_SECRET`, `JWT_ADMIN_SECRET`, `LICENSE_JWT_SECRET`, and `MYSQL_PASS` all have known defaults. A reproducible audit run with `NODE_ENV=production` and those environment variables unset reported all defaults as active.

**Impact:**

- Anyone who knows the repository can forge user access tokens, admin tokens, and license tokens when production secrets are omitted.
- Database connectivity may use a predictable password.
- A deployment typo complete authentication compromise ban sakta hai instead of startup failure.

**Required fix:**

- Production mein process startup fail karein if every required secret absent, short, equal to known development value, or reused across roles ho.
- Minimum entropy/length enforce karein; production mein fallback secrets use na hon.
- `MYSQL_PASS`, `FRONTEND_URL`, `CORS_ORIGINS`, Stripe live keys, SMTP, aur admin IP policy boot par validate karein.
- Startup configuration test add karein jo prove kare ke production defaults ke saath boot nahi kar sakta.

**Acceptance criteria:** Production config test non-zero exit kare when any required secret missing/default ho; logs mein koi secret value print na ho.

### AUTH-001 — JWT token purpose/type is not enforced

**Severity:** High / release-blocking  
**Status:** Implemented / tests pass  
**Evidence:** `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/utils/jwt.js:15-39`

Tokens carry `typ: 'access'`, `typ: 'admin'`, `typ: 'verify-email'`, or `typ: 'reset'`, but `verifyAccess()` and `verifyEmailOrReset()` only call `jwt.verify()` and never compare `payload.typ`.

Audit ne reproducibly confirm kiya:

- A `reset` token was accepted by `verifyAccess()`.
- An `access` token was accepted by `verifyEmailOrReset()`.

**Impact:** Token-purpose confusion. Ek workflow ke liye issued token same secret use hone ki wajah se doosre workflow mein replay ho sakta hai. Yeh account recovery, email verification, aur access-token separation ko weak karta hai.

**Required fix:**

- Purpose-specific verification helpers ya shared `verifyTypedToken(token, secret, expectedType)` banayein.
- `verifyAccess()` mein `payload.typ === 'access'` require karein.
- `verifyAdmin()` mein `payload.typ === 'admin'` require karein.
- Verification ke liye `verify-email`, password reset ke liye `reset` explicitly require karein.
- Har cross-purpose rejection ke tests add karein.

**Acceptance criteria:** Har wrong-purpose token controlled 401/400 return kare aur account state change na ho.

### PAY-001 — Stripe webhook can acknowledge failed processing and duplicate events

**Severity:** Critical  
**Status:** Implemented / DB E2E pending  
**Evidence:** `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/routes/webhooks.js:100-116`

Webhook signature verify karta hai, business logic perform karta hai, processing error catch/log karta hai, aur phir bhi `200 { received: true }` return kar sakta hai. Payment create, subscription activation, aur license email se pehle stored Stripe event ID/idempotency check bhi nahi hai.

**Impact:**

- Stripe failed event ko delivered samajh sakta hai aur retry nahi karega.
- Retried/duplicated deliveries duplicate payment rows aur duplicate license emails create kar sakti hain.
- Subscription state Stripe se drift kar sakti hai.
- Transient DB/email error permanently acknowledged but incomplete payment bana sakta hai.

**Required fix:**

- Unique `event_id`, event type, status, payload hash, timestamps, aur error state ke saath `stripe_events` table add karein.
- Business processing se pehle event ID transactionally claim karein.
- Durable state success ke baad hi 2xx return karein; retryable failure par 5xx return karein.
- Subscription/payment/license-email operations idempotent banayein.
- Duplicate delivery, partial DB failure, email failure, cancellation, payment failure, aur out-of-order events ke tests add karein.

**Acceptance criteria:** Same Stripe event 10 baar deliver ho to one payment/subscription transition aur one license issuance ho; failed processing retry ho, false success acknowledge na ho.

### PAY-002 — Mock Stripe webhook verifier is unsafe if production is misconfigured

**Severity:** Critical in deployment misconfiguration  
**Status:** Implemented / production config test pass  
**Evidence:** `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/config/env.js:51` and `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/utils/stripe.js:8-28`

When `STRIPE_SECRET_KEY` empty ho, app mock mode enable karti hai. Mock `constructEvent()` JSON parse karta aur signature ignore karta hai. Isolated development ke liye yeh useful hai, lekin production deployment mein live Stripe key omit ho to unsafe hai.

**Impact:** `/api/webhooks/stripe` tak access rakhne wala client crafted JSON event submit karke subscription/payment/license logic trigger kar sakta hai.

**Required fix:**

- `NODE_ENV=production` mein Stripe mock mode disallow karein.
- Production mein `STRIPE_SECRET_KEY` aur `STRIPE_WEBHOOK_SECRET` dono require karein.
- Mock mode ko separate explicit development-only `ALLOW_MOCK_BILLING=true` flag se opt-in banayein.
- Production startup assertion add karein.

## 8. Findings — High / P1

### LIC-001 — Desktop app does not consume the website license API

**Severity:** High / commercial release blocker  
**Status:** Implemented / live API E2E pending  
**Evidence:** Website endpoint exists at `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/routes/license.js:12-34`; no C++ `validateLicense`, `device_fingerprint`, `/api/license/validate`, or license service integration was found under `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src`.

**Impact:** Website plans sell aur license generate kar sakti hai, lekin desktop app validate/enforce nahi karti. Free limits, Pro features, Team seats, aur paid access product se connected nahi.

**Required fix:**

- HTTPS-only endpoint validation, timeout, retries, response validation, aur expiry handling ke saath dedicated C++ license client add karein.
- License state securely store karein aur offline grace behavior define karein.
- Plan capabilities engine/UI mein enforce karein; frontend labels trust na karein.
- Device fingerprint ke saath explicit reset/recovery policy define karein.
- Unsigned/unverified data ya single 24-hour token ko sole long-term authorization mechanism na banayein.

**Acceptance criteria:** Free, Pro, expired, cancelled, device mismatch, offline grace, aur server outage scenarios deterministic tested desktop behavior produce karein.

### SEC-002 — Admin IP restriction is optional by default and proxy trust is deployment-sensitive

**Severity:** High  
**Status:** Pending production hardening  
**Evidence:** `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/config/env.js:41`, `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/middleware/adminAuth.js:8-15`, and `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/app.js:18`.

Empty `ADMIN_ALLOWED_IPS` all IPs allow karta hai. `app.set('trust proxy', 1)` globally one proxy hop trust karta hai. Direct exposure, incorrect proxy, ya different topology mein `req.ip` actual client ko represent na kare.

**Required fix:**

- Explicit hardened alternative na ho to production startup empty `ADMIN_ALLOWED_IPS` par fail kare.
- Trusted proxy addresses/count deployment config se set karein.
- Public admin deployment ke liye MFA/second factor add karein.
- Admin actions ko rate-limit karein, sirf login ko nahi.
- Direct, trusted proxy, spoofed `X-Forwarded-For`, mapped IPv6, denied-IP tests add karein.

### SEC-003 — LAN dashboard defaults to plaintext HTTP

**Severity:** High when `--dashboard-lan` is used  
**Status:** Implemented / local policy tests pass  
**Evidence:** `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/web/WebServer.cpp:1-10` optional TLS support karta hai, but `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/main.cpp:388-415` non-loopback dashboard ke liye TLS require nahi karta.

**Impact:** Dashboard bearer token aur control requests LAN observer read/modify kar sakta hai. Dashboard local downloads aur AI spend control karta hai.

**Required fix:**

- Non-loopback bind par HTTPS require karein.
- Certificate provision/generate karke fingerprint verification instruction dein.
- Plaintext LAN development mode explicit unsafe flag aur prominent warning ke saath ho.
- Token rotation/revoke action add karein.

### SEC-004 — LAN dashboard is an SSRF and internal-network fetch primitive

**Severity:** High  
**Status:** Implemented / local policy tests pass  
**Evidence:** `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/web/WebServer.cpp:420-426` `file://` block karta hai but arbitrary non-file URLs ko `addBatch()` deta hai.

Remote dashboard ka URL add karna intentional feature hai. Lekin LAN token holder loopback services, cloud metadata endpoints, private IPs, ya internal HTTP services ko download target bana sakta hai.

**Required fix:**

- Define karein LAN users arbitrary targets fetch karne ke liye trusted hain ya nahi.
- Minimum: DNS resolution ke baad loopback, link-local, multicast, RFC1918/private, IPv6 local, aur cloud metadata addresses reject karein; redirect targets bhi revalidate karein.
- Explicit `--dashboard-allow-private-targets` development-only override consider karein.
- Maximum redirects, DNS rebinding resistance, aur per-target limits add karein.

### EXT-001 — Browser extension has very broad credential/privacy access

**Severity:** High privacy risk  
**Status:** Partial / requires product decision  
**Evidence:** `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/extension-chromium/manifest.json:7-19` and `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/extension-firefox/manifest.json:12-20` request cookies, webRequest, native messaging, scripting/tabs, and `<all_urls>`.

Extension essentially every site ke cookies/download/request metadata tak access le sakti aur credential material desktop process ko forward karti hai. Downloader ke liye kuch broad access expected hai, but current model highly sensitive hai.

**Required fix:**

- Exact data collection, forwarding, retention, aur deletion policy document karein.
- Browser APIs permit karein to host permissions minimize karein.
- Native payload size aur allowed header names one canonical validation layer par restrict karein.
- Cookie values, bearer tokens, full auth URLs kabhi log na hon.
- Credential capture ke liye explicit consent aur site allow/deny UI add karein.
- Extension-store publication se pehle security review karein.

### CORE-001 — HTTP resume lacks entity validators and end-to-end integrity verification

**Severity:** High data-integrity risk  
**Status:** Resolved by removing the unsupported public claim  
**Evidence:** `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/core/DownloadTask.cpp:522-563` range/content size probe karta hai; `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/core/SegmentDownloader.cpp:71-111` ranges send karta hai, but no `ETag`, `Last-Modified`, `If-Range`, expected checksum, or final hash verification found.

**Impact:** Remote object segments/restarts ke darmiyan change ho aur size compatible rahe to output different versions ka undetected mixture ban sakta hai. Original plan MD5/SHA-256 verification promise karta hai, lekin implementation absent hai.

**Required fix:**

- Strong `ETag`/`Last-Modified` validators task ke saath persist karein.
- `If-Range` send karein ya validator change par clean restart karein.
- Optional expected hash aur final SHA-256/MD5 verification add karein.
- Verification state UI/API mein expose karein.
- Content-during-resume change karne wali local HTTP fixture test add karein.

### SITE-001 — Mega decryption path needs protocol-level correction/verification

**Severity:** High until proven correct  
**Status:** Pending independent protocol fixture  
**Evidence:** `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/site/MegaGrabber.cpp:431-438` chunks ke liye `openssl enc -aes-128-cbc -nopad` launch karta hai. Code 32-byte key aur CBC-MAC comment rakhta hai, but final MAC/integrity verification visible nahi.

MEGA encryption protocol-specific key derivation, counter/IV handling, chunk boundaries, aur integrity checks require karti hai. Generic CBC subprocess ko official test vectors ya known-good fixtures ke baghair correct nahi maana ja sakta.

**Required fix:**

- Documented MEGA AES mode/key derivation directly implement karein ya vetted library use karein.
- Complete mark karne se pehle file MAC/authentication verify karein.
- Unused `pct` remove karein aur small/multi-chunk/corrupt deterministic fixture tests add karein.
- Tests pass hone tak Mega ko experimental mark karein.

### REL-001 — macOS is advertised but not built, packaged, or represented in backend schema

**Severity:** High / release blocker  
**Status:** Pending  
**Evidence:**

- Frontend macOS card: `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/frontend/src/pages/Download.jsx:19-24,90-95`.
- Backend response only Windows/Linux: `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/routes/releases.js:14-18`.
- Schema only `windows_url`/`linux_url`: `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/config/schema.js:85-97`.
- Admin schemas omit macOS: `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/schemas/admin.schema.js:94-117`.
- CMake/CI package Debian and NSIS only: `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/CMakeLists.txt:132-197` and `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/.github/workflows/build.yml:18-20,331-334`.

**Impact:** macOS user ko empty/invalid download link mil sakta hai aur marketing claim inaccurate hai.

**Required fix:** Public claim/card remove karein until support exists, ya complete macOS pipeline add karein: build, signing, notarization, DMG/PKG, native messaging registration, release schema/API/admin field, aur install verification.

### EXT-002 — Chromium package script is broken in current tree

**Severity:** High  
**Status:** Resolved / package tests pass  
**Evidence:** `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/extension-chromium/package.sh:9-12` missing `popup.html` and `popup.js` require karta hai. Audit execution result: `missing: popup.html`.

**Required fix:** Popup required ho to files add/test karein; obsolete ho to packaging list/docs se remove karein. CI packaging artifact unzip karke every manifest-referenced file validate kare.

### EXT-003 — Firefox source/build reproducibility is broken

**Severity:** High  
**Status:** Resolved / package tests pass  
**Evidence:** Firefox manifest `background.js`, `content.js`, aur icons reference karta hai, but Git only manifest track karta hai. Root `.gitignore` generated Firefox files ignore karta hai, aur README-referenced `extension-firefox/build.sh` missing hai.

**Impact:** Clean clone Firefox extension reproduce nahi kar sakta. Local ignored files false confidence create karte hain.

**Required fix:** Canonical source/build inputs track karein, ya reproducible generation script + CI artifact model implement karein. Clean-checkout CI manifest validate kare.

### OPS-001 — Website architecture documentation contradicts implementation

**Severity:** High operational risk  
**Status:** Resolved / MySQL docs aligned  
**Evidence:** `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/websiteplan.md:5`, `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/websiteplan.md:100`, and `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/websiteplan.md:344` MongoDB/Mongoose describe karte hain; actual backend MySQL2 use karta hai at `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/package.json:4` and `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/config/db.js:3`.

`CONTRACT.md` Mongoose documents aur `_id` describe karta hai, actual models numeric `id` and snake_case SQL rows return karte hain.

**Required fix:** One canonical contract banayein. Recommended: docs ko MySQL2/SQL reality par update karein, ya implementation fully MongoDB migrate karein. Dono models parallel document na karein.

### QA-001 — Major application surfaces lack automated test coverage

**Severity:** High  
**Status:** Partial / unit coverage added; DB/E2E pending  
**Evidence:** Backend package has no test script; C++ only auth/formatter tests register karta hai at `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/CMakeLists.txt:106-129`; CI binary smoke check only at `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/.github/workflows/build.yml:34-42`.

Missing automated coverage:

- C++ HTTP range/resume/redirect/race behavior and SQLite migrations.
- HLS/DASH parsing, encryption, mux failure, cleanup.
- yt-dlp cancellation, playlist sharding, output safety.
- Mega crypto vectors and torrent state transitions.
- Native host partial frames/timeouts and malformed/oversized IPC frames.
- Dashboard auth, CORS, SSRF, slowloris, connection limits.
- Backend auth, refresh rotation, token type, license binding, Stripe idempotency, admin IP.
- Frontend/admin API contracts and protected routes.

**Required fix:** Fast unit/integration suites add karke PR CI mein packaging se pehle run karein.

## 9. Findings — Medium / P2

### AUTH-002 — Unverified accounts can log in by default

`EMAIL_VERIFICATION_REQUIRED` defaults to `false` at `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/config/env.js:48`. Local development ke liye acceptable hai, production default ke liye nahi. Production ko explicit policy require karni chahiye aur disabled verification par fail ya loud warning deni chahiye.

### AUTH-003 — License first-device binding is race-prone

`/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/routes/license.js:23-27` read-then-write without transaction/conditional update karta hai. Same unbound license ke concurrent device validations race kar sakte hain. Atomic `UPDATE ... WHERE device_fingerprint IS NULL` use karke affected rows inspect karein.

### AUTH-004 — License rate limiter key is caller-controlled

`/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/middleware/rateLimiter.js:23-29` `device_fingerprint` directly limiter key banata hai. Caller arbitrary fingerprints rotate karke per-device quota bypass kar sakta hai. Normalized IP/network key ko device key ke saath combine karein aur abuse detection add karein.

### WEB-001 — Dashboard bearer token begins life in a URL

`/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/web/WebServer.cpp:82-87` page URL se `?token=...` read karke API calls mein header use karta hai. Yeh API query exposure reduce karta hai, but initial URL browser history, screenshots, copy/paste logs, proxy access logs, aur support captures mein aa sakta hai. One-time bootstrap token ya local pairing flow prefer karein.

### WEB-002 — CORS wildcard increases blast radius if a token leaks

`/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/web/WebServer.cpp:506-512` `Access-Control-Allow-Origin: *` return karta hai. Bearer auth ke baghair automatically exploitable nahi, but leaked token rakhne wali any webpage cross-origin API call kar sakti hai. Origins restrict karein ya CORS opt-in banayein.

### WEB-003 — Dashboard API does not consistently validate target state

Pause/resume/remove routes `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/web/WebServer.cpp:455-471` arbitrary ID par success return karte hain. Unknown IDs ke liye 404 aur invalid transitions ke liye clear state error return hona chahiye.

### CORE-002 — Scheduled downloads are not restart-persistent

`DownloadEngine` scheduled timers `m_scheduledTimers` mein rakhta aur `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/core/DownloadEngine.cpp:1015-1036` par `QTimer` start karta hai. SQLite rows mein scheduled-at/recurrence fields nahi, aur `loadPersisted()` only ordinary HTTP tasks rebuild karta hai. Process restart par scheduled work disappear hoti hai.

### CORE-003 — Completed HTTP output is not cryptographically verified

README BitTorrent SHA-256 demo claim karta hai, but general HTTP engine expected checksum input/final digest feature provide nahi karta. Original plan checksum verification list karta hai. Protocol-specific torrent piece hashes se separate user-visible checksum feature add karein.

### CORE-004 — HLS has no partial resume and cleanup needs fixture coverage

`/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/grabber/HlsGrabber.cpp:64-70` explicitly HLS scratch se restart karta hai. Limitation UI/product docs mein visible honi chahiye. Cancel/restart, stale temp directory, encrypted key access, mux failure, and disk-full fixtures add karein.

### IPC-001 — Native host assumes one socket read contains a full reply frame

`/home/anonhexor0001/Desktop/Work/nexadownloadmanager/native-host/nexa-host.cpp:106-110` `waitForReadyRead()` once karke `readAll()` return karta hai. `main()` `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/native-host/nexa-host.cpp:179-184` par four bytes strip karta hai without exact frame-length collection/validation. Partial local-socket read truncated browser reply produce kar sakti hai.

Shared `readFramed()` helper exact-length accumulation, maximum frame, timeout, aur JSON validation ke saath implement karein.

### IPC-002 — Host and IPC frame limits are inconsistent

Native host `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/native-host/nexa-host.cpp:47-57` up to 64 MiB accept karta hai, while `IpcServer` `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/src/ipc/IpcServer.cpp:95-100` 8 MiB ceiling use karta hai. One shared protocol constant use karein aur relay/allocation se pehle reject karein.

### SITE-002 — Billing status vocabulary is mismatched with frontend rendering

Backend schema/webhooks `paid`, `failed`, `refunded` use karte hain at `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/config/schema.js:52-60` and `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/routes/webhooks.js:64-69,92-97`. Frontend styling `succeeded` and `pending` check karti hai at `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/frontend/src/pages/Billing.jsx:24-33`. Paid row error-color branch mein chali jati hai.

Shared API enum/normalizer define karke all statuses test karein.

### SITE-003 — Mock checkout does not complete subscription lifecycle

`/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/utils/stripe.js:8-28` mock success URL return karta hai, but visible mock callback account subscription activate nahi karta. Local demo success redirect dikha sakta hai without actual plan change. Development-only mock completion endpoint implement karein ya UI clear limitation show kare.

### SITE-004 — Email HTML interpolates user-controlled name without escaping

`/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/utils/email.js:39-65` `user.name` directly HTML email string mein insert karta hai. Length validation HTML safety nahi deti. HTML context escape karein ya auto-escaping template use karein.

### SITE-005 — Access JWT is stored in browser `localStorage`

`/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/frontend/src/api/client.js:3-17` and auth context access token `localStorage` mein store karte hain. Any future XSS token exfiltrate kar sakti hai. Short-lived in-memory access token + existing httpOnly refresh cookie prefer karein, with strict CSP and dependency review.

### SITE-006 — Production config policy is not fail-closed

Backend graceful mock modes/development defaults provide karta hai but no production gate. Disabled email verification, empty admin allowlist, localhost CORS/URL defaults, empty Stripe/SMTP keys, and development DB defaults explicit deployment decisions honi chahiye—not silent fallback.

### OPS-002 — Version and release metadata are inconsistent

- Desktop CMake version `0.1.0`: `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/CMakeLists.txt:1-2`.
- Website seed advertises `2.1.0`: `/home/anonhexor0001/Desktop/Work/nexadownloadmanager/ndm-website/backend/src/scripts/seed.js:10-15`.
- Local CPack output `nexa-0.1.0` generate karta hai.

One release/version source of truth banakar CMake, website releases, installer metadata, and update feed mein inject karein.

### OPS-003 — CPack homepage is a placeholder

`/home/anonhexor0001/Desktop/Work/nexadownloadmanager/CMakeLists.txt:147-149` homepage `https://github.com/` set karta hai. Installer publish karne se pehle actual canonical repository/product URL set karein.

### QA-002 — Warning policy is incomplete

Warning-enabled build pass hua but Mega unused `pct` and ignored test `QFile::open()` return report karta hai. First-party warnings fix karein, CI warnings enable karein, baseline clean hone ke baad selective `-Werror` consider karein.

### QA-003 — Dependency audits are not part of CI

Local `npm audit --omit=dev` summary:

- Backend: 1 high.
- Frontend: 2 moderate.
- Admin: 2 moderate.

Exact advisory remediation lockfiles ke against review honi chahiye. Scheduled audit/update workflow add karein aur release severity thresholds define karein.

## 10. Documentation and Product-Claim Audit

### Claims supported by code, with caveats

- Segmented HTTP downloads: code exists; no validator/checksum protection.
- Pause/resume: ordinary HTTP path offsets persist karta hai; HLS resume nahi karta.
- Browser extension: code exists; packaging/reproducibility incomplete hai.
- HLS/DASH: code exists; protected/encrypted stream coverage audit mein run nahi hui.
- BitTorrent: libtorrent code exists; live swarm verification audit mein rerun nahi hui.
- AI: code exists; external Anthropic key/model/API availability required.
- Remote dashboard: code exists; LAN security HTTPS/SSRF policy require karti hai.
- Cloud providers: registry and handlers exist; provider-specific E2E fixtures absent hain.

### Claims that should be corrected or gated

- **macOS availability:** public page se remove karein until signed/notarized build exists, ya complete pipeline finish karein.
- **“Beat IDM” / production-grade claims:** product positioning tak limit rakhein, security/reliability guarantee na banayein until regression/E2E coverage exists.
- **Website MongoDB documentation:** MySQL2 reality par update karein ya implementation migrate karein.
- **C++ license enforcement:** paid feature gating desktop integration se pehle advertise na karein.
- **Extension store readiness:** clean checkout packaging pass honi chahiye.
- **Auto-update:** current `UpdateChecker` only checker/user notification hai; auto-install nahi.

## 11. Pending Work Backlog

### P0 — Must finish before public production/paid release

1. Production secret/database/JWT/license defaults remove karke fail-fast validation add karein.
2. JWT token purpose enforce karke cross-purpose tests add karein.
3. Production mock billing disable; signed webhook idempotency and retry-safe transactions add karein.
4. C++ license client implement karke free/Pro/Team entitlements enforce karein.
5. LAN dashboard HTTPS requirement and token rotation/revocation add karein.
6. Dashboard SSRF/private-network policy decide aur mitigate karein.
7. Chromium packaging fix aur Firefox clean-clone reproducibility restore karein.
8. macOS support complete karein ya claims remove karein.

### P1 — Must finish before calling product stable

1. HTTP validators (`ETag`/`Last-Modified`/`If-Range`) and optional checksum verification.
2. Mega cryptography protocol fixtures ke saath verify/fix.
3. Backend/API/IPC/web/dashboard/core integration tests.
4. Scheduled jobs persist karein and restart/recurrence semantics define karein.
5. Backend/frontend billing status enum mismatch fix karein.
6. Stripe duplicate/out-of-order/failure tests add karein.
7. Admin MFA/equivalent hardened operator control add karein.
8. Frontend access-token storage harden karein.
9. HTML email fields escape karein and output contexts audit karein.
10. Native host protocol-safe framed-read helper implement karein.
11. Architecture/website/install docs actual implementation ke saath align karein.
12. One version source of truth and real homepage/download metadata set karein.

### P2 — Quality, UX, maintainability

1. Compiler warnings clean aur CI warning policy define karein.
2. `clang-tidy`, `cppcheck`, `shellcheck` CI mein add karein.
3. Extension permission/credential privacy docs and user controls add karein.
4. Download state-transition validation aur proper API errors add karein.
5. Slowloris, malformed frames, partial reads, DNS rebinding, redirect chains ke fixtures add karein.
6. Every manifest file aur packaged dependency ke release smoke tests add karein.
7. MySQL backup/restore/migration operations document karein.
8. Generated package/screenshot/Playwright artifacts normal Git output se isolate/ignore karein.

## 12. Recommended Implementation Order

### Phase A — Security and deployment gates

1. Production env validator.
2. Typed JWT verification.
3. Production mock-billing shutdown.
4. Stripe event ledger/idempotency.
5. Admin proxy/IP/MFA hardening.
6. LAN dashboard HTTPS enforcement.

### Phase B — Product integrity

1. Desktop license client and entitlement checks.
2. Atomic device binding and offline policy.
3. HTTP validators/checksums.
4. Correct Mega protocol implementation.
5. Scheduled-job persistence.

### Phase C — Release engineering

1. Chromium package script repair.
2. Firefox reproducible build.
3. macOS scope decision: remove claims or ship signed artifacts.
4. Version metadata unification.
5. Backend and integration CI.
6. Clean-machine install/launch/native-messaging/download tests.

## 13. Definition of Done for Release

- [ ] Production backend missing secrets/defaults par start nahi hota.
- [ ] Access/admin/reset/verify-email/license tokens purpose-enforced hain.
- [ ] Stripe live keys/signature secret required hain; production mock billing impossible hai.
- [ ] Stripe events idempotent, retry-safe, transactionally processed hain.
- [ ] Desktop app license endpoint consume karke entitlements enforce karta hai.
- [ ] LAN dashboard non-loopback bind par HTTPS-only hai.
- [ ] SSRF/private-network policy documented and tested hai.
- [ ] Chromium and Firefox extensions clean checkout se package hoti hain.
- [ ] Every manifest-referenced file artifact mein present hai.
- [ ] macOS claim removed ya signed/notarized build + backend release fields complete hain.
- [ ] HTTP resume validators and checksum behavior tested hai.
- [ ] Mega fixture tests pass karte hain ya feature experimental/disabled hai.
- [ ] Backend, C++ core, IPC, dashboard, extension, and website integration tests CI mein run hote hain.
- [ ] C++ and JavaScript dependency audits reviewed hain.
- [ ] Version, homepage, download links, changelog, installer metadata, update feed consistent hain.
- [ ] Clean Linux and Windows installation/manual smoke tests pass hain.
- [ ] Real browser native-messaging handoff and authenticated download test pass hai.
- [ ] No unresolved Critical/High findings remain without written risk acceptance.

## 14. Final Audit Conclusion

Nexa ka desktop core ordinary prototype se kaafi aage hai: architecture real downloader concerns—segmentation, persistence, retry, auth scoping, native bridge, media, torrents, AI, and dashboard—address karti hai. Local verification bhi healthy hai: fresh warning-enabled C++ build and both registered tests pass, both React apps build, backend/extension syntax pass, and Debian package generation pass.

Lekin current repository ko **production-ready complete project** kehna evidence ke mutabiq premature hoga. Sab se pehle production security gates, Stripe lifecycle, license integration, LAN security, reproducible extension packaging, macOS claim, database documentation, and automated integration tests complete karne honge. In changes ke baad hi paid website launch ya broad installer distribution ka risk acceptable hoga.

**Audit status:** `Completed — remediation pending`  
**Source-code changes in this audit:** `None; only this report was added`  
**Recommended next action:** P0 backlog ko tracked issues/commits mein convert karke security-first remediation sprint start karein.