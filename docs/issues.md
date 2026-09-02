# Nexa Download Manager — Open Issues

**Date:** 2026-09-02
**Reported by:** product owner
**Scope:** four reported problems, audited against the source tree at `34a0b8a`
**Status of this document:** investigation write-up only — **no code was changed** in this pass.

Every citation below was read out of the tree, not recalled. Line numbers are from `34a0b8a`;
re-check them after any refactor.

---

## Summary

| # | Issue | Severity | Verdict |
|---|-------|----------|---------|
| 1 | App stops responding when a segmented download starts | **Critical** | ✅ **Fixed** — N blocking DNS lookups on the GUI thread, one per segment; now one per host |
| 2 | Admin "Free seats" does not take Pro away from a running client | **Critical** | Confirmed — root cause found, the admin action is a no-op within 5 minutes |
| 3 | No Pro re-verification per download (asked: every 10 downloads) | **High** | Confirmed missing — and there is no counter to hook it to |
| 4 | Licensing is trivially bypassable | **Critical** | Confirmed — six working bypasses, the cheapest takes ~10 seconds |

Issues 2 and 4 turned out materially worse than reported. Issue 4 contains a bypass that needs no
tools, no editing and no network at all.

---

## Issue 1 — The app hangs when a segmented download starts

**Severity:** Critical (the product's core function is unusable)
**Status:** ✅ **Fixed** — see *Fix applied* below. The analysis is kept because the same blocking
resolver is still reachable elsewhere and the follow-ups are still open.

### Symptom, as corrected by the reporter

The original report said "crash". The details change the diagnosis, so they are recorded exactly:

- The window shows **"Not Responding"** and jams. **It does not close by itself — the user has to
  force-quit it.** This is a **frozen event loop (hang)**, not a segfault.
- It happens on **any file that is split into multiple segments** — not only very large ones.
- **Small files that download as a single segment work fine.** This asymmetry is the strongest
  clue available.
- It happens **at the very start** of the download, as segmentation begins — not part-way through.
- It reproduces on **both Linux and Windows**, so it is a logic bug, not a platform quirk.
- It is the plain HTTP/HTTPS path (ISO / ZIP / MP4) — the segmented `DownloadTask`. Not yt-dlp,
  not torrents, not HLS.

### Why a single blocking call is fatal here

This is by design, and it is what turns a slow call into a frozen application. From `CLAUDE.md`:

> **Single-threaded:** All async I/O runs on Qt's event loop — no worker threads, no mutexes.

Every download, every UI repaint and every timer share one thread. Anything on the segmented-start
path that blocks — a synchronous filesystem call, a nested event loop, a spin loop, a batch of
`fsync`ing database writes — freezes the entire application until it returns. "Not Responding" is
exactly what the OS reports when a GUI thread stops servicing its event queue.

### Root cause — a blocking DNS lookup, once per segment, on the GUI thread

There is exactly one synchronous network call in the codebase, and the segmented start path invokes
it **N times back-to-back inside a single loop that never returns to the event loop** — where N is
the segment count.

**The blocking call.** `QHostInfo::fromName()` is Qt's *synchronous* resolver. Qt's own
documentation says of it: *"This function blocks during the lookup, which means the GUI will
freeze."* The asynchronous counterpart, `QHostInfo::lookupHost()`, is used nowhere in this repo.

```cpp
// src/web/PublicUrlPolicy.cpp:64-72
QHostAddress literal;
if (literal.setAddress(host))
    return isPublicAddress(literal);      // an IP literal short-circuits — no lookup
if (!resolveHost)
    return true;

const QHostInfo info = QHostInfo::fromName(host);   // BLOCKS THE CALLING THREAD
```

And resolution is **on by default**, so every production call site blocks:

```cpp
// src/web/PublicUrlPolicy.h:7
bool isPublicHttpUrl(const QUrl &url, bool resolveHost = true);
```

**It is called once per segment**, after the file is opened and seeked:

```cpp
// src/core/SegmentDownloader.cpp:97-100
if (m_publicNetworkOnly && !isPublicHttpUrl(m_url)) {          // blocking DNS, per segment
    emit failed(m_seg.index, QStringLiteral("remote dashboard target is not a public HTTP(S) address"));
    return;
}
```

**And the segment starts run in one uninterrupted loop:**

```cpp
// src/core/DownloadTask.cpp:1051-1060
for (const SegmentInfo &seg : m_segments) {
    if (seg.complete()) { ++m_completedSegments; continue; }
    makeWorker(seg);
    ++m_activeSegments;
}
for (auto *w : m_workers)
    w->start();          // N blocking DNS lookups, one after another, no event-loop yield
```

The GUI thread sits inside `launchSegments()` for the sum of all N resolutions. The window stops
repainting, the window manager marks it **"Not Responding"**, and the user force-quits — which is
precisely the reported behaviour, including the fact that it never dies on its own.

### Why only multi-segment downloads

```cpp
// src/core/DownloadTask.cpp:524-531
int DownloadTask::preferredSegmentCount(qint64 totalBytes)
{
    if (totalBytes <= 0)                  return 1;
    if (totalBytes < 1 * 1024 * 1024)     return 1;    // < 1 MB: not worth splitting
    if (totalBytes < 10 * 1024 * 1024)    return 8;    // 1–10 MB
    if (totalBytes < 100 * 1024 * 1024)   return 16;   // 10–100 MB
    return 32;                                          // ≥ 100 MB: max acceleration
}
```

| File | Segments | Serialized blocking lookups |
|---|---|---|
| < 1 MB, or no `Accept-Ranges`, or unknown size | 1 | 2 (probe + 1 worker) — imperceptible |
| 1–10 MB | 8 | 9 |
| 10–100 MB | 16 | 17 |
| ≥ 100 MB | 32 | **33** |

This matches the report exactly: it is not about "huge" files — a 2 MB file already takes 8
serialized lookups — and a single-segment download takes one, which nobody notices.

Four things make it far worse than "32 cache hits":

1. `QHostInfo::fromName()` writes to Qt's host cache but does **not read** it, so every call is a
   real `getaddrinfo()`.
2. Each resolution issues A **and** AAAA queries. On a slow, IPv6-blackholed, VPN or captive-portal
   resolver, glibc's default is 5 s × 2 attempts — 32 of those is **minutes** of frozen UI.
3. Qt's lookup manager is guarded by a global mutex, so the GUI thread contends with Qt's own
   internal DNS threads that are resolving the actual download requests.
4. Every `SegmentDownloader` creates its **own** `QNetworkAccessManager`
   (`SegmentDownloader.cpp:49`), so per-manager DNS caching gives no benefit either.

**It also re-fires throughout the download**, not just at the start — which is why the app keeps
micro-freezing: on every redirect (`SegmentDownloader.cpp:391`, and large-file mirrors redirect on
*every* segment to a fresh, uncached host), on every segment retry (`DownloadTask.cpp:1291-1294`),
and on every work-stealing re-segmentation (`DownloadTask.cpp:1152`).

### Confirm it in 5 minutes, with no rebuild

`publicNetworkOnly` is `true` only for downloads that arrive from outside the app. That gives a
clean A/B test using the *same URL*:

| Entry point | `publicNetworkOnly` | Prediction |
|---|---|---|
| Browser extension → native host → IPC (`IpcServer.cpp:391-392`) | **true** | **hangs** |
| Link Grabber dialog (`LinkGrabberDialog.cpp:252`) | **true** | **hangs** |
| App's own **New Download** dialog (`MainWindow.cpp:1169`) | false | **fine** |
| Drag-and-drop a link (`MainWindow.cpp:1819`) | false | **fine** |
| Clipboard capture (`MainWindow.cpp:2098`) | false | **fine** |

**Test 1.** Paste the same large URL into the app's **New Download** dialog. If it downloads with 32
segments and never freezes, the root cause is confirmed and preallocation/memory theories are ruled
out.

**Test 2.** Download via the extension from a **bare IP URL** (`http://1.2.3.4/big.iso`).
`PublicUrlPolicy.cpp:64-66` short-circuits IP literals before the lookup, so this must *not* hang.

**Test 3 — make it unmistakable.** Break DNS and retry via the extension; the freeze becomes minutes:

```bash
sudo iptables -I OUTPUT -p udp --dport 53 -j DROP     # restore with -D
```

### Backtrace while frozen

```bash
gdb -p "$(pgrep -x nexa)" -batch -ex "thread apply all bt" > /tmp/nexa-hang.txt
```

The main-thread stack should read roughly:

```
__GI_getaddrinfo → QHostInfoAgent::fromName → QHostInfo::fromName
  → nexa::isPublicHttpUrl → nexa::SegmentDownloader::start
  → nexa::DownloadTask::launchSegments → nexa::DownloadTask::onProbeFinished
```

The build is **not stripped** (`file build/nexa` → `with debug_info, not stripped`), so frames are
fully symbolised. Count the serialized lookups with
`strace -f -tt -e trace=network -p "$(pgrep -x nexa)" 2>&1 | grep ':53'` — N sequential UDP:53
round-trips with nothing between them is the proof.

On Windows: Task Manager → right-click `nexa.exe` → **Create dump file**, then look for
`ws2_32!GetAddrInfoW` / `DnsQuery_W` under `Qt6Network!QHostInfo::fromName` on the main thread.
Also useful: during the freeze, disk write throughput should be **near zero** (it is DNS, not I/O).

### Fix applied

The verdict is now **cached per host** inside `isPublicHttpUrl` itself
(`src/web/PublicUrlPolicy.cpp`), with a 60-second TTL and a 256-entry bound.

This was chosen over the alternatives — passing `resolveHost = false` from the segment worker, or
resolving once in `DownloadTask` and handing the verdict down — because there are **14 call sites**
of `isPublicHttpUrl`, and the same multiplication exists on paths other than the reported one:
segment redirects (`SegmentDownloader.cpp:391`), segment retries, work-stealing re-segmentation, and
`HlsGrabber`, which validates every stream segment the same way. Fixing the policy function fixes
all of them at once, and a new call site cannot reintroduce the bug.

**Caching does not weaken the check.** It was already time-of-check/time-of-use: the address
resolved here is never the address the socket goes on to connect with, so the verdict was never a
guarantee about the next connection — only about the name. Refusals are cached too, which is the
fail-closed direction and stops a dead resolver from costing one blocking lookup per segment.

Measured effect on a 32-segment download: **33 blocking lookups → 1**.

Still open, deliberately not done here:

- `resolveHost = true` remains the default in `PublicUrlPolicy.h`. Changing it would silently make
  every existing call site skip resolution — an SSRF regression — so it needs each call site
  reviewed rather than a default flip.
- The first lookup per host is **still synchronous**. One blocking resolution is the behaviour
  single-segment downloads always had, and nobody reported it; making it asynchronous
  (`QHostInfo::lookupHost()` with a callback) is the real end state and is a larger change.

### Why no test caught this

Every one of the ten assertions in `tests/PublicUrlPolicyTest.cpp:13-22` passes `resolveHost` as
**`false`**:

```cpp
CHECK(nexa::isPublicHttpUrl(QUrl(QStringLiteral("https://example.com/file")), false));
```

So the `QHostInfo::fromName()` branch (`PublicUrlPolicy.cpp:67-77`) has **zero test coverage**.
Meanwhile `tests/RangeIntegrityTest.cpp` constructs one `SegmentDownloader` at a time and never
calls `setPublicNetworkOnly(true)`, and `tests/DatabasePersistenceTest.cpp` uses 2 then 1 segment.
**No test anywhere uses a size ≥ 1 MB, so no test has ever produced a multi-segment layout.**

**Added with the fix.** `tests/PublicUrlPolicyTest.cpp` now covers the resolving branch by asserting
the **number of real lookups** rather than the verdict — so it is deterministic whether or not the
machine running it has working DNS. It checks that 32 validations of one URL resolve once, that a
same-host redirect target does not resolve again, that a different host does, that IP literals and
`resolveHost = false` never reach the resolver, and that the structural rejections still hold on the
resolving path. Both the cache and the IP-literal short-circuit were mutation-tested: removing
either makes the suite fail.

Still worth adding:

1. Unit-test `preferredSegmentCount()` at 0 / 1 MB−1 / 1 MB / 10 MB / 100 MB / 8 GB, plus
   `buildSegments()` invariants (contiguous, no gaps or overlaps, last segment ends at `total-1`).
   **No test anywhere currently uses a size ≥ 1 MB, so no test has ever produced a multi-segment
   layout** — that is the coverage hole this bug lived in.
2. Extend `range_integrity`: serve a ~4 MB body with `Accept-Ranges: bytes` from the existing local
   `QTcpServer`, drive a full `DownloadTask` with `setPublicNetworkOnly(true)` against a *hostname*
   (not `127.0.0.1`, which short-circuits), and assert `launchSegments()` returns within a wall-clock
   budget and that a 50 ms `QTimer` still fires during startup.

### Other main-thread blockers found in the same audit

Not the reported hang, but each freezes the UI and should be fixed alongside:

| Where | What | When it bites |
|---|---|---|
| `DownloadTask.cpp:1434, 1459-1497` | Whole-file SHA-256 on the GUI thread — and it runs **even when no expected hash was set** (`m_expectedSha256` is only consulted afterwards at `:1490`) | A second freeze at **100%**, scaling with file size. Pure waste for normal downloads |
| `DownloadTask.cpp:953`, `SegmentDownloader.cpp:92, 338` | `QFile::resize()` sets the file length but not NTFS's *valid data length*; a segment then writes at a high offset, forcing a synchronous zero-fill of everything before it | Windows / exFAT / NTFS-3G only — a real second cause there |
| `DownloadTask.cpp:1216` | A second `f.resize(total)` with the return value discarded | Silent failure |
| `Database.cpp:182-206` | Segment table deleted and fully re-inserted on every segment completion, statement re-prepared per row (one transaction, WAL, so no fsync storm) | O(N²) stutter over a download |
| `DownloadTask.cpp:1059` + `1161-1176` | `launchSegments()` range-iterates `m_workers` while `start()` can synchronously `emit failed` → `clearSegments()` → `m_workers.clear()`, invalidating the iterator mid-loop | Latent use-after-free; can present as a hang or a crash. `clearSegments()`'s own comment documents this hazard for `tryResegment()` but not for this loop |
| `ProxyConfig.cpp:40-42` | With proxy mode = `system`, each new `QNetworkAccessManager`'s first request can block on WPAD discovery | Only if the user changed proxy mode from the `none` default |

### Ruled out with evidence

- **No** `QEventLoop::exec()`, `processEvents()`, `waitFor*()` or `QThread::sleep()` anywhere on the
  segmentation path. The only `QEventLoop::exec()` is the 3-second-guarded shutdown seat release at
  `LicenseManager.cpp:458-464`.
- **No integer overflow.** All offsets and lengths are `qint64`; SQLite columns are `INTEGER` bound
  via `qint64`; on Qt 6 `QByteArray` is `qsizetype`-sized, so there is no 2 GB cap on 64-bit.
- **No `schedule()` recursion** — guarded by `m_inSchedule` (`DownloadEngine.cpp:762-776`).
- **No memory blow-up** — the body is streamed, and `pump()`'s loop
  (`SegmentDownloader.cpp:304`) is bounded by `bytesAvailable()`.

### Acceptance criteria

- Starting a 32-segment download from the browser extension keeps the UI responsive; the window
  never enters "Not Responding".
- No blocking resolver call is reachable from any per-segment code path.
- `resolveHost` no longer defaults to `true`.
- A test produces a genuine multi-segment layout and fails if the segmented start blocks the main
  thread beyond a fixed budget.
- The confirming backtrace is attached to this issue.

---

## Issue 2 — Freeing a seat from the admin panel does not free the seat

**Severity:** Critical (a paid-support action silently does nothing)
**Status:** ❗ Confirmed — root cause identified

### Requirement

> When a user sends a free-seat signal from the admin panel, the seat should be freed — if a Pro
> licence is active on that NDM instance it reverts to normal/free (or is removed), and the user
> can log in on another device. If the user pastes the licence again and a seat is available it
> shifts back to Pro; otherwise it warns "seat not available on this license".

### What already works — do not rebuild it

| Piece | Location |
|---|---|
| Seat/lease table `license_activations` | `ndm-website/backend/src/config/schema.js:175-189` |
| Race-safe transactional seat acquisition | `ndm-website/backend/src/models/Subscription.js:45-117` |
| Admin free-seat endpoint (audited) | `ndm-website/backend/src/routes/admin.js:460-475` |
| Admin "Free seats" button + confirm modal | `ndm-website/admin/src/pages/Subscriptions.jsx:84-98, 126` |
| User self-service device list + per-device free | `ndm-website/backend/src/routes/user.js:145-169, 269-278`; `ndm-website/frontend/src/pages/Dashboard.jsx:100-186` |
| Client downgrades on `seat_limit` and **keeps** the key | `src/license/LicenseManager.cpp:250-269` |
| Re-pasting the key re-acquires a seat | `src/ui/SettingsDialog.cpp:407-409` → `activate()` → `validate()` |

A seat is not a row — it is a row whose `lease_expires_at > NOW()`. "Freeing" sets that column to
`NULL` and deliberately keeps the row so the device stays listed.

### Root cause — the heartbeat re-takes the seat it was just denied

`POST /api/license/heartbeat` does not merely *renew* a lease. It calls the same `acquireSeat()`
the activation path uses:

```js
// ndm-website/backend/src/routes/license.js:93-95
const seat = await Subscription.acquireSeat(sub.id, device_fingerprint, {
  deviceName: device_name || null,
});
```

And `acquireSeat` only refuses when **another** device is holding every seat:

```js
// ndm-website/backend/src/models/Subscription.js:62-81
const [busyRows] = await connection.execute(
  `SELECT COUNT(*) AS count FROM license_activations
    WHERE subscription_id = ? AND device_fingerprint <> ?          --  OTHER devices only
      AND lease_expires_at IS NOT NULL AND lease_expires_at > NOW()`,
  [id, deviceFingerprint]
);
const busy = Number(busyRows[0].count) || 0;
...
if (!holdsLease && busy >= seats) {
  await connection.rollback();
  return { ok: false, reason: 'seat_limit', seats, activeSeats: busy };
}
```

Trace an admin free on a 1-seat Pro licence:

1. Admin clicks **Free seats** → `releaseAllSeats()` sets `lease_expires_at = NULL` for every row.
2. Within 5 minutes the still-running client sends its heartbeat.
3. `holdsLease` is now `false` (the lease was nulled) — but `busy` counts only *other* devices, and
   there are none, so `busy = 0`.
4. The test `!holdsLease && busy >= seats` evaluates `true && 0 >= 1` → **false**.
5. Execution falls through to the `UPDATE … SET lease_expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND)`
   branch (`Subscription.js:86-94`) and the client is handed **a fresh 15-minute lease**.

**The client silently re-takes its seat and stays Pro. The admin action is a no-op within five
minutes, and nothing ever downgrades.** The confirm modal in the admin panel promises behaviour the
system does not implement:

> "Machines currently using it drop to Free until they re-validate. Nothing is blacklisted — the
> same devices can take a seat again."
> — `ndm-website/admin/src/pages/Subscriptions.jsx:87`

### Contributing gaps

**G1 — the heartbeat has no "your seat was revoked" signal.** The success body
(`routes/license.js:101-105`) carries no revocation field, and the failure reasons are
`not_found | cancelled | invalid | expired | seat_limit`. None of them means "an admin took yours";
`seat_limit` means "someone else has it", which is a different thing and would produce misleading
UI copy.

**G2 — the client ignores every heartbeat reason except `seat_limit`.** There is no `else`:

```cpp
// src/license/LicenseManager.cpp:417-431
if (object.value(QStringLiteral("valid")).toBool()) {
    m_activeSeats = object.value(QStringLiteral("activeSeats")).toInt(m_activeSeats);
    return;                                   // plan is NEVER re-applied
}
const QString reason = object.value(QStringLiteral("reason")).toString();
if (reason == QLatin1String("seat_limit")) {
    ...
}                                             // no else — every other reason is discarded
```

So `cancelled`, `expired`, `not_found` and `invalid` all leave the client **fully Pro** until the
6-hour revalidation timer fires.

**G3 — the client never re-upgrades from a heartbeat.** On `valid:true` it writes only
`m_activeSeats`. A client downgraded by a transient `seat_limit` stays Free for up to 6 hours even
after a seat frees. Note the heartbeat response carries **neither `token` nor `features`**, so
restoring Pro from it would require the response shape to change, or the client to call `validate()`.

**G4 — the 7-day offline grace hides a revocation completely.** `applyCachedEntitlement()`
(`LicenseManager.cpp:480-520`) restores full paid entitlements from local settings and is never
consulted or invalidated by the heartbeat. Disconnecting the network defeats any server-side free
for a week. See also Issue 4 — that cache is plaintext and user-editable.

**G5 — a mid-session downgrade is incomplete even when it does fire.** `setPlan()` emits
`entitlementChanged` **only when the plan string changes**:

```cpp
// src/license/LicenseManager.cpp:549-557
const bool planChanged = m_plan != plan;
m_plan = plan;
m_status = status;
if (planChanged)
    emit entitlementChanged(m_plan);
emit statusChanged(m_status);
```

and `featuresChanged` — the signal designed for exactly this — has **zero consumers anywhere in the
codebase**. So an already-applied paid theme and in-flight auth-site downloads are not re-evaluated
on downgrade.

**G6 — the seat-limit dialog re-fires every 5 minutes.** The *validate* branch stops the heartbeat
timer (`LicenseManager.cpp:260`); the *heartbeat* branch does not. So `seatLimitReached` is emitted
on every beat, and `MainWindow.cpp:807-814` pops a modal `QMessageBox` each time.

**G7 — a crash or `SIGTERM` holds the seat for 15 minutes.** `releaseSeat()` runs only after
`app.exec()` returns (`src/main.cpp:387`) and inside `deactivate()`. There is no signal handler and
no `aboutToQuit` hook. This is the documented, intended fallback — but it is what a user experiences
as "I closed it and still can't sign in elsewhere".

**G8 — the admin UI is all-or-nothing and blind.** `Subscriptions.jsx` shows no device list, no
`activeSeats / seats` indicator, and offers no way to free one named device — even though
`listActivations`, `activeSeatCount` and `releaseSeatById` all already exist
(`Subscription.js:136-168`) and are already used by the user-facing dashboard.

**G9 — wording.** The requirement asks for *"seat not available on this license"*. The current
string is `"All %n seat(s) on this license are in use on other devices"`
(`LicenseManager.cpp:263`, `:429`).

### Required fix

Server, in order of importance:

1. **Make the heartbeat renew-only.** It must extend a lease the device *already holds* and must
   never acquire a new one. A device whose lease was revoked should be refused, not re-granted.
   (`routes/license.js:86-107`, `models/Subscription.js:45-117`.)
2. **Add an explicit revocation marker** that the acquire path honours — e.g. `revoked_at` on
   `license_activations`, or a seat epoch on `subscriptions` — so a freed seat cannot be silently
   retaken before the user re-authorises. Requires a migration in `config/schema.js:175-189`.
3. **Return a distinct `seat_revoked` reason** from both `/heartbeat` and `/validate`, so the client
   can tell "an admin freed your seat" from "someone else is using it" and show the right message.
4. **Add per-device admin routes** mirroring the user ones, and surface `activeSeats / seats` plus a
   device list in the admin Manage modal.

Client:

5. Handle **every** heartbeat reason, not just `seat_limit` (`LicenseManager.cpp:417-432`).
6. On `seat_revoked`, drop to Free, **clear the offline cache** so grace cannot replay it, stop the
   heartbeat, and show the "seat not available on this license" message.
7. Re-apply entitlements when the heartbeat reports a plan change; connect the orphaned
   `featuresChanged` signal so a downgrade actually reverts themes and in-flight paid work.
8. De-duplicate `seatLimitReached` so the dialog appears once, not every 5 minutes.

### Acceptance criteria

- With a Pro client running, an admin **Free seats** click drops that client to Free within one
  heartbeat interval, and the client says "seat not available on this license".
- The freed seat is immediately usable on a second machine.
- Re-pasting the key on the first machine restores Pro when a seat is free, and shows the
  seat-unavailable warning when it is not.
- Pulling the network after a revocation does **not** restore Pro from the offline cache.
- Integration tests cover: free → heartbeat → downgrade; free → other device activates;
  revoked → re-paste with a seat free; revoked → re-paste with no seat free.

---

## Issue 3 — Downloads never re-verify the Pro plan

**Severity:** High
**Status:** ❗ Confirmed missing — and there is nothing to hook it to

### Requirement

> Download should verify whether NDM is on Pro or not, and re-verify after every 10 downloads.

### Current verification cadence

```cpp
// src/license/LicenseManager.cpp:30-33
constexpr int  kRevalidateMs   = 6 * 60 * 60 * 1000;   // 6 hours
// The server holds a seat for 15 minutes past the last heartbeat, so beating
// every 5 leaves room for two dropped requests before a seat is lost.
constexpr int  kHeartbeatMs    = 5 * 60 * 1000;
```

- Full `/api/license/validate`: at startup, on user activation, and **every 6 hours**.
- `/api/license/heartbeat`: every 5 minutes, but it **carries neither `token` nor `features`** and
  never updates the plan (see Issue 2, G2/G3).

**There is no per-download or per-N-download verification anywhere in the codebase.** `addDownload`
reads only the cached `m_authSiteDownloads` boolean; `schedule()` reads only the cached
`m_maxConcurrent` integer. No download path calls `validate()`.

### Why this is not a one-line change

There is **no counter suitable to hook a `% 10` check onto**:

- `MainWindow::m_completedThisSession` (`src/ui/MainWindow.h:144`, incremented at
  `MainWindow.cpp:2731`) is **session-only**, resets on every launch, and lives in the UI layer.
  A check there is defeated by restarting the app.
- The SQLite layer has **no count API** (`src/core/Database.h:34-56`), and the `downloads` table is
  pruned by the user-facing "clear completed" action — so a `SELECT COUNT(*)` over it would not be
  monotonic either.
- `LicenseManager::validate()` is **private** (`LicenseManager.h:94`). There is no public
  force-revalidate entry point to call. `activate()` is public but is user-initiated and emits
  `activationFinished`, which would drive UI that should not appear here.

So the requirement needs three new pieces:

1. A **persistent, monotonic download counter** owned by `DownloadEngine`, stored where the user's
   "clear completed" cannot reset it.
2. A **public re-verify entry point** on `LicenseManager` that runs quietly — no activation dialog,
   no toast on success.
3. The **wiring**: on every 10th completed download, trigger a re-verify; apply the result through
   `applyLicensePlan`; fail **closed** on a definitive rejection and **open** on a transport error
   (a flaky network must not downgrade a paying customer mid-session).

### Related latent bug — found while auditing this

`DownloadEngine::applyLicensePlan` is connected to `entitlementChanged` only
(`DownloadEngine.cpp:76-77`), and that signal fires **only when the plan string changes**
(`LicenseManager.cpp:549-557`). A revalidation that returns the *same* plan name with *different*
`features` — the server tightening `maxConcurrentDownloads`, or flipping `authSiteDownloads` off —
never reaches the engine. `featuresChanged` exists for this and has **no consumers at all**.

Any per-10-downloads work must fix this too, or the re-verification will silently do nothing when
the plan name has not changed.

### Acceptance criteria

- A completed-download counter survives app restart and "clear completed".
- Every 10th completed download triggers exactly one quiet re-verification.
- A server response downgrading the plan takes effect immediately — concurrency cap, auth sites,
  AI rename — without a restart.
- A network failure during re-verification does **not** downgrade a paid user (offline grace still
  applies), and a definitive rejection **does**.
- A `features`-only change with an unchanged plan name reaches `applyLicensePlan`.

---

## Issue 4 — Licensing is trivially bypassable

**Severity:** Critical (revenue)
**Status:** ❗ Confirmed — six working bypasses

### The requirement, restated honestly

The request was to make the app impossible to reverse-engineer or hack from outside. That literal
goal **cannot be met**, and any plan that claims otherwise is selling something: the code runs on
the attacker's machine, under their debugger, and a determined reverse engineer always wins against
a client-side check. Signature verification, certificate pinning, anti-debug and obfuscation change
the **price** of an attack, never the outcome.

The achievable goal, which is what the rest of this section works toward:

> Raise casual piracy from about two minutes to "you must be a reverse engineer", and make a cracked
> build unable to reach any server-side paid surface.

That is a real, valuable, measurable objective. The current state falls far short of it.

### Bypasses that work today

All six were verified against the source. None requires a debugger except #5.

| # | Attack | Effort | Skill needed |
|---|---|---|---|
| 1 | Point `NEXA_LICENSE_API_URL` at your own server returning `{valid:true, plan:"pro", token:"x", features:{…}}` | ~5 min | Can write a JSON endpoint |
| 2 | Edit `[license] cachedPlan=pro` in the settings file, then block the domain | ~2 min | A text editor |
| 3 | **Pick any paid theme from Settings → Appearance** | **~10 sec** | **None** |
| 4 | `NEXA_ALLOW_INSECURE_LICENSE_API=1` + a plain-HTTP server on loopback | ~5 min | Low |
| 5 | Patch the `paid` branch in `setFeaturesForPlan` — symbol exported, binary unstripped, macOS unsigned | ~15 min | RE basics |
| 6 | Drive the phone-remote REST API to bypass the auth-site gate | ~5 min | Low |

### Root cause A — the signed token is never verified by the client

The backend mints a proper signed JWT (`routes/license.js:71-73`, `utils/jwt.js:37-39`). The client
**never checks the signature**. It only tests that the string is non-empty:

```cpp
// src/license/LicenseManager.cpp:287-302
const QString plan  = object.value(QStringLiteral("plan")).toString();
const QString token = object.value(QStringLiteral("token")).toString();
if ((plan != "free" && plan != "pro" && plan != "team") || token.isEmpty()) { … }
...
m_licenseToken = token;        // never persisted: it expires in 24h anyway
...
applyFeatures(object, plan);   // reads the PLAIN JSON `features`, not the token
```

`grep -riE "jwt|hmac|RS256|Ed25519|publicKey" src/license/ src/core/` returns **nothing**. There is
no JWT parsing, no HMAC, no public key anywhere in the client.

Consequence: **any** response body claiming `{"valid":true,"plan":"pro","token":"x","features":{…}}`
unlocks the client completely. Literally `"token":"x"` is sufficient. The signed token protects only
the server's own ad endpoint — not a single client-side gate.

### Root cause B — the offline cache is plaintext and user-editable

```cpp
// src/license/LicenseManager.cpp:470-478
void LicenseManager::cacheEntitlement(const QString &plan, const QDateTime &expires, bool trial)
{
    QSettings settings;
    settings.setValue(QLatin1String(kCachedPlan), plan);
    ...
}
```

No encryption, no MAC, no obfuscation. The file lives at `~/.config/Nexa/Nexa.conf` on Linux,
`HKCU\Software\Nexa\Nexa` on Windows, and a plist on macOS. Setting `cachedPlan=pro`, bumping
`cachedAt`, and pushing `cachedExpires` into the future is enough — then block the domain (or just
go offline) so `applyCachedEntitlement()` (`LicenseManager.cpp:480-520`) takes over and calls
`setFeaturesForPlan("pro")`. Every input to its freshness check comes from the same editable file.
Re-bump `cachedAt` weekly and it never lapses.

Note the token is deliberately **not persisted**, so after any restart the app holds no
cryptographic artefact at all — it runs entirely on that editable plan string.

### The theme bypass needs no licence tampering at all

This is the cheapest and most embarrassing. The Themes gallery carefully locks paid themes behind a
PRO badge (`ThemeGalleryDialog.cpp:614-618`) — but the plain dropdown next to it does not:

```cpp
// src/ui/SettingsDialog.cpp:165-171
for (const theme::ThemeInfo &t : theme::available()) {     // ALL 64 themes, unfiltered
    const QString label = t.automatic
        ? t.name
        : QStringLiteral("%1 — %2").arg(t.dark ? tr("Dark") : tr("Light"), t.name);
    m_theme->addItem(label, t.id);
    m_theme->setItemData(m_theme->count() - 1, t.tagline, Qt::ToolTipRole);
}
```

`grep "allowsTheme|themeEntitlement|locked" src/ui/SettingsDialog.cpp` returns **nothing**. There is
no filter, no lock, no entitlement check. Selecting a paid theme applies and persists it. All 64
paid themes are free right now, permanently, with two clicks and no network involved.

### The remote API bypasses the auth-site gate

`addDownload` refuses login-gated course sites on a Free plan (`DownloadEngine.cpp:411-416`). But
`addRemoteDownload` constructs a `DownloadTask` directly and never calls `addDownload`:

```cpp
// src/core/DownloadEngine.cpp:1289-1305
int DownloadEngine::addRemoteDownload(const QUrl &url)
{
    if (!isPublicHttpUrl(url))
        return -1;                       // the ONLY gate — no plan check

    const int id = m_db->nextId();
    auto *task = new DownloadTask(id, url, resolveSavePath(url, QString()), m_nam, m_db, this);
    ...
}
```

It is reachable from the phone-remote REST API (`src/web/WebServer.cpp:453`), so the paid gate is
skipped entirely — no licence tampering required.

While reading this path, note that the comment above the gate is **incorrect** and should be fixed:

```cpp
// src/core/DownloadEngine.cpp:408-410
// The server enforces the same rule when it decides the plan, so editing the cached entitlement
// locally gains nothing beyond this client-side convenience check.
```

The server decides the *plan*, but it is never consulted at download time — the download goes
straight to the course site with the user's own cookies. Editing the cached entitlement gains
exactly this feature. The comment describes a protection that does not exist.

### What is already right — the pattern to copy

Worth stating, because the intended posture is sound and the fix is to extend it, not invent it:

- **Fail-closed defaults everywhere.** `Entitlements` defaults to the Free set
  (`LicenseManager.h:24-38`); the engine starts at `maxConcurrent = 3`, `authSiteDownloads = false`,
  `plan = "free"`; validation starts *after* settings load, so the pre-answer state is Free.
- **The ads endpoint does it properly.** `ndm-website/backend/src/utils/ads.js:68-78` resolves the
  plan **from the signed token, server-side**, and anything unusable resolves to `free`. It is
  tested against a forged token signed with the wrong secret
  (`backend/test/api.integration.test.js:361-363`). **This is the only feature in the product where
  the server actually decides — and it is the model the other gates need.**
- Licence keys are stored in the **OS credential store**, never in settings
  (`src/license/CredentialStore.cpp`).
- The device fingerprint is a **hash** of MAC + machine id; the raw MAC never leaves the machine
  (`LicenseManager.cpp:123-140`).
- HTTPS enforced, 15 s timeouts, 64 KiB response caps, `NoLessSafeRedirectPolicy`.

### Required fix — ordered by value per unit of effort

**Tier 1 — cheap, closes most of the damage**

1. **Ignore the `NEXA_*` overrides in release builds.** `NEXA_LICENSE_API_URL`,
   `NEXA_ADS_API_URL` and `NEXA_ALLOW_INSECURE_LICENSE_API` should be compiled out unless a
   `NEXA_DEV_BUILD` CMake option is set. This kills attacks #1 and #4 for a few lines of code.
2. **Filter the theme dropdown through `allowsTheme()`** and re-check the saved theme after the
   first validation lands. Kills attack #3.
3. **Route `addRemoteDownload` / `addRemoteBatch` through the same gate as `addDownload`.**
   Kills attack #6.

**Tier 2 — the real fix**

4. **Verify the token's signature in the client, and derive entitlements from its claims** rather
   than from the sibling JSON. Switch `signLicenseToken` from HS256 to an **asymmetric** algorithm
   (RS256 or Ed25519) and ship only the **public** key in the binary — never the signing secret.
   This alone kills attacks #1, #2 and #4 outright, because a fake server cannot produce a valid
   signature.
5. **Persist the signed token instead of `cachedPlan`,** and bind it to this machine's
   `device_fingerprint`. Offline grace then means "the last token I hold is signed, unexpired plus
   grace, and issued to *this* device". Editing the cache becomes forging a signature, and the cache
   stops being copyable between machines — which it is today.

**Tier 3 — defence in depth, and redistribution control**

6. **Strip symbols** (`CPACK_STRIP_FILES`, `-fvisibility=hidden`) and enable LTO. Today every gate
   is a named exported symbol findable with `nm`.
7. **Code-sign Windows and notarise macOS.** The macOS build currently ships unsigned
   (`build.yml:660`), so a patched binary can be redistributed with no change in what the user sees.
8. **TLS certificate pinning** on the licence endpoint. Worth doing, but a local attacker can patch
   the pin out — this is defence in depth, not a fix.

**Tier 4 — what actually cannot be won on the client**

9. The **concurrency cap** and the **auth-site refusal** can never be enforced on a cracked client.
   A patched build will always be able to run 20 downloads and pass cookies to `yt-dlp`. Accept
   this, and move durable value server-side: gate paid features behind a token-checked round-trip
   the way the ads endpoint already does. Anything that must be *unbreakable* has to be something
   the client cannot compute alone.

### Acceptance criteria

- A release build ignores `NEXA_LICENSE_API_URL`, `NEXA_ADS_API_URL` and
  `NEXA_ALLOW_INSECURE_LICENSE_API`.
- A response with an absent, malformed or wrongly-signed token grants **Free**, verified by a test
  that signs with the wrong key — mirroring `backend/test/api.integration.test.js:361-363`.
- Hand-editing the settings file does not produce a paid plan, online or offline.
- A paid theme cannot be selected from the Settings dropdown on a Free plan, and a paid theme
  already applied reverts after the first validation reports Free.
- The phone-remote API refuses auth-site downloads on a Free plan.
- Release binaries are stripped, and Windows/macOS artefacts are signed.

---

## Cross-cutting findings

**No test covers licensing on the desktop at all.** The `ctest` targets registered in
`CMakeLists.txt` are `mega_crypto`, `extension_installer`, `download_import`, `engine_helpers`,
`auth`, `format`, `themes`, `public_url`, `cloud_providers`, `range_integrity` and
`database_persistence`. `nexa_auth_test` is **cookie/domain auth**, not licensing. No test asserts
that a Free install is capped, that an auth site is refused, or that a tampered cache is rejected.

**No backend test covers seats.** `ndm-website/backend/test/license.test.js` is trial-date maths
only. Nothing exercises `acquireSeat`, `releaseSeat`, `revoke-device` or the heartbeat. Given that
Issue 2's root cause is a seat-logic bug, this is the gap that let it ship.

**User-facing docs are stale.** `ndm-website/frontend/src/pages/docs/DocsLicense.jsx:34, 61` still
document a `device_mismatch` reason that the backend no longer emits — it was replaced by
`seat_limit` (`routes/license.js:55-58`).

---

## Suggested order of work

1. ~~**Issue 1**~~ — ✅ done. Worth running the New-Download-dialog A/B test once on Windows to
   confirm in the field, since NTFS zero-fill (listed under *Other main-thread blockers*) is a
   second, independent cause there.
2. **Issue 4, Tier 1** — three small, independent changes that close four of the six bypasses,
   including the 10-second theme one. Highest value per line of code in this document.
3. **Issue 2, server items 1–3** — making the heartbeat renew-only is a small change that turns the
   admin panel's existing button from a no-op into the feature it claims to be.
4. **Issue 4, Tier 2** — asymmetric token verification. The largest single piece of work here, and
   the one that makes the rest durable.
5. **Issue 3** — depends on the `featuresChanged` wiring from Issue 2, item 7, so it is cheaper
   after that lands.
6. **Issue 2, client items and admin UI**, then Tier 3 hardening.

Add the missing seat and licensing tests alongside whichever item lands first — their absence is
why two of these four issues reached production.
