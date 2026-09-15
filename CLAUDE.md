# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Two products, one repository

| | Where | What |
|---|---|---|
| **Desktop app** | repo root (`src/`, `native-host/`, `extension-*/`) | C++20 / Qt 6 download manager, its native-messaging host and browser extensions |
| **Web platform** | `ndm-website/` | Node/Express + MySQL API, the public React site, and one React build serving both control panels |

They are not independent: the website is the licence authority, the ad server and
the update feed the desktop app talks to. See **Where the two halves meet** below
before changing anything on either side of that boundary.

## Build Commands — desktop app

```bash
# Configure (first time). A release build needs the licence-token public key —
# it is committed at packaging/license-public-key.txt, so a fresh clone just works.
# Regenerate the pair only when rotating: cd ndm-website/backend && npm run license:keygen
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release

# Local development (honours NEXA_* endpoint overrides, uses the public dev
# signing key, skips symbol stripping). Never ship a build configured this way.
cmake -B build-dev -G Ninja -DNEXA_DEV_BUILD=ON

# Build all targets
cmake --build build

# Build with tests enabled
cmake -B build -G Ninja -DNEXA_BUILD_TESTS=ON
cmake --build build

# Dev build that honours NEXA_LICENSE_API_URL / NEXA_ADS_API_URL / NEXA_UPDATE_URL /
# NEXA_ALLOW_INSECURE_LICENSE_API (for pointing at a local backend). A release
# build compiles those overrides OUT — never ship a binary built with this on.
cmake -B build -G Ninja -DNEXA_DEV_BUILD=ON

# Run unit tests
ctest --test-dir build --output-on-failure
ctest --test-dir build --output-on-failure -R themes   # one suite
# Windows (MSYS2 MinGW64, same toolchain as CI): configure from a path WITHOUT
# spaces (Qt's LinguistTools macro breaks on them) — e.g. a junction C:/nexa -> the repo.
#   MSYSTEM=MINGW64 bash -lc "cd /c/nexa && cmake -B build-tests -G Ninja -DNEXA_BUILD_TESTS=ON -DCMAKE_PREFIX_PATH=/mingw64 && cmake --build build-tests && ctest --test-dir build-tests"
node tests/ExtensionProviderConfigTest.js && node tests/ExtensionSettingsTest.js
node tests/ExtensionContentTest.js            # on-video button + quality dropdown (jsdom from ndm-website/frontend)
NEXA_REQUIRE_JSDOM=1 node tests/ExtensionContentTest.js   # what CI runs: a missing jsdom FAILS instead of skipping
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

## Build Commands — website (`ndm-website/`)

```bash
# Dev servers (three separate apps)
(cd backend  && npm run dev)   # :3001
(cd frontend && npm run dev)   # :5173         proxies /api → :3001
(cd admin    && npm run dev)   # :5174/admin/  and :5174/root/ from one bundle

# Backend tests
(cd backend && npm run test:unit)          # pure units — NO database needed, use this by default
(cd backend && npm test)                   # + integration suites; they SKIP when MySQL is absent
(cd backend && node --test test/license.test.js)              # a single file
(cd backend && node --test --test-name-pattern='seat' test/api.integration.test.js)

# Integration tests want a throwaway MySQL — recipe in backend/test/README.md.
# The socket path must be short (<108 chars), so keep it out of a deep tmpdir:
#   mysqld --datadir=/tmp/ndm/data --socket=/tmp/ndm.sock --port=3399 ...
# and remember to shut it down; a live mysqld pins its deleted datadir on tmpfs.
MYSQL_HOST=127.0.0.1 MYSQL_PORT=3399 MYSQL_USER=ndm \
MYSQL_PASS=test_password_at_least_16_chars MYSQL_DB=ndm_test npm test

# Frontend / admin
(cd frontend && npm test)            # vitest component tests
(cd frontend && npm run test:e2e)    # playwright, uses system Chrome
(cd frontend && npx eslint .)        # same in admin/
(cd frontend && npm run build)       # vite build + scripts/prerender.mjs

# Operations
(cd backend && npm run migrate -- --status)   # applied vs pending, changes nothing
(cd backend && npm run create-root -- "Owner" owner@example.com 'a-long-password')
(cd backend && npm run create-admin)
(cd backend && npm run license:keygen)        # Ed25519 pair for licence tokens
./deploy/build-and-upload.sh                  # builds locally, rsyncs to Hostinger
```

Locally the backend boots with **no** Stripe or SMTP keys — billing runs in mock
mode (`constructEvent` is `JSON.parse`, so a webhook test is just a POST of the
event body) and emails are logged to the console. That is only true for a
**local** deployment: `config/deployment.js` treats any `FRONTEND_URL` that is
not localhost / a private-network host as public, and `config/env.js` then
applies the full production checklist whatever `NODE_ENV` says — refusing dev
secrets, HTTP origins, an empty `ADMIN_ALLOWED_IPS`, an unset `TRUST_PROXY`,
mock email and a missing licence signing key, all listed in one boot failure.
A public box without Stripe keys runs with billing **disabled** (checkout,
portal and webhook answer 503), never in mock mode; `config.stripeMode` is
`'live' | 'mock' | 'disabled'`.

## Targets

| Target | Description |
|--------|-------------|
| `nexa` | Main Qt desktop GUI app |
| `nexa-host` | Native messaging bridge (tiny stdio exe) |
| `nexa_auth_test` | Auth unit tests (requires `NEXA_BUILD_TESTS=ON`) |
| `nexa_format_test` | UI formatter unit tests |
| `nexa_theme_test` | Every theme: palette completeness, WCAG contrast per role, unique accent + motion trio, every motion style paints |
| `nexa_mega_crypto_test` | MEGA key folding, attribute decryption, AES-CTR + chunked CBC-MAC vs a reference |
| `nexa_download_core_test` | White-box HTTP core against local servers: pause/resume through the DB, retry budget, chunked unknown-length bodies, ETag change (206 and strict 200), dynamic re-segmentation, speed limits, DB migration |
| `nexa_offline_grace_test` | Offline grace end-to-end against a real socket: a paying user keeps Pro (with entitlements) for 7 days offline, day 8 drops to Free, and a copied/garbage/Free cached token grants nothing |
| `nexa_license_token_test` | Ed25519 licence-token verification: forged/`alg:none`/HMAC-confusion/tampered/expired tokens all refused |
| `nexa_guard_test` / `nexa_guard_obf_test` | The licence guard compiled BOTH ways (plain, and with `NEXA_OBFUSCATE_LICENSE`) — same assertions on all 32 input combinations prove obfuscation never changes the answer, that a patched "paid" state trips the tamper canary, and that a lapsed-but-real customer never does |
| (ctest) | `public_url`, `cloud_providers`, `range_integrity`, `database_persistence`, `themes`, `download_task`, `download_core`, `license_token`, `offline_grace`, `guard`, `guard_obfuscated` also run |

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
- **Single-threaded:** All async I/O runs on Qt's event loop — no worker threads, no mutexes. The one sanctioned exception is a throw-away `QThread::create` for a blocking OS call that has no async form and shares no state: `DownloadTask::growFileAsync` (growing the destination file) and `proxyconfig`'s one-time system-proxy warm-up (Windows WPAD auto-detect blocks the calling thread). Results come back only through `QThread::finished`.
- **Destination files are sparse and grown off-thread:** on Windows the file is marked `FSCTL_SET_SPARSE` before it is sized, because NTFS zero-fills from its valid-data-length to the first write past it *inside that write* — 14 s for 2 GB on a SATA SSD, and a 32-way download writes at 31/32 of the file immediately, which froze the window at download start. FAT32/exFAT zero-fill inside `SetEndOfFile` itself, so the resize (plus a last-byte poke that settles the valid-data-length wherever sparse was refused) runs on the worker; the row shows "allocating … on disk" until it lands.
- **Dynamic re-segmentation:** When a segment worker finishes early, it steals the tail of the longest remaining segment (IDM-style speed, no threads).
- **Self-registering native host:** On every launch, `NativeHostRegistrar` refreshes browser manifests so no manual install is needed.
- **Browser extension auto-install:** on every launch `extinstall::registerExtensions()` (`src/ipc/ExtensionInstaller.cpp`) detects installed browsers and hands each one the extension *from its own store* — Chromium family via an "external extension" entry (HKCU registry on Windows, `External Extensions/<id>.json` on macOS, `/usr/share/<browser>/extensions/<id>.json` or a `normal_installed` managed policy on Linux), Firefox via an `ExtensionSettings` policy pointing at a signed `.xpi`. The store ids live in **one** file, `packaging/extension-ids.env` (bundled in the qrc, sourced by `packaging/register-browser-extensions` from the .deb postinst, parsed into NSIS lines by `build.yml`); an empty id makes that browser report "waiting for the store listing" in the setup guide instead of silently doing nothing. Linux hooks are system-wide, so the app only verifies them at runtime; `sudo nexa --register-extensions` writes them for non-.deb installs. Snap/flatpak browsers cannot read any of these hooks and are reported as manual. Nothing can auto-install an unpublished extension.
- **Domain-scoped auth:** `AuthenticationManager` maintains per-domain `cookies.txt` files that are passed as `--cookies` flags to yt-dlp. On Linux/macOS an auto-detected `--cookies-from-browser` credential wins over the extension's cookie export (`IpcServer`) because it reads the browser's live jar for the whole session, while the export is a snapshot. On Windows the export always wins: Chrome/Edge/Brave 127+ App-Bound Encryption makes yt-dlp unable to read the store at all — `browserlogin::detectBrowser()` therefore only auto-registers Firefox there, and course sites on Windows work through the extension button, not pasted URLs. Course sites are also gated on the `authSiteDownloads` entitlement: a device that has never validated a licence is on the Free set and `addDownload` refuses them with the reason now returned to the extension too.
- **MEGA in-process:** `MegaGrabber` decrypts AES-128-CTR as bytes stream in (OpenSSL libcrypto, already a libtorrent dependency) and verifies MEGA's chunked CBC-MAC before marking done — no openssl CLI, no temp file, no GUI stall.
- **Ads (Free plan only):** `AdService` polls `GET /api/ads?placement=app_banner` and `AdBanner` draws the strip above the download list. Entitlement is checked **twice on purpose** — `AdService` refuses to fetch or emit once the licence reports pro/team, and the server independently returns `{adFree:true, ads:[]}` for a paid licence token. `AD_FREE_PLANS` in `backend/src/utils/ads.js` is the single source of truth; an absent/forged/expired token resolves to `free` (sees ads), never to ad-free. The client re-validates every link is `https` even though the server already does. Admins manage ads in the admin panel (`/admin/ads`).
- **AI helpers run on the server, not in the app.** `AiClient` posts to `/api/ai/rename` and `/api/ai/command` with the licence token; `routes/ai.js` checks `entitlementsFor(plan).aiRename` and only then calls Anthropic with the server's key. It used to call `api.anthropic.com` directly using `$ANTHROPIC_API_KEY`, which made `aiRename` decoration — the gate was a client-side bool over an API the client reached by itself. **The prompts live on the server and the endpoints accept only structured fields** (`filename`/`url`/`contentType`, or `text`); a proxy that forwarded a client-supplied prompt would be a free Claude gateway for anyone holding a token. `aiLimiter` is the tightest limiter in the file and counts in MySQL, because these calls cost real money.
- **Entitlements are re-derived from the signature, not trusted once.** `LicenseManager::features()` is a cached struct the UI reads constantly; a 60-second timer re-derives it from the signed token (`deriveFromToken`), so overwriting it in memory buys a minute. `verifiedFeatures()` re-runs verification on demand and is what the expensive gates use (`DownloadEngine::addDownload`'s auth-site check reads **both**), so getting past one means defeating a bool in one translation unit *and* an Ed25519 check in another.
- **The public key is checked against a build-time digest.** Swapping the embedded key for your own is far cheaper than breaking Ed25519 and is invisible to the verifier, so CMake stores `SHA256(key)` in a separate translation unit (`KeyIntegrity.cpp`) and `deriveFromToken` refuses when they disagree — degrading silently to Free, never a dialog or a crash that would signpost the check.
- **The paid decision is guarded by redundant, obfuscated, per-release-rotated checks — and none of them is a fake.** `src/license/Guard.{h,cpp}` combines several independent re-verifications (key-digest, live-token, cached-grace, in-memory-claim, "a signed paid grant exists at all"), each a genuine re-derivation from the Ed25519 signature that every legitimate user passes. `verifiedFeatures()` routes through it, and the auth-site gates, `DownloadEngine::applyLicensePlan` and the 60-second recheck all read that verified path in different translation units, so patching one branch leaves the rest deriving Free. When the in-memory plan claims paid but no signature backs it, a **sticky tamper canary** (`m_tamperObserved`) latches and scattered reads fold quietly to Free a minute later — degrade only, never a crash, brick or data change. The canary keys on "no signed paid grant exists **at all**", never on the grace window, so a real customer whose offline grace merely lapsed can never trip it (`tamper` requires `!paid`, proved in `GuardTest`). `-DNEXA_OBFUSCATE_LICENSE` (on for Release/MinSizeRel, off for dev and tests) flattens the guard's control flow with opaque predicates and masked booleans; `NEXA_CHECK_ROTATION_SEED` (derived from `PROJECT_VERSION`, overridable) permutes its shape at compile time so a patch crafted for one release lands on rearranged code in the next. `src/license/Obfuscation.h` degrades to a zero-cost passthrough when the macro is off, and the same source compiled both ways is asserted identical by `nexa_guard_test`/`nexa_guard_obf_test`.
- **License offline grace:** `LicenseManager` caches the last server-confirmed plan; a network failure keeps a paid plan for 7 days. A 7-day Pro trial is signalled by `trial: true` from `/api/license/validate`.
- **Licence tokens are Ed25519, not HMAC:** the app has to verify a licence *itself*, offline, on a machine the user controls — an HMAC secret would have to ship inside the binary. The server signs with a private key (`backend/src/config/licenseKeys.js`, `utils/ed25519Jwt.js`); the binary carries only the public key (`packaging/license-public-key.txt` → `src/license/LicenseToken.cpp`), which cannot forge anything. The verifier accepts exactly one algorithm on purpose: one that also accepted HS256 would let anybody sign a token using those published key bytes as the HMAC secret.
- **Key-sharing detection is the one control a crack cannot touch.** Seat limits cap *concurrency*, not *distribution*: a key posted on a forum and used by 500 people still shows only N concurrent seats, so seat enforcement never notices. What it leaves behind is a `license_activations` row per distinct machine, and those rows are never deleted (`releaseSeat` only clears the lease). `utils/licenseAbuse.js` (`assessSharing`) compares that all-time count — plus a 7-day burst count — against the seat count and records `ok`/`watch`/`suspected` on the subscription. It runs server-side off data the client cannot withhold, because *asking for a seat is the signal*. Two bars, deliberately far apart: `assessSharing` **flags** for review (4x/10x seats) and should stay sensitive; `autoSuspendReason` **suspends** (30x seats + 3 devices, or 20x in a week) and should stay rare, because it cuts off paid software with no human in the loop. A suspension never touches `status` — `cancelled`/`expired` make the client *delete* the key — it sets `sharing_suspended_at` and answers `seat_limit`, which the client keeps the key for, and it releases the seat it just granted so lifting it works immediately. Lifting (`POST /api/admin/subscriptions/:id/sharing/clear`) also sets `sharing_exempt`, because the device history that triggered it remains and the next activation would otherwise re-suspend within minutes. `LICENSE_AUTO_SUSPEND=false` keeps the flagging and stops the suspending. Admins review at `GET /api/admin/subscriptions/flagged`. **The assessment runs only in `/validate`, so `/heartbeat` must never register a machine** — `acquireSeat({renewOnly:true})` refuses a device with no activation row (`seat_unknown_device`, sent as `seat_limit`). It previously refused only a *revoked* row and fell through to the INSERT for an unknown one, so a client that simply never called `/validate` took a seat and collected signed tokens with the sharing check skipped entirely. Enforcement a modified client can dodge by picking a different endpoint is not enforcement.
- **Seats are concurrent, not permanent:** a licence covers N machines *at a time*. The device id is a SHA-256 of the primary MAC (lowest-numbered up Ethernet/Wi-Fi interface, so VPN/Docker adapters can't change it) plus `machineUniqueId` — the raw MAC never leaves the machine. `LicenseManager` heartbeats every 5 min to hold a 15-min server-side lease and calls `releaseSeat()` on exit; a crash frees the seat when the lease lapses. A full licence answers `reason:"seat_limit"`, which keeps the key and says "close Nexa elsewhere" — it is deliberately **not** treated as a bad licence.
- **A leaked key is taken back by replacing it, not by editing a roster.** A Team member is handed the *owner's real licence key* — that is what unlocks the app for them — and `/license/validate` authenticates a key and a device, never a person, so no activation row records who created it. Removing somebody from the team therefore revokes nothing: they keep a working seat for as long as the plan lives. `POST /api/user/license/rotate` (`Subscription.rotateLicenseKey`) is the remedy: a new key **and** `revoked_at` on every activation, in one transaction, because either half alone leaves the old copies working. Activation rows are kept — they are the all-time device history the sharing check reads, and deleting them would launder a shared key's record.
- **Entitlements come from a *signed* token, not from JSON:** `/api/license/validate` returns an **Ed25519** licence token; `src/license/LicenseToken.cpp` verifies it against the public key compiled in from `packaging/license-public-key.txt`, and `LicenseManager` reads `plan` and `features` from those signed claims — never from the sibling JSON. The token is bound to the machine's `device` fingerprint, and it is the token (not a `cachedPlan` string) that is persisted for the 7-day offline grace, whose window is measured from the token's server-issued `iat`. Consequences worth remembering: a fake licence server cannot mint entitlements, editing the settings file cannot buy a plan, and a token cannot be copied between machines. The signing key never leaves the server (`LICENSE_JWT_PRIVATE_KEY`); rotating it means **shipping the desktop update with the new public key first**. Verification pins `alg` to `EdDSA` on both sides — accepting an HMAC would let anyone sign with the published public key as the secret.
- **Endpoints are pinned at compile time.** `NEXA_LICENSE_API_URL`, `NEXA_ADS_API_URL`, `NEXA_UPDATE_URL` and `NEXA_ALLOW_INSECURE_LICENSE_API` are compiled out unless `-DNEXA_DEV_BUILD=ON`. Each was a complete bypass needing no reverse engineering; the update one also let a redirected feed supply both an installer and the SHA-256 it was checked against.
- **Entitlements come from the server:** `/api/license/validate` returns a `features` object (and embeds it in the signed token). `Entitlements` in `LicenseManager.h` defaults to the **Free** set, so a build that is offline before its first validation gates rather than leaks. `DownloadEngine::applyLicensePlan` reads it for the concurrency cap, AI rename and `authSiteDownloads`; login-gated course sites (Udemy, Coursera, LinkedIn Learning) are refused in `addDownload` with `downloadBlocked`. Free gets the two core themes — `ThemeGalleryDialog` still renders every paid theme's real preview behind a PRO badge, because the gallery is the upgrade's best advert.
- **Update feed is Ed25519-signed:** `UpdateChecker` polls `https://nexadownloadmanager.com/api/releases/feed?os=<platform>` (`{version,url,notes,sha256,signature}`) and **refuses an unsigned or badly-signed feed**. The signature covers `version|url|sha256` (newline-delimited, `nexa-update-v1` prefix) and is checked against the same public key as licence tokens. This is not belt-and-braces: the feed supplies both the installer URL and the SHA-256 it is checked against, so whoever controls the response controls both halves and the checksum alone proves nothing — the app then *runs* what it downloaded. `notes`/`publishedAt` are outside the signature so a changelog can be corrected without re-signing. Rollout order is backend first, then the client. The installer is downloaded through the engine with the checksum enforced, then launched. Admins now **upload** the installer itself (raw `application/octet-stream` PUT, streamed to disk, SHA-256 computed in flight) instead of pasting a URL and a hash; the download route serves it with byte-range support so a dropped transfer resumes.
- **Scheduler persistence:** scheduled jobs live in the SQLite `scheduled` table (URL/time/name only — never headers) and re-arm on startup.
- **Theming:** every colour comes from `theme::current()`; one stylesheet template is generated per theme. Never hard-code a colour in a widget. 64 built-in themes live in `src/ui/Theme.cpp`: Nexa Dark and Nexa Light are hand-tuned palettes, the rest are derived from a one-line `Recipe` (ground, panel, border, two text tones, three brand stops, five status hues) by `build()`. Adding a theme = adding a `Recipe` row. `ThemeGalleryDialog` renders each as a live miniature of the real layout; `tests/ThemeContrastTest.cpp` asserts WCAG contrast for every role in every theme.
- **Row hover is painted by the view, not by QSS:** there is deliberately no `QTableWidget::item:hover` rule. Qt applies it per cell and the cells that carry widgets never show it, so a row lit up block by block. `ReorderTable` (MainWindow.cpp) paints one band under the hovered row with a short `QVariantAnimation` fade — a plain hover, no travelling highlight. Moves over cell widgets stop at that widget, so the band is fed from an application event filter, not from the viewport's `mouseMoveEvent`.
- **Motion is part of the theme:** `Palette::motion` names the gauge style (`Meter`: arc/ring/bars/needle/orbit/wave), sparkline style (`Spark`: line/area/bars/dots/steps/ribbon), loading animation (`Loader`: bounce/shimmer/stripes/pulse/comet/dash/segments/wave), progress fill (`Fill`: gradient/solid/striped/glow/stepped) and a `tempo`. Everything that moves is painted by `src/ui/Motion.cpp` (`paintGauge`, `paintSpark`, `paintLoader`, `paintFill`) and `motion::ThemedBar` replaces `QProgressBar` wherever a bar is shown. `motion::clock()` is the one animation phase (seconds × tempo); `motion::Ticker` is the one repaint timer, retained only by widgets that currently need frames. The theme test refuses two themes with the same gauge/spark/loader trio or the same accent, and paints every style with every palette.
- **Translations:** user-facing strings go through `tr()`. `tools/extract-translations.py` regenerates `translations/*.ts`; CMake compiles them when Qt LinguistTools is present.
- **Ad scheduling columns are DATETIME, not TIMESTAMP:** `ads.starts_at`/`ends_at` hold admin-chosen instants that can be years out, and TIMESTAMP stops at 2038-01-19 (scheduling past it is a MySQL error, not a warning). `initSchema` retypes them idempotently via `ensureColumnType`.
- **Database timezone:** the MySQL pool pins every connection to UTC (`config/db.js`). Without it `NOW()` and the driver disagree on any server not already on UTC, and every stored date reads back offset.

## Website architecture (`ndm-website/`)

**`ndm-website/CONTRACT.md` is the single source of truth for the backend — read it
before touching any route file.** It fixes the response envelope, every endpoint,
the token families and the schema exports. `frontend/FRONTEND_CONVENTIONS.md` and
`admin/ADMIN_CONVENTIONS.md` do the same for their apps (both say: fill in page
files, never edit the shared scaffold).

- **Envelope, with two deliberate exceptions.** Everything answers
  `{ok:true,data}` / `{ok:false,error:{code,message}}` via `utils/respond.js`. The
  two endpoints the **C++ app** parses — `POST /api/license/validate` and
  `GET /api/releases/feed` — return a literal body instead, and validate always
  answers HTTP 200 even when the licence is bad, so the client parses one shape.
- **One admin bundle, two panels.** `admin/` is served at `/admin` (staff) and
  `/root` (creator); `admin/src/realm.js` reads the URL to pick the API namespace
  and routes. That is presentation only — the server gates each panel
  independently. Three token families with three separate secrets and three
  cookie paths (`ndm_refresh`, `ndm_admin_refresh`, `ndm_root_refresh`), so a
  staff token *claiming* `role:'root'` fails signature verification, not a role
  check. A creator can only be minted by `npm run create-root`; `requireRoot`
  demands `role==='root'` **and** a match on `ROOT_ADMIN_EMAIL`.
- **`Subscription.current(sub)` is how every read path resolves a subscription** —
  lazy trial expiry, then lazy paid-plan lapse, no cron. Never read a row
  straight from `findByUserId` for a decision.
- **Nothing that merely runs out may answer `expired` or `cancelled`.** The
  desktop client *deletes* the stored key on both reasons. A lapsed plan falls
  back to `plan:'free', status:'active'` with the key intact, after
  `PAID_GRACE_DAYS` (3) absorbs a slow or retried renewal. Those two reasons are
  reserved for a licence somebody deliberately stopped via `subscriptions.status`.
- **Stripe drives the subscription; our rows only reflect it.** Handled events:
  `checkout.session.completed`, `invoice.payment_succeeded`/`invoice.paid`
  (renewals — the one that moves `expiry_date`), `invoice.payment_failed`,
  `customer.subscription.updated` (the hosted billing portal), `.deleted`, and
  `charge.refunded`. **An Invoice carries none of the Checkout Session's
  metadata**, so plan/cycle/period are read from the invoice's own line item via
  `utils/stripeInvoice.js` — never from `invoice.metadata`. `stripe_webhook_events`
  and `license_email_deliveries` are claim-ledgers making retries idempotent.
- **Seats are concurrent leases, not registrations.** `Subscription.acquireSeat`
  does the whole check in one transaction with the row locked `FOR UPDATE`, and
  excludes the calling device so a renewal is always free. `revoked_at` is what
  separates "an admin took this seat away" from "the lease lapsed" — without it a
  running client's next heartbeat silently undid the admin's action.
- **Rate limiting is split on purpose.** The security-critical limiters count in
  MySQL (`middleware/rateLimitStore.js`) so the keepalive cron's restarts do not
  hand out fresh budgets; the high-volume ones (`apiLimiter` on all of `/api`,
  ads, downloads) stay in memory, because a DB round-trip per request costs more
  than those counters are worth. Sign-in is keyed per **(IP, email)**, so one
  mistyped password cannot lock out an office NAT.
- **`config/plans.js#entitlementsFor` is the only place that decides what a plan
  may do.** It is returned beside the licence token *and* signed inside it, so a
  client editing its local copy still cannot make the server agree. Unknown,
  absent and forged plans resolve to `free` — every gate here fails closed.
- **`initSchema()` is the migration system** for anything additive and runs on
  every boot, so it must stay cheap: use `addColumnIfMissing` / `ensureColumnType`
  / `indexExists`, never an unconditional `ALTER`. Backfills and destructive
  changes go in `src/migrations/NNN-*.js` (`npm run migrate`).
- **The MySQL pool pins every connection to UTC** (`config/db.js`). Without it
  `NOW()` and the driver disagree on any server not on UTC and every stored date
  reads back offset. Columns holding admin-chosen or far-future instants are
  `DATETIME`, never `TIMESTAMP` — the free plan's expiry is ~100 years out and
  TIMESTAMP stops at 2038.

## Where the two halves meet

Changing either side of these without the other is the most likely way to break
the product silently. All three are covered by tests on the server side.

| Surface | Desktop | Server |
|---|---|---|
| Licence + entitlements | `src/license/LicenseManager.cpp`, `LicenseToken.cpp` | `routes/license.js`, `config/plans.js`, `config/licenseKeys.js` |
| Ads (Free plan only) | `src/ads/AdService.cpp` | `routes/ads.js`, `utils/ads.js` |
| Update feed | `src/core/UpdateChecker.cpp` | `routes/releases.js`, `utils/releaseFeed.js` |

Ad impressions and clicks only count when the client echoes back the short-lived
token `GET /api/ads` issued with that ad (`utils/ads.js#signAdEventToken`) — the
endpoint is otherwise public, and the CTR the admin panel reports has to mean
something. An older build sends no token and is ignored rather than rejected.
The signature proves the token is ours; a nonce **budget** (`ad_event_nonces`,
`Ad#claimEventNonce`) stops the same token being replayed for the rest of its
life. Deliberately a rate, not single-use — `AdService` holds one token per ad
for a 30-minute refresh cycle, reports an impression on every 45-second rotation
and reuses it for the click, so one-shot would have counted one impression per
client per half hour and no clicks at all.

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

### Website

| Path (under `ndm-website/`) | Role |
|------|------|
| `CONTRACT.md` | **The backend contract — read before editing any route** |
| `backend/src/config/env.js` | All configuration + the fail-closed production checks |
| `backend/src/config/schema.js` | Idempotent schema, applied on every boot |
| `backend/src/config/plans.js` | Plan catalogue + `entitlementsFor` — the entitlement authority |
| `backend/src/models/Subscription.js` | Seat leases, trial/lapse downgrades, plan changes |
| `backend/src/routes/webhooks.js` | Stripe events; `utils/stripeInvoice.js` reads their shapes |
| `backend/src/middleware/adminAuth.js` | `requireAdmin` / `requireRoot`, the IP gates, `isRootUser` |
| `backend/test/README.md` | How to get a throwaway MySQL for the integration suites |
| `admin/src/realm.js` | Which control panel this bundle is rendering |
| `deploy/README.md` | Hostinger deploy, cron jobs, backups, Stripe webhook setup |

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
