# Nexa Download Manager — architecture, as found

*Written during the QA & security audit (Phase 0). This describes the system as
it actually is in this repository, not as the marketing site presents it. It is
what decides which Phase 2 sections are critical and which are not applicable.*

Repository head at time of writing: branch `audit/website-hardening-and-billing`,
commit `7fe3616`.

---

## 1. There are two products, and only one of them touches user URLs

| | Where | What it is |
|---|---|---|
| **Desktop app** | repo root — `src/`, `native-host/`, `extension-*/` | C++20 / Qt 6 download manager, a native-messaging bridge, and two browser extensions |
| **Web platform** | `ndm-website/` | Node 20 / Express + MySQL API, a public React site, and one React bundle serving both control panels |

**The single most important finding of Phase 0:** *no download resolution
happens on the server.* The website is a licence authority, an ad server, a
release feed and a billing front end. It never receives a download URL, never
resolves one, and never fetches one.

Grep evidence:

```
$ grep -rn "child_process|exec\(|execFile|spawn\(" ndm-website/backend/src
(no matches — the only hit is a regex literal in utils/releaseFiles.js:184)

$ grep -rn "fetch\(|axios|http.request|https.get" ndm-website/backend/src
backend/src/utils/aiProxy.js:55:   await fetch(ANTHROPIC_URL, …)   # a constant
```

The backend makes exactly one outbound HTTP call in its own code, to a
hard-coded `https://api.anthropic.com/...`, plus whatever the `stripe` and
`nodemailer` SDKs do to their own fixed endpoints. There is no user-supplied
URL anywhere in the server's fetch path.

**Consequence for the audit plan:**

| Phase 2 section | Where it is actually reachable |
|---|---|
| 2.1 Command injection | **Desktop only.** No server-side process spawning exists. |
| 2.2 SSRF | **Desktop only** — and against the *user's own* LAN, not a cloud metadata service. The website has no fetch-a-URL endpoint at all. |
| 2.3 Path traversal / file handling | **Desktop** (save paths, HLS temp dirs, torrent file lists) **and server** (release-artifact upload/download in `utils/releaseFiles.js`). |
| 2.4 Resource exhaustion | Both, but differently: the desktop's LAN dashboard, and the website's public endpoints. |
| 2.5 Supply chain | Both — updater, installers, npm tree, yt-dlp pinning. |
| 2.6 Web layer | Website, plus the desktop's own embedded HTTP dashboard. |

There is a full auth/licence system, so no Phase 2.6 section is skipped.

---

## 2. Desktop app

### 2.1 Shape

Single-threaded on Qt's event loop. No worker threads, no mutexes — every
async operation is a signal/slot continuation. One unified queue treats HTTP
files, HLS/DASH, yt-dlp sites and BitTorrent identically.

```
Browser extension ──native msg──► nexa-host ──4-byte-framed JSON──► IpcServer
                                                                       │
User pastes / CLI arg ─────────────────────────────────────────────►   │
Phone browser ──HTTP+Bearer──► WebServer (:8088, loopback by default) ─┤
                                                                       ▼
                                                             DownloadEngine
                        ┌──────────────────┬───────────────┬───────────────┐
                        ▼                  ▼               ▼               ▼
                  DownloadTask       HlsGrabber      YtDlpGrabber   TorrentManager
                 (segmented HTTP)   (+ffmpeg mux)    (yt-dlp proc)   (libtorrent)
```

### 2.2 Every place the app spawns a process

| Call site | Binary | Argument source |
|---|---|---|
| `src/site/YtDlpGrabber.cpp:485,672` | `yt-dlp` | URL, format id, output template, cookie file |
| `src/site/SpotifyGrabber.cpp:626,775` | `yt-dlp`, `ffmpeg` | search query / URL |
| `src/grabber/HlsGrabber.cpp:504` | `ffmpeg` | local concat list + output path |
| `src/core/VirusScanner.cpp:96` | Defender / `clamscan` | a local file path |
| `src/ipc/IpcServer.cpp:401` | `yt-dlp` | URL, for `list-formats` |
| `native-host/nexa-host.cpp:184` | `nexa` itself | `--background`, constant |

All six use `QProcess::start(program, QStringList args)` — the **argument-list**
overload, which on POSIX goes straight to `execvp` and on Windows quotes per
`CommandLineToArgvW`. None builds a shell string. `QProcess::startDetached` in
the native host passes a constant argument. There is no `system()`, no
`popen()`, no backticks, and `setNativeArguments()` (the one Qt API that would
bypass quoting on Windows) is never called. The yt-dlp call sites additionally
place a literal `--` before the URL so a URL beginning with `-` cannot be read
as a flag.

### 2.3 Where user-supplied URLs are fetched, and by what

Everything is in-process in the desktop binary. `src/web/PublicUrlPolicy.cpp`
implements an SSRF policy — `isPublicHttpUrl()` — that rejects non-HTTP(S)
schemes, embedded credentials, `localhost` / `*.local` / bare hostnames, IPv4
private-and-special ranges (including `169.254.0.0/16` and `100.64.0.0/10`),
IPv6 loopback/link-local/multicast and `fc00::/7`, and optionally resolves the
hostname and rejects if *any* returned address is non-public. Verdicts are
cached per host for 60 s (a latency fix; the check was always TOCTOU because
the resolved address is not the address the socket later connects to).

It is enforced at 15 call sites covering the initial URL **and every redirect
hop** in `DownloadTask`, `SegmentDownloader` and `HlsGrabber`, gated by a
`m_publicNetworkOnly` flag that is set for untrusted entry points.

### 2.4 Trust boundaries, from least to most trusted

1. **The LAN dashboard** (`src/web/WebServer.cpp`) — an embedded HTTP server,
   loopback-bound unless `dashboard/lan` is set, in which case it *requires*
   `NEXA_TLS_CERT`/`NEXA_TLS_KEY` and refuses to start without them. Every
   request needs a 128-bit token (`QUuid::createUuid().toString(Id128)`,
   persisted in `QSettings`), compared in constant time, with a per-IP
   failed-auth throttle. Its `/api/add` runs `addRemoteBatch` → `addRemoteDownload`,
   which enforces `isPublicHttpUrl()` **and** re-checks the paid entitlement
   through `verifiedFeatures()` in a second translation unit.
2. **The browser extension**, via `nexa-host` → `IpcServer` on the
   `nexa-ipc` local socket. Untrusted-ish: the extension runs on `<all_urls>`
   and forwards page-supplied URLs and cookies. `IpcServer.cpp:257,303` applies
   the same public-URL policy.
3. **The local UI** — trusted. It may hand `addDownload()` a local `.torrent`
   path, which the remote paths deliberately cannot (`isAllowedRemoteScheme()`
   allows only `http`, `https`, `magnet`).

**All three untrusted callers now converge on one intake path.** `addDownload()`
is where `HlsGrabber`, `YtDlpGrabber`, `TorrentManager`, `MegaGrabber` and
`SpotifyGrabber` are chosen between, and both untrusted entry points reach it
with `publicNetworkOnly=true` — `IpcServer` for the extension, and
`addRemoteDownload()` for the dashboard. `addRemoteDownload()` gates the scheme
first (`isAllowedRemoteScheme`, which admits `magnet` — it has no host to
resolve — while everything HTTP still faces `isPublicHttpUrl`) and re-reads the
paid entitlement independently, then delegates.

It used to build a plain `DownloadTask` and stop, which is why the dashboard
could only ever fetch a direct file: a `.m3u8` arrived as the playlist text and
a magnet was refused, while its own placeholder and `docs/remote` promised both.
The thing to keep in mind when reading this path is that a dashboard caller can
now make the machine start a yt-dlp subprocess or a libtorrent session — which
is what a remote control is for, and why the token is 128 bits, compared in
constant time, and rate-limited per IP.

### 2.5 Auto-update

`src/core/UpdateChecker.cpp` polls
`https://nexadownloadmanager.com/api/releases/feed?os=<platform>` — a constant
in a shipped build; the `NEXA_UPDATE_URL` override is inside `#ifdef
NEXA_DEV_BUILD`. The feed returns `{version,url,notes,sha256,signature}`. The
signature is Ed25519 over `"nexa-update-v1\n" + version + "\n" + url + "\n" + sha256`
verified against the same public key as licence tokens; **a missing signature is
a refusal, not a pass**. The installer is then downloaded through the engine
with the SHA-256 enforced, and launched.

This design is correct for the threat: the feed supplies both the installer URL
*and* the hash it is checked against, so the hash alone proves nothing — only
the signature does.

Installer signing (`.github/workflows/build.yml`): Windows Authenticode via
`signtool` with an RFC-3161 timestamp, macOS `codesign --options runtime` plus
notarisation, both conditional on secrets being present. Linux `.deb` is not
signed.

### 2.6 Licence system (there is one — Phase 2.6 auth tests apply)

Ed25519 licence tokens, signed server-side, verified in-process against a
public key compiled in from `packaging/license-public-key.txt` whose SHA-256
is separately embedded (`src/license/KeyIntegrity.cpp`) so swapping the key is
detected. Entitlements are read from signed claims, never from sibling JSON.
Seats are 15-minute concurrent leases held by a 5-minute heartbeat. Offline
grace is 7 days, measured from the token's server-issued `iat`. The paid
decision is re-derived through `src/license/Guard.cpp`, compiled both plain and
obfuscated and asserted identical by two test targets.

### 2.7 Browser extensions

MV3, `manifest_version: 3`, identical permission sets for Chromium and Firefox:
`downloads, cookies, contextMenus, webRequest, storage, nativeMessaging,
notifications, scripting, tabs` plus `host_permissions: ["<all_urls>"]` and a
content script on `<all_urls>`. That is a broad but coherent grant for a
download manager that has to sniff media requests and export cookies. Chromium
manifest pins a `key` (fixed extension id); Firefox pins
`browser_specific_settings.gecko.id`.

---

## 3. Website

### 3.1 Three apps

- `backend/` — Express on :3001. 14 route modules under `/api`.
- `frontend/` — public React site (Vite), :5173, prerendered at build.
- `admin/` — one React bundle served at both `/admin` (staff) and `/root`
  (creator); `admin/src/realm.js` picks the namespace from the URL. That split
  is presentation only — the server gates each panel with a *separate token
  family, secret and cookie path*, so a staff token claiming `role:'root'`
  fails signature verification rather than a role check.

### 3.2 Public site routes (crawled from `frontend/src/App.jsx`)

`/`, `/download`, `/pricing`, `/reviews`, `/compare`, `/faq`, `/about`,
`/changelog`, `/contact`, `/terms`, `/privacy`, `/verify-email`,
`/forgot-password`, `/reset-password`, `/team/join`, `/docs` plus
`/docs/{install,extension,youtube,courses,torrents,remote,license}`,
`/login`, `/register`, and three `ProtectedRoute` pages `/dashboard`,
`/billing`, `/profile`. Unmatched paths render `NotFound`.

### 3.3 API surface

126 route handlers across 14 modules. Full table in `PROGRESS.md`; the
security-relevant grouping is:

| Group | Auth | Notes |
|---|---|---|
| `/api/auth/*` (9) | none (that's the point) | register/login/google/verify/refresh/logout/forgot/reset, Turnstile on the ones that send mail |
| `/api/user/*` (9), `/api/subscription/*` (9), `/api/team/*` (7), `/api/reviews` POST | `requireAuth` (customer JWT) | |
| `/api/license/*` (3) | licence key + device fingerprint | `validate` / `heartbeat` / `release`; **`validate` always answers HTTP 200** so the C++ client parses one shape |
| `/api/ads` (2), `/api/releases/*` (4), `/api/reviews` GET, `/api/stats`, `/api/health` | public | `releases/feed` returns a literal body, not the envelope |
| `/api/ai/*` (2) | licence token + `entitlementsFor(plan).aiRename` | prompts live server-side; endpoints accept structured fields only |
| `/api/admin/*` (44) | `requireAdmin` + IP allow-list + TOTP | |
| `/api/root/*` (14) | `requireRoot` — `role==='root'` **and** an `ROOT_ADMIN_EMAIL` match | |
| `/api/webhooks/stripe` (1) | Stripe signature | raw body parsed before `express.json` |

Everything answers `{ok,data}` / `{ok,error:{code,message}}` except two
deliberate exceptions consumed by the C++ client: `POST /api/license/validate`
and `GET /api/releases/feed`.

### 3.4 Middleware stack (`backend/src/app.js`, in order)

`helmet()` → `cors({origin: CORS_ORIGINS, credentials:true})` → `cookieParser`
→ morgan (path only, never the query string; `/api/health` 2xx skipped) →
raw-body for the Stripe webhook → `express.json({limit:'1mb'})` →
`apiLimiter` on all of `/api` → `originGuard` → routes → `notFound` →
`errorHandler`.

Rate limiting is deliberately split: security-critical limiters count in MySQL
(`middleware/rateLimitStore.js`) so a cron restart cannot hand out fresh
budgets; high-volume ones stay in memory. Sign-in is keyed per *(IP, email)*
with a looser per-IP ceiling behind it.

### 3.5 Configuration fail-closed behaviour

`config/deployment.js` calls any non-localhost, non-private `FRONTEND_URL`
"public", and `config/env.js` then applies the full production checklist
regardless of `NODE_ENV` — refusing dev secrets, HTTP origins, an empty
`ADMIN_ALLOWED_IPS`, an unset `TRUST_PROXY`, mock email, and a missing licence
signing key, all reported in one boot failure. A public box with no Stripe keys
runs with billing **disabled** (503), never in mock mode.

---

## 4. What Phase 1 and 2 must therefore cover

Reachable and worth testing:

- Desktop: URL intake from all four entry points, the SSRF policy including
  redirect hops, filename/save-path handling, torrent file-list traversal, HLS
  temp-file lifecycle, queue and settings behaviour, resume-after-interruption.
- Website: the 126 handlers, the envelope, IDOR across every `:id` route, the
  admin/root token separation, licence seat and sharing logic, the release
  artifact upload/download path, Stripe webhook idempotency, XSS on anything
  rendering user or external strings.
- Both: dependency CVEs, installer signing, the update feed contract.

Not applicable:

- Server-side command injection (no process spawning exists in the backend).
- Cloud-metadata SSRF (no server-side URL fetching exists; `169.254.169.254`
  is only reachable through the *desktop* app, against the user's own host).
