# Nexa Download Manager — Website Audit

Full-surface review of the website: Express/MySQL backend, React site, and the
admin + root control panels. Every finding below was reached by reading the code
and, where possible, confirmed against the live deployment or a test run. The
evidence for each one is recorded so nothing has to be re-derived later.

- **Audit started:** 2026-09-19 on `windows-fixes-v3` @ `40980ed`
- **Rebased onto `main`:** 2026-09-22 — see *Reconciliation with `main`* below
- **Branch:** `audit-on-main`, branched from `main` @ `867341e`
- **Scope:** `ndm-website/backend`, `ndm-website/frontend`, `ndm-website/admin`
- **Live target:** https://nexadownloadmanager.com (NODE_ENV=production, billing `disabled`)
- **Deployed:** this base went live 2026-09-22 15:22 UTC (see *The deploy*). Phases 1–4 of the *original* branch had gone live 2026-09-20 14:26 UTC.

---

## ⚠ Temporary loosenings — PUT THESE BACK

**Both guards** on the control panels are **deliberately off** on the live
deployment, at the owner's request. Neither is a finding and neither is a
mistake; they are a decision with an expiry date that nothing else will
enforce. This is the one part of this file meant to be read by someone who
reads nothing else.

| Setting | Live value | What it should be | Off since |
|---|---|---|---|
| `ADMIN_ALLOWED_IPS` | `*` | the operator's address or ISP range | 2026-09-21 |
| `ADMIN_2FA_REQUIRED` | `false` | unset (defaults to on) | 2026-09-23 |

**Why 2FA went off twice.** It was turned off on 2026-09-21, put back on
2026-09-22, and turned off again on 2026-09-23. That is not indecision. The
2026-09-22 recovery (M-14) cleared the creator's enrolment to get them back
into a panel they were locked out of, and `requireTwoFactorEnrolled` then did
exactly what it is built to do: locked every screen but Security until they
enrolled again. On a deployment being worked on daily that wall is in the way
every session, so the requirement came off rather than the gate being weakened
in code — a config line that can be deleted is a much better place for this
than a permanent hole in `adminAuth.js` that every other deployment inherits.

**What this costs while both are off.** The staff and creator panels accept a
sign-in from any address on the internet, and a never-enrolled account is not
made to add a second factor. Together that means **a leaked panel password is
enough, on its own, from anywhere** — and that panel reads customer emails,
licence keys and subscription records. The API prints this on every boot.

**The cheapest way to make this much less serious** is not to put 2FA back —
it is to close the IP gate, which costs nothing day to day. `/root` →
**Security** → *Who can reach the panels*, add the ISP range, disable the `*`
row. An attacker would then need the password **and** to be inside that range.
The panel refuses any change that would lock out the address making it
(`WOULD_LOCK_YOU_OUT`), so this cannot go wrong the way the old `.env` edit
could — and `.env` stays the break-glass route, since the effective list is
the union of it and the enabled panel rows.

**Why `*` and not an empty list.** `config/env.js` refuses to start a hardened
deployment on an empty `ADMIN_ALLOWED_IPS`, and that refusal is worth keeping:
an unset variable is nearly always an oversight. `*` is a sentence somebody had
to write, so it can be allowed and then **warned about on every single boot** —
which is a reminder that reaches whoever restarts the process, months from now,
instead of one that lives in a file nobody opens.

**Putting 2FA back** — delete the `ADMIN_2FA_REQUIRED=false` line from
`nexa-api/.env` and restart the API; it defaults to on for a hardened
deployment. Nothing needs redeploying. It is safe to do now in a way it was
not before: recovery codes can be regenerated from the Security page (M-15),
and `npm run reset-2fa` is the way back if the authenticator is lost (M-14).
Both of those are why this is a reversible decision rather than a trap.

## How to use this file

Work top-down by phase. When a phase is finished **and verified by a test or a
live check**, update the `Status` on each of its findings and tick the phase in
the plan. Do not mark anything done on the strength of the edit alone — the
point of the `Verified by` field is that something other than an opinion says
it works.

| Status | Meaning |
|---|---|
| `OPEN` | Confirmed, not started |
| `IN PROGRESS` | Being worked |
| `FIXED` | Code changed **and** verified — say how in `Verified by` |
| `WONTFIX` | Deliberate; reason recorded |

---

## Reconciliation with `main`

The audit ran on `windows-fixes-v3`, which is the lineage production is running.
`main` had moved 63 commits ahead in the meantime — feature pages, FAQ votes,
sign-in lockout, security events, durable rate limits, desktop-app sign-in,
device tokens, licence-sharing detection — and none of it was live. Two
divergent trees, one of them deployed, is not a state to add a sixth phase to.

So `main` became the base and the audit's work was ported onto it, one finding
per commit, each verified against a real database before the next began. That
direction was chosen because `main`'s 63 commits are *features with tests*,
while the audit's are *fixes to code both trees share* — the fixes port cleanly,
the features would not have.

Three things came out of doing it that way, and they are the reason it was worth
the effort rather than merging and resolving conflicts:

**`main` had independently fixed seven findings**, usually differently and
sometimes better. H-05 (ban at sign-in), M-02 (single-use reset links, via
`token_version` rather than a password-hash prefix), M-13 (zod on every `:id`),
L-06 (a real password policy with a breach check), most of H-04 (both Stripe
invoice event names, portal sync, refunds, idempotency), the customer half of
H-08, and the `/dev/fd` half of O-01's backup script. Those were left alone.

**Two findings the audit called FIXED were only half-fixed on this base.** H-08
bound customer bearers to the account's token generation but never checked it in
the two panel gates, so revoking a staff admin's — or the creator's — sessions
left the bearer in their open tab working for its full 8h (4h for root). H-04
handled every Stripe event except `customer.subscription.created`, the only
announcement a subscription started in Stripe's dashboard ever makes. Both are
fixed here, each with a test that fails without the fix.

**One new finding, found by running the suite twice.** `srv.reset()` never
truncated `faq_votes` or `license_token_rejections`, so those suites passed on a
virgin database and failed on the second run. That had been invisible for as
long as the integration tests were skipping themselves — which is O-03, and the
best argument in this file for why it mattered.

Where the two trees disagreed and both were defensible, `main`'s choice was
kept: its `token_version` generation counter over the branch's `sid` session
binding, its `exposeStackTraces` gate over `isProd`, its `.gitattributes` CSP
and deploy pins, its backup script, its far more developed `deploy/` and
`license.js`. Where the audit's was stronger it replaced `main`'s: an allow-list
projection over a pattern deny-list, one subscription per account over
create-and-retire.

---

## Scoreboard

Against this base, after the port:

| Severity | Count | Open | Fixed |
|---|---|---|---|
| High | 8 | 0 | 8 |
| Medium | 15 | 0 | 15 |
| Low | 12 | 1 | 11 |
| Test debt | 8 | 3 | 5 |
| Operational | 3 | 2 | 1 |
| **Total** | **46** | **6** | **40** |

**Every defect found by reading the code is fixed.** The six left are of two
kinds, and neither is a bug sitting in a code path:

- **O-01, O-02** — hPanel cron entries, which have to be added in
  Hostinger's control panel by the account owner and cannot be done over SSH.
- **L-11, T-06, T-07, T-08** — found by the verification pass on 2026-09-23
  (see *Verification pass* below). L-11 is an edge-config oddity that fails
  closed; the three T-* are missing tests, not broken behaviour.

Test baseline on this base (MariaDB 11.8.9 — production's engine — on
`127.0.0.1:3399`):

| Stage | Result |
|---|---|
| `main` @ `867341e`, untouched | **502 pass / 0 fail / 0 skipped** on a fresh database; **4 fail** on the second run (the `faq_votes` leak) |
| After the port | **532 pass / 0 fail / 0 skipped**, repeatable |
| Today | **backend 570**, **frontend 61**, 0 fail / 0 skipped, repeatable, and green on CI |

Every integration suite runs — nothing skips — which is the whole point of
O-03. The count is the tripwire `.github/workflows/website.yml` enforces on
every branch.

---

# HIGH

## H-01 — `GET /api/admin/users/:id/details` hands a staff admin the creator's credential material

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/userView.test.js` (7 new tests) + full suite 188 pass / 0 new failures

**On this base (`audit-on-main`):** ported in `4b64690`. `main` had reached the pattern-based `stripSensitive()` on its own, which still let `google_id` and the lockout columns out; `utils/userView.js` replaces it, and the admin users LIST is projected too (it was not). `test/userView.test.js` (8 tests) and the hardening suite's leak case both cover it.

**Fixed by:** one allow-list projection, `backend/src/utils/userView.js`, replacing
all three drifting deny-lists. `PUBLIC_FIELDS` is `id, name, email, role,
email_verified, banned, avatar_url, trial_used, totp_enabled, created_at,
updated_at` — chosen by grepping `admin/src` and `frontend/src` for every user
field the UIs actually read — plus the derived `hasPassword` / `hasGoogle`
booleans. It names no `*_hash`, no `totp_secret`, no `totp_recovery`, no
`google_id`, and a column added to the table later is private by default (a test
pins that). `safeUser` and `sanitizeUser` are gone from `admin.js`, `root.js` and
`user.js`; `grep -rn "safeUser\|sanitizeUser" src test` returns nothing.

`blockedStaffTarget(req, res, user, verb = 'modify')` now takes a verb and is
applied to `GET /users/:id/details`, so a staff admin reading a control-panel
account gets `403 "Only the creator can view a control-panel account"` unless
`req.isRoot`. The admin SPA surfaces that through its existing error banner
(`admin/src/pages/Users.jsx:74-76`).

**Where:** `backend/src/routes/admin.js:73` (`safeUser`), `backend/src/routes/admin.js:320` (the route)

`safeUser()` strips exactly three columns:

```js
const { password_hash, refresh_token_hash, admin_refresh_token_hash, ...safe } = user;
```

but `User.findById()` is `SELECT * FROM users`. So everything else on the row is
returned, including **`root_refresh_token_hash`**, **`totp_secret`** and
**`totp_recovery`**.

The route has no `blockedStaffTarget()` guard — that helper is applied to
`PUT /users/:id`, `/reset-password` and `/revoke-sessions`, but not to reading a
user. A staff admin can therefore request the creator's row and read the
creator's live root-session hash and complete 2FA material.

**How it fails:** staff admin → `GET /api/admin/users/<root id>/details` →
`totp_recovery` (a JSON array of SHA-256 hashes) → offline cracking (see H-02) →
sign in at `/root` as the creator with a recovery code, bypassing 2FA entirely.

**Same leak, other routes:** `POST /api/admin/users` (201 body) and
`PUT /api/admin/users/:id` both return `safeUser(User.findById(...))`.
`backend/src/routes/root.js:56` has its own `safeUser` which does strip
`root_refresh_token_hash` but still leaks `totp_secret` and `totp_recovery`.

**Fix:** replace both `safeUser` implementations with an explicit **allow-list**
of columns that may leave the server, rather than a deny-list that has to be
kept in step with the schema. Add `blockedStaffTarget()` to
`/users/:id/details`.

---

## H-02 — 2FA recovery codes are weakly generated and weakly hashed

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/totp.test.js` (extended, +13 tests) + full suite 188 pass / 0 new failures

**On this base (`audit-on-main`):** ported in `4839060`, adapted to `main`'s `matchTotp` naming, its `CODE_ALREADY_USED` reply and its customer 2FA realm (`subject`/`issuer`/`onEvent`), none of which the branch had. M-03's conditional spends came with it. 30 tests in `totp.test.js`.

**Fixed by:** codes are now ten uniform `crypto.randomInt` picks from an explicit
`[a-z0-9]` alphabet — the full 51.7 bits the shape can carry, with no
case-folding to throw entropy away — and stored as **bcrypt** hashes (cost 10).
`consumeRecoveryCode` refuses anything that is not code-shaped before paying a
single compare, and stops at the first match rather than always paying eight.

Two things the adversarial round-1 review caught and the repair pass fixed:

- The first cut guarded bcrypt entries with `startsWith('$2')`, which lets a
  60-character entry with a bad revision or salt through to `bcrypt.compare`,
  where bcryptjs *throws* rather than returning false — one corrupted row would
  have failed the whole login. Now a full `BCRYPT_HASH` regex plus a `try/catch`,
  so a bad entry fails itself and the valid entries after it still get their turn.
- Legacy SHA-256 rows would have been accepted forever, leaving every admin who
  enrolled since 2FA shipped (`7d5f382`, 2026-08-31) on exactly the crackable
  hashes this finding is about. They are now **retired on the account's next
  authenticator sign-in** — the one moment that proves the phone still exists, so
  nobody is locked out — with an audit row, and `GET /<realm>/2fa` reports
  `recoveryCodesLegacy` so the panel can prompt. A new
  `POST /<realm>/2fa/recovery-codes` (same proof as disabling 2FA: password + a
  current code) issues a fresh set.

Two follow-ups this opened, tracked separately: **M-14** (the creator cannot
recover from a lost authenticator) and **M-15** (the panel does not yet surface
any of the new migration state).

**Where:** `backend/src/utils/totp.js:131` (`hashRecoveryCode`), `backend/src/utils/totp.js:140` (`generateRecoveryCodes`)

```js
const raw = crypto.randomBytes(8).toString('base64url').toLowerCase()
  .replace(/[^a-z0-9]/g, '').slice(0, 10).padEnd(10, '0');
```

`.toLowerCase()` on base64url collapses `A-Z` onto `a-z`, which throws away a
large part of the 64 bits that went in — the result is roughly 50 bits, not 64.
The hash is then a bare, unsalted, single-round SHA-256:

```js
crypto.createHash('sha256').update(normalized).digest('hex')
```

Unsalted SHA-256 over a ~50-bit space is within reach of commodity GPU cracking.
The TOTP secret next to it is properly encrypted (AES-256-GCM), so the recovery
codes are the weakest link in the panel's second factor.

**Fix:** generate the codes from an explicit alphabet instead of case-folding
base64 (keeps the full entropy), and store them with a slow, salted KDF — bcrypt
is already a dependency and is used for passwords.

---

## H-03 — Banning a user does not stop their desktop app

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/licenseBan.integration.test.js` (12 tests against the real endpoints) + full suite

**On this base (`audit-on-main`):** ported in `98d1d1d`, woven into `main`'s much larger `resolveSubscription` (device tokens, sharing assessment, lazy lapse) rather than replacing it. `main` already signed a banned account out of the DEVICE-TOKEN path; the licence-key path was untouched. Checked as a tripwire: with the owner check commented out, 6 of the suite's 14 fail.

**Fixed by:** `Subscription.findByLicenseKeyForValidation()` joins the owner's
`banned` flag onto the lookup `/validate` and `/heartbeat` were already doing
(no extra query on the desktop app's hot path), and `resolveSubscription()`
answers `reason: 'banned'` before status or expiry are even looked at.
`/release` deliberately still skips the check — handing a seat back is
housekeeping, not a privilege, and refusing it would only pin the banned
user's seat for the rest of its lease.

The part the first cut missed, caught by the adversarial review: a **Team**
licence is one key shared by the whole roster, and the request carries only
that key and a device fingerprint — so when a *member* is banned the server
cannot tell their machine from a colleague's. The only thing that can be taken
from someone who already holds a shared secret is the secret. So the first
`/validate` or `/heartbeat` to see a banned member on the roster drops the
banned members, **rotates the licence key**, and revokes every seat
(`Subscription.revokeBannedMembers`, one transaction, runs once). Everyone
still entitled re-copies the key from their dashboard; the banned member,
who can no longer sign in, cannot. CONTRACT.md documents the new reason and
the rotation.

**Where:** `backend/src/routes/license.js` (`resolveSubscription`), `backend/src/routes/admin.js` (`PUT /users/:id`)

`resolveSubscription()` reads the `subscriptions` row and checks `status` and
`expiry_date`. It never joins `users` and never looks at `banned`. Banning from
the admin panel sets `users.banned`, deletes the site sessions, and leaves the
subscription untouched.

**Result:** a banned account is locked out of the website but
`POST /api/license/validate` keeps returning `valid: true` with full Pro
entitlements and a freshly signed licence token, indefinitely. The same is true
of `/license/heartbeat`. Banning is effectively website-only.

**Fix:** join `users` in `resolveSubscription` and return `invalid(res, 'banned', …)`,
or have the ban action mark the subscription. Whichever is chosen, the desktop
app must stop being handed a Pro token.

---

## H-04 — Subscription renewals are never recorded, so paying customers expire

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/webhookRenewal.integration.test.js` (14 tests through the real webhook route and `/license/validate`) + full suite

**On this base (`audit-on-main`):** `main` had already fixed the substance independently — both invoice event names, portal sync, `subscription.deleted`, refunds, `payment_failed`, all behind `stripe_webhook_events` idempotency. The one gap left was `customer.subscription.created`, the only announcement a subscription started in Stripe's dashboard ever makes; closed in `a2cead1` with a lifecycle case that fails without it.

**Fixed by:** two handlers in `routes/webhooks.js`, both idempotent and
order-independent (row found by `stripe_subscription_id`, then
`stripe_customer_id`, then the account's newest row):

- `invoice.paid` / `invoice.payment_succeeded` → `status='active'`,
  `expiry_date` = the invoice's latest line period end **+ 3 days**
  (`RENEWAL_GRACE_DAYS`: Stripe bills at the period end and reports the
  payment later — seconds, or days under card retries — and without headroom
  every customer would be refused in between, on every renewal), and a
  `payments` row keyed on the payment intent so the pair of events counts
  once. `billing_reason: 'subscription_create'` is left to the checkout
  handler, which owns the first invoice.
- `customer.subscription.created` / `.updated` → plan (from the subscription's
  own metadata, which checkout now sets via `subscription_data.metadata` —
  session metadata never travelled beyond the first event), status
  (`past_due` stays active while Stripe retries; `unpaid`/`canceled` cancel;
  `paused` expires; `incomplete` is not mirrored), and `current_period_end`.
  Seats follow the plan only when the plan changes, so admin-granted extra
  seats survive a card change.

Both Invoice shapes are read (`subscription`/`subscription_details` and the
2025-03-31+ `parent.subscription_details`), likewise `current_period_end` on
the Subscription or on its items. Found and fixed on the way:
`invoice.payment_failed` read `planFromObject(invoice)`, which throws because
an Invoice has no `metadata.plan` — every real failure event would have been a
500 that Stripe retried for days. An event for a subscription nobody here has,
or one that names no paid plan for a free row, is logged and acknowledged
rather than applied blind (a one-month expiry on a free row would read as
`expired` a month later).

**Where:** `backend/src/routes/webhooks.js:177-179`

The webhook handles exactly three event types:

```js
case 'checkout.session.completed':    …
case 'customer.subscription.deleted': …
case 'invoice.payment_failed':        …
```

`invoice.payment_succeeded` and `customer.subscription.updated` are **not**
handled. `expiry_date` is written once, at checkout, from
`planExpiry(plan, billingCycle)`.

**How it fails:** a monthly subscriber is charged again on day 30. Stripe sends
`invoice.payment_succeeded`; nothing consumes it; `expiry_date` still says day
30. From day 31 `resolveSubscription()` returns `expired` and the desktop app
refuses the licence — **while the card is still being charged every month**.
Plan changes made in Stripe's own billing portal are likewise never mirrored.

This is latent today only because billing is `disabled` in production. It is the
first thing that will break on the day Stripe goes live.

**Fix:** handle `invoice.payment_succeeded` (extend `expiry_date`, record the
payment) and `customer.subscription.updated` (mirror plan and status).

---

## H-05 — `POST /api/auth/login` never checks `banned`

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/authResetBan.integration.test.js` + full suite

**On this base (`audit-on-main`):** `main` fixed this independently, and after the password comparison for the same oracle reason. Nothing to port.

**Fixed by:** one `if (user.banned)` after the bcrypt comparison succeeds and
before `signAccessToken`/`openSession` — after, not before, so an anonymous
caller with a list of addresses cannot use sign-in as an oracle for which
accounts are banned. Same `403 FORBIDDEN` wording as `/auth/google`.
`clearLoginFailures` runs first: the password was correct, so there is no
attacker left for the per-account slowdown to punish.

**Where:** `backend/src/routes/auth.js:115-150`

Every other entry point checks it — `/auth/google`, `/auth/refresh`,
`requireAuth`, `/admin/login`, `/admin/refresh`, `/root/login`, `/root/refresh`.
Password sign-in does not.

A banned account gets `200`, a signed 7-day access token, and a new
`user_sessions` row. `requireAuth` then 403s every subsequent call, so the user
lands in a half-signed-in state rather than being turned away — and the ban is
not enforced where it is first tested.

**Fix:** one `if (user.banned)` check after the password comparison, matching
the wording already used in `/auth/google`.

---

## H-06 — The download-counter fix was written, tested, and never wired up

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/downloadCounter.integration.test.js` — the 3 failing leaves now pass, plus 5 new (HEAD on both paths, resume of an uploaded file, missing file → 404 and uncounted); 14/14. Confirmed live at the origin after the deploy: HEAD +0, resume +0, fresh start +1.

**On this base (`audit-on-main`):** ported in `14c8d1d`. `main` had fixed rule 1 inline on the uploaded path — including the app's `bytes=0-0` probe, which the branch's version missed, so that rule came across into `downloadCounter.js` — but the legacy redirect still counted everything, a HEAD looked like a fresh start on both paths, and a missing file counted every failed attempt. 15 tests.

**Live caveat:** through Hostinger's edge a `HEAD` still counts once — the CDN turns it into a `GET` at the origin to fill its cache, and nothing distinguishes that GET from a real one. The per-address window bounds it: a link-preview bot's HEAD is one download at most, and a person who downloads within ten minutes of it is not counted twice. The three test increments were removed from the live counter (672).

**Fixed by:** `routes/releases.js` asks `shouldCountDownload()` on both the
uploaded-file and the legacy-redirect path, through one `countsAsDownload()`
that first refuses a `HEAD` (Express routes HEAD to the GET handler, and a HEAD
has no `Range`, so it looked exactly like a fresh start). The 404 for a file
missing from disk is decided *before* the count (`releaseFiles.artifactOnDisk`),
and the increment lands before the first byte goes out, so a client reading
`/latest` the moment its transfer ends sees it. L-07 closes with this.

**Where:** `backend/src/utils/downloadCounter.js`, `backend/src/routes/releases.js:57`

`utils/downloadCounter.js` is a complete implementation of both WP-09 rules with
a documented rationale and an exported `shouldCountDownload()`. A grep across
`src/` and `test/` finds **no importer** — the only hits are its own definition
and export.

`routes/releases.js` re-implements rule 1 inline:

```js
const isFreshStart = !range || /^bytes=0-/.test(String(range).trim());
if (isFreshStart) await Release.incrementDownloadCount(release.id);
```

and omits rule 2 entirely (one address counts once per release **per platform**
per 10-minute window). So retries, cancel-and-restart, antivirus scanners and
link-preview fetchers each still count.

Two further inflations in the same block:

- A `HEAD` request has no `Range`, so it is treated as a fresh start and counted.
- The counter is incremented **before** `sendFile()` reports the artifact is
  missing, so a broken release counts every 404.

**Why nobody noticed:** `test/downloadCounter.integration.test.js` drives the
real route over HTTP and would fail — but it `t.skip()`s when no MySQL is
reachable, which is the case on every developer machine. See O-03.

**Fix:** import `shouldCountDownload` in `routes/releases.js` and use it for both
the uploaded-file and the legacy-redirect paths; move the increment after the
artifact is known good; skip `HEAD`.

**Empirical confirmation (2026-09-19):** at `40980ed` against a real database,
`downloadCounter.integration.test.js` fails 3 of 4 — `5 !== 0` (five resume
requests each counted), `12 !== 8` (five starts from one address counted five
times), `20 !== 16` (the audit's own scenario).

---

## H-07 — The release-version invariant was written, tested, and never wired up

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/releaseVersionInvariant.integration.test.js` — all four contract cases pass (5/5)

**On this base (`audit-on-main`):** ported in `03afe5d`. `utils/artifactVersion.js` was in no commit on `main` at all; it and its 9 unit tests came across with the upload route and the admin page's verdict line.

**Fixed by:** the upload route reads the version back from the stored file
(`artifactVersionFromFile`) right after `storeUpload()`. A definite mismatch
removes the file and answers `409 VERSION_MISMATCH` with
`{ artifactVersion, releaseVersion }` before the row is touched; a match
answers `artifactVersion` + `versionWarning: null`; an unreadable version is
accepted with a `versionWarning`, which also goes into the audit row's summary
("— version unchecked") and metadata. The admin Releases page now shows
"build X verified" or the warning instead of a flat "uploaded", so the
operator sees which of the two happened.

**Where:** `backend/src/utils/artifactVersion.js`, `backend/src/routes/admin.js` (`PUT /releases/:id/artifact/:os`), `backend/test/releaseVersionInvariant.integration.test.js`

The same pattern as H-06. `artifactVersion.js` reads the version an installer
declares about *itself* — the PE `VS_FIXEDFILEINFO` resource for a Windows
`.exe`, the `control` file for a `.deb` — and `versionsMatch()` compares it with
the release row. It documents the incident that motivated it (WP-03: `/download`
advertised 0.3.0 while serving `nexa_0.2.0_amd64.deb` with a perfectly matching
checksum). Its 9 unit tests pass.

A grep across `src/` finds **no importer**. Only the two test files reference
it. The upload route stores whatever arrives, hashes it, and never asks whether
the bytes belong to the release they were attached to — so the WP-03 incident
can recur today exactly as it did.

**Empirical confirmation (2026-09-19):** `releaseVersionInvariant.integration.test.js`
drives the real upload endpoint with a structurally real `.deb` and fails 3 of 4
at `40980ed`: a 0.2.0 build attached to the 0.3.0 release is accepted (`200 !==
409`), a matching build gets no `artifactVersion` in its response, and an
unreadable build gets no `versionWarning`.

**Contract the test pins:** `409 VERSION_MISMATCH` with
`details: { artifactVersion, releaseVersion }` and nothing stored on the row; a
match answers `200` with `artifactVersion` and `versionWarning: null`; a dpkg
revision (`0.5.0-1`) counts as `0.5.0`; an artifact whose version cannot be read
is accepted with `artifactVersion: null` and a `versionWarning`, never refused.

**Fix:** in the upload route, after `storeUpload()`, call
`artifactVersionFromFile(absPath, os)`; on a definite mismatch remove the stored
file and answer 409 before touching the row; otherwise carry
`artifactVersion` / `versionWarning` in the response and the audit entry.

---

## H-08 — "Revoke sessions" does not revoke access

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `passwordChangeSessions` (the `KNOWN GAP` tripwire flipped: the revoked browser's bearer is `401 SESSION_REVOKED` on all four routes, and so is the creator's root bearer), `api` admin-session (a signed-out admin bearer is refused at once), `jwt.test.js` (+3: `sid` carried, no session → throws, TTL ≤ 15 min), full suite

**On this base (`audit-on-main`):** `main` solves this with a `token_version` generation counter rather than the branch's `sid` session binding, and that design was kept — but only the CUSTOMER gate compared it. Both panel gates re-checked the role and the ban and stopped there, so revoking a staff admin's or the creator's sessions left the bearer in their open tab alive for its full 8h (4h for root). Closed in `a6fb9dd`; `test/panelSessions.integration.test.js` covers staff, creator and demotion, and 3 of its 4 fail without the check.

**Fixed by:** doing both halves the finding named, for all three realms at
once rather than the site alone.

- **One session table.** The staff and creator panels' sessions moved from
  the two single-slot columns into `user_sessions`, with a `realm` column
  (`site` / `admin` / `root`). `admin_refresh_token_hash` and
  `root_refresh_token_hash` are retired: not in `UPDATABLE_COLUMNS`, never
  read, left on the table because a boot-time migration should not drop a
  production column. One `UserSession.removeAllForUser(id)` now ends every
  kind of session an account has; a demotion ends only the `admin` ones.
- **The bearer is bound to its row.** `signAccessToken` / `signAdminToken` /
  `signRootToken` take the session and put its id in the token as `sid`, and
  *throw* without one — a token nothing can revoke is a bug, never a default.
  `requireAuth`, `requireAdmin` and `requireRoot` look the row up on every
  request (`UserSession.findLiveForToken`: same account, same realm, not
  expired — one primary-key read beside the `User.findById` already there)
  and answer `401 SESSION_REVOKED` when it is gone. Rotation on `/refresh`
  swaps the hash in place, so the id — and a second tab's older bearer —
  survives a refresh.
- **The TTL is minutes.** 7d / 8h / 4h → **15 min** for all three; the SPAs
  already refresh on a 401. The revocation is immediate regardless; the TTL
  bounds what a token proves on its own.

`POST /auth/change-password` now returns a `token` for the re-opened session
(the caller's old bearer named a row the change deleted) and Profile.jsx adopts
it. `createRoot.js` revokes through the table. **Deploy note:** panel cookies
issued before this point at the retired slots, so every admin signs in once
more after the deploy; site cookies are unaffected (the row is the same, only
the bearer is re-minted on the next refresh, which a 401 triggers).

**Where:** `backend/src/middleware/auth.js:13-25` (`requireAuth`), `backend/src/utils/jwt.js:15-17` (`signAccessToken`)

`requireAuth` verifies the access JWT's signature and re-reads the user row. It
never checks that the session the token was issued for still exists:

```js
const payload = verifyAccess(token);
const user = await User.findById(Number(payload.sub));
if (!user)       return fail(res, 'UNAUTHORIZED', …, 401);
if (user.banned) return fail(res, 'FORBIDDEN',    …, 403);
req.user = user;                       // ← no user_sessions lookup
```

Access tokens last **7 days** (`expiresIn: '7d'`). Deleting every
`user_sessions` row therefore only stops the holder minting a *new* access
token at `/auth/refresh`; the one they already hold keeps full access to the
account for up to a week.

Ten call sites believe otherwise. The ban paths survive by accident —
`requireAuth` re-reads `user.banned`, so H-05 and the admin ban are genuinely
enforced. Everything else is not:

| Call site | Claims | Actually |
|---|---|---|
| `auth.js:389` password reset | "signs the account out EVERYWHERE" | attacker keeps access ≤ 7 days |
| `admin.js:390` admin reset-password | — | same |
| `admin.js:403` admin revoke-sessions | answers `{ revoked: true, sessions: n }` | same |
| `root.js:238/250/268` | reset-password / revoke-sessions / reset-2fa | same |
| `user.js:167` profile password change | M-01's fix | same |
| `admin.js:351`, `root.js:221` ban | — | **works** (`requireAuth` re-reads `banned`) |

So the single most important thing an admin can do to a compromised
account — "revoke sessions" — is close to a no-op for a week, and it reports
success.

Found by the Phase 2 adversarial review of M-01: three independent reviewers
refused to accept that revoking session rows signs the other browser out. They
were right, and the problem is older and wider than that lane.

**Fix:** make revocation mean something. Either put a session id in the access
token and have `requireAuth` confirm a live `user_sessions` row for it (one
indexed lookup, next to the `User.findById` already on every request), or cut
the access-token TTL to minutes so `/auth/refresh` — which *does* check the
session — becomes the revocation point. The first revokes immediately; the
second bounds the damage. Doing both is the usual answer.

**Blocks M-01:** a profile password change cannot sign other browsers out until
this is fixed, whatever `PUT /user/profile` does.

---

# MEDIUM

## M-01 — Changing your password does not sign out your other sessions

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/passwordChangeSessions.integration.test.js` (11 tests, two independent cookie jars; with H-08 the other browser's bearer is now refused with the request in flight, not at its own expiry)

**On this base (`audit-on-main`):** `main` does this in `PUT /user/profile` rather than a separate `POST /auth/change-password`: it revokes every session, re-issues for the caller, and the profile page adopts the new token. Nothing to port.

**Where:** `backend/src/routes/user.js` (`PUT /profile`)

**Done:** the password change moved to **`POST /auth/change-password`**. It
revokes every `user_sessions` row and all three single-slot control-panel
cookies, then re-opens ONE session for the calling browser — only if it
presented a live `ndm_refresh` cookie of its own (`sessionKept: true`); a bare
bearer token is never upgraded into a session. `PUT /user/profile` is
name-only again.

Why it moved: the refresh cookie is scoped to `Path=/api/auth`, so on
`/api/user/profile` the browser never sends it — "keep the caller signed in"
was unreachable there, and the first cut had grown a duplicated copy of every
cookie helper trying. The route-level test only passed because the harness's
cookie jar ignores `Path`; two of the adversarial reviewers caught it. Under
`/api/auth` there is exactly one `openSession`, shared with `/auth/login`.

**Closed by H-08:** the other browser's *access token* dies with its session
row. The suite's `KNOWN GAP` tripwire flipped to the 401 it was waiting for,
and the route now hands the caller a bearer for its re-opened session.

`/api/auth/reset-password` correctly calls `UserSession.removeAllForUser(user.id)`
and comments that a reset signs you out everywhere. `PUT /api/user/profile`,
which is the other way to change a password, does not. Someone who suspects
their account is compromised and changes their password from the profile page
leaves the attacker's session alive for its full 30 days.

## M-02 — Password-reset tokens stay valid after use

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/jwt.test.js` (+5), `test/authResetBan.integration.test.js` + full suite

**On this base (`audit-on-main`):** `main` fixed this independently with the same `token_version` counter H-08 uses: completing a reset bumps it, which kills that link and every older one at once. Simpler than the branch's password-hash prefix, and it needs no conditional write. Nothing to port.

**Fixed by:** the token now carries `pv`, a 16-hex prefix of
`sha256(password_hash)`, and `resetTokenMatches(payload, user)` re-checks it
against the live row — no new column. The reset itself rewrites the hash, so
the link just spent (and every older reset email for the same account) stops
matching in the same instant. A Google-created account with no password yet
folds `null` to a stable value, so its first-password link still works.

The write is the guard, not the read: `resetTokenMatches` is ~300 ms stale by
the time bcrypt finishes, so the `UPDATE` is conditional on
`password_hash <=> ?` and a second request holding the same link loses the
race and is told the link is dead. Every refusal is the same `INVALID_TOKEN`.
Tokens minted before `pv` existed never match — deliberately; in-flight reset
emails across the deploy expire early and the user asks for a new one.

**Where:** `backend/src/utils/jwt.js` (`signResetToken`)

The token is `{ sub, typ: 'reset' }` with a 1-hour expiry and nothing else. It is
not bound to the current password hash and there is no one-time nonce, so the
same link works repeatedly for the whole hour — including after the password has
already been changed — and several outstanding reset emails are all valid at once.

**Fix:** bind the token to state that the reset itself changes (a hash of the
current `password_hash`, or a per-user token version column).

## M-03 — TOTP codes can be replayed inside their window

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/totp.test.js` (+12, including two-request races) + full suite

**On this base (`audit-on-main`):** `main` had the `totp_last_step` high-water mark but spent it with a read in JS and a plain UPDATE afterwards, which two requests carrying the same digits both pass — and a phishing relay submits its login beside the victim's by construction. The conditional spends (`spendTotpStep`, `swapRecoveryCodes`) came across with H-02 in `4839060`.

**Where:** `backend/src/routes/twoFactor.js` (`checkCode`)

`verifyTotp` accepts ±1 step, and no last-used counter is stored. A code
observed or phished can be replayed for up to 90 seconds.

**Fixed by:** `users.totp_last_step` (BIGINT, idempotent migration) and one
conditional statement, `User.spendTotpStep`: `UPDATE users SET totp_last_step
= ? WHERE … totp_last_step < ?`. A step at or below the stored one is refused,
which also refuses a clock that drifted backwards without locking anyone out
(the next step is always above what was stored). Every accepting path —
`/login/2fa`, `/2fa/enable`, `/2fa/recovery-codes`, `/2fa/disable` — spends
the code *before* doing what it proves, so the code that turns 2FA on cannot
then complete a login. Recovery codes are spent the same way by
`User.swapRecoveryCodes`, a conditional replace of the whole stored set.

The adversarial review caught the first cut doing a read-then-write across two
awaits, which two concurrent logins carrying the same digits — exactly what a
real-time phishing relay produces — would both pass. The conditional `UPDATE`
is the only place the check and the write happen together; the loser is
refused with the same `INVALID_CODE` as a wrong code.

## M-04 — `errorHandler` returns raw SQL error text in production

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/errorHandler.test.js` (7 tests, both modes)

**On this base (`audit-on-main`):** `main`'s `sqlMessage` gate needed nothing, and is stricter than the branch's: `exposeStackTraces` is false for any hardened deployment, not only `NODE_ENV=production`. Two gaps remained and were closed in `d72e068` — no `headersSent` guard, and the 5xx mask applied to deliberate statuses too, so a route's `503 BILLING_UNAVAILABLE` reached the customer as "Something went wrong".

**Fixed by:** `details = err.sqlMessage` only when `!config.isProd`; in
production a duplicate key is a bare `409 DUPLICATE "Duplicate entry"`. The
same rule now covers an *unexpected* throw's message (a driver, a library, a
file path) — masked to "Something went wrong" in production, while a
deliberate 5xx such as `503 BILLING_UNAVAILABLE` keeps the wording it chose.
Also added the standard `if (res.headersSent) return next(err)`: an error
after an installer stream has started is handed to Express instead of
throwing a second error trying to write JSON over a half-sent body.

**Where:** `backend/src/middleware/errorHandler.js:30` and `:41`

```js
} else if (err.code === 'ER_DUP_ENTRY') {
  status = 409; code = 'DUPLICATE'; message = 'Duplicate entry';
  details = err.sqlMessage;        // ← attached unconditionally
```

Only `error.stack` is gated on `!config.isProd`; `details` is not. A MySQL
duplicate-key message names the table, the index and the duplicated value — for
example an email address. That is schema disclosure, and on any route that can
hit a unique constraint with a user-supplied address it re-opens the account
oracle that `/auth/register` was rewritten to close.

## M-05 — Panel login is a timing oracle for the admin address

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/passwordCheck.test.js`, and measured on the live deployment after the port: a sign-in for an address that does not exist took **1.09 s**, where the early return used to answer in under 2 ms

**On this base (`audit-on-main`):** **FIXED** in `bb6193e`. `main` had already closed the 500 half (a `!user.password_hash` guard) but still returned before comparing anything for a non-admin address. `utils/passwordCheck.js` now holds the one comparison all three realms use: a real cost-12 compare against the account's hash or against a dummy nobody knows. `test/passwordCheck.test.js` pins the property — the no-hash branch must be orders of magnitude slower than an early return and within the same order as a genuine compare — rather than a percentage that would flake on a shared runner.

**Where:** `backend/src/routes/admin.js` (`POST /login`), `backend/src/routes/root.js` (`POST /login`)

```js
if (!user || user.role !== 'admin')
  return fail(res, 'INVALID_CREDENTIALS', …, 401);   // returns immediately
const match = await bcrypt.compare(password, user.password_hash);  // ~250 ms
```

A non-admin address answers in milliseconds; an admin address costs a full
bcrypt round. The address of the admin — and of the creator, via the identical
shape in `root.js` — is therefore measurable with a stopwatch.

`/api/auth/register` was deliberately restructured to hash first for exactly
this reason (see its comment); the panels never got the same treatment.

Second defect in the same two lines: if the account has no password hash (a
Google-created account later promoted to admin) `bcrypt.compare(password, null)`
throws, producing a 500 instead of a 401.

## M-06 — The admin IP allow-list is exact-match only, with no CIDR or IPv6

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/ipMatch.test.js` (10 tests, the matcher alone) and `test/adminIpRules.integration.test.js` (7, through the real gate: an address only the database allows signs in, a CIDR range covers an address nobody listed, and the list refuses to lock its own editor out)

**Where:** `backend/src/middleware/adminAuth.js:8` (`ipAllowed`)

```js
return list.includes(ip) || list.includes(normalized);
```

Production is configured with `ADMIN_ALLOWED_IPS=103.157.248.50` — a single
dynamic residential address (confirmed: it is the owner's current egress IP, and
it is why `POST /api/admin/login` answers `401` rather than `403 IP_FORBIDDEN`
from this machine, so the gate *is* working as configured).

The problem is operational, not a bypass: the moment the ISP rotates that
address — or hands out IPv6, which would never string-match — the owner is
locked out of **both** panels with `403 IP_FORBIDDEN`, and `ROOT_ALLOWED_IPS`
falls back to the same list. The only recovery is editing `.env` over SSH and
restarting the API. A CIDR entry such as `103.157.248.0/24` would not help
either, because it would never match anything.

**Fixed**, and then taken further, because the owner hit the operational half
of this for real: locked out of the panel by 2FA on one day and asking for the
IP limit removed the next, both because the list could only ever hold one
address that expires.

**The matcher** is now `utils/ipMatch.js`: exact addresses, CIDR ranges and
`*`, over IPv4 and IPv6, compared on the **bytes** rather than the text. That
last part is the reason it is a module and not a one-liner — a string prefix
comparison calls 203.0.113.7 a match for 203.0.113.70, and IPv6 cannot be
compared textually at all, since `::1`, `0:0:0:0:0:0:0:1` and `0::1` are
one address written three ways. IPv4-mapped IPv6 (`::ffff:203.0.113.7`, which
is what Node reports on a dual-stack socket) is compared as the IPv4 it
carries, so one entry covers a client however it connects. Leading zeros are
refused rather than read: `0177.0.0.1` is 127.0.0.1 to some resolvers, and an
entry that means different things in different places is worse than one that
is rejected.

**The list moved into the database** (`admin_ip_rules`), editable from the
creator panel — *Security → Who can reach the panels*. Add an address or a
range, label it, turn entries on and off, remove them. No SSH, no restart.

Three things make that safe to have at all:

- **The .env half is still read, and cannot be edited from the panel.** The
  effective list is the union of `ADMIN_ALLOWED_IPS` and the enabled rows, so
  the `.env` entry is a break-glass that no mistake made in the screen can
  take away. This is the one table whose rows decide who may edit the table.
- **Every write is refused if it would lock the caller out.** Disabling or
  removing the last entry that admits your own address answers
  `409 WOULD_LOCK_YOU_OUT` and names the address the server sees you at. A
  list you can edit into refusing you is not a feature, it is a trap.
- **Creator panel only.** A staff admin who could edit this could shut the
  creator out of their own deployment. `ROOT_ALLOWED_IPS`, when set, stays
  `.env`-only and is *not* widened by the panel's rows for the same reason.

The screen shows the whole gate rather than only its own half: the `.env`
entries read-only, the address the server actually sees you at (not always what
you think, behind a proxy), and a warning when something is `*` — because a
carefully built list under an open gate is decoration, and saying so beats
letting somebody build one.

Entries are validated on the way in by the same function the gate matches
with, so the panel cannot accept a value that would then never match
anything — which is how a typo becomes "I added my address and it still says
403".

## M-07 — Duplicate subscriptions are possible and stale licence keys never die

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `api.integration` → "admin subscriptions: one per account" (4 tests)

**On this base (`audit-on-main`):** ported in `5d495fc`. `main` had answered the stale-key half differently — create the second row, expire the first (`retireOthers`) — which leaves the duplicates the finding is about and is incompatible with the `uq_subscriptions_user` index production already runs. The index and the `409 SUBSCRIPTION_EXISTS` answer replace it; nothing is lost, because a key that must change is rotated in place by `rotateLicenseKey`, which `main` already wires to the customer's own route. The staff guard on both subscription write paths came with it.

**Fixed by:** `POST /admin/subscriptions` answers `409 SUBSCRIPTION_EXISTS`
(naming the existing row in `details`) when the account already has one —
registration gives every account a free row, so the route is for the rare
account with none, and anything else is an edit. `PUT /users/:id { plan }`
edits the account's **newest** row only, the same row `PUT /subscriptions/:id`
edits and every reader shows; `Subscription.updateByUserId` is gone.
`PUT /subscriptions/:id` and `POST /subscriptions` now go through
`blockedStaffTarget()` on the owner, so a staff admin cannot alter the
creator's plan.

**Also done (deploy prep, 2026-09-20):** the `UNIQUE` index `uq_subscriptions_user
(user_id)`, added as an idempotent boot-time migration after production was
checked for duplicates (6 subscriptions, 6 distinct owners — none). Every
insert site already creates a row only when the account has none, and the
full suite passes with the index in place (290/290); a race between two
creates now surfaces as `ER_DUP_ENTRY` → `409 DUPLICATE` instead of two rows.

**Where:** `backend/src/routes/admin.js` (`POST /subscriptions`, `PUT /users/:id`)

`POST /api/admin/subscriptions` inserts a new row without checking whether the
user already has one, while every reader in the codebase takes
`Subscription.findByUserId(userId)[0]` — the newest. The older row keeps
`status = 'active'` and its own licence key, and `Subscription.findByLicenseKey`
will happily validate it forever.

Worse, the two admin paths disagree about what "the" subscription is:
`PUT /users/:id` changes the plan with `Subscription.updateByUserId`, which
writes **every** row for that user, while the reads only ever see the first.

Related: `PUT /api/admin/subscriptions/:id` has no `blockedStaffTarget()` guard,
so a staff admin can alter the creator's subscription.

## M-08 — The live site advertises plans that cannot be bought

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `frontend/src/test/pages.test.jsx` — *"says so on the paid buttons and drops the Stripe promise"* and *"keeps the normal buttons when billing is live"*

**Where:** `frontend/src/pages/Pricing.jsx`, `backend/src/routes/subscription.js`

Production runs with `billingMode = 'disabled'`, so
`POST /api/subscription/checkout` always throws `503 BILLING_UNAVAILABLE`.
Pricing.jsx still renders "Upgrade to Pro" and "Get Team" as live buttons and
only surfaces the failure as a red toast *after* the click.

The frontend has no way to do better: neither `GET /api/subscription/plans` nor
`GET /api/health` exposes the billing mode. (`/api/admin/stats` and
`/api/admin/health` do, but those are behind the admin gate.)

**Fix:** expose `billingMode` on a public endpoint and have Pricing render an
honest state — waiting-list, "contact us", or the trial CTA alone — instead of a
buy button that cannot work.

**On this base (`audit-on-main`): already fixed, nothing to port.** The finding
was written against the deployed lineage, where it was true. `main` had solved
it independently and the audit only reached it after the rebase:

- `GET /api/subscription/plans` is public — no `requireAuth` — and answers
  `{ ...PLANS, billing: config.stripeMode }`.
- `Pricing.jsx` reads that into `billingOpen = plans.billing !== 'disabled'`
  and `resolveCta` returns *"Paid plans coming soon"* / *"Coming soon"* as a
  plain state label rather than a button that answers 503 on click. The
  "payments handled by Stripe" line goes with it.
- Both directions are already covered by tests, including the one that matters
  for not over-correcting: with billing live, the normal buttons come back.

Verified by reading the code and the tests on this base rather than assumed
from the rebase — the same mistake in the other direction (marking something
fixed because the branch moved) is what the *Reconciliation* section exists to
avoid. Seven other findings resolved this way are listed there; this is the
eighth.

## M-09 — The admin panel keeps rendering as signed-in after its session dies

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** panel lints and builds; the shared contract is asserted against the real module in `frontend/src/test/sessionEnded.test.jsx` (the panel has no test harness — CI lints and builds it only)

**Where:** `admin/src/context/AdminAuthContext.jsx`, `admin/src/api/client.js`

Three things combine:

1. `ProtectedAdminRoute` gates on `isAuthenticated: Boolean(token)` where `token`
   is React state.
2. The axios interceptor clears the **module-level** `adminAccessToken` on a
   failed refresh but never touches that React state.
3. `loadMe()`'s catch sets `admin = { authenticated: true }` even when
   `GET /<realm>/me` failed.

After the refresh cookie expires (8 h staff, 4 h creator) the panel shell stays
up, the nav renders, and every data fetch fails — instead of bouncing to the
login screen.

Related: because `admin` can be the placeholder object, `isRoot` computes as
`false` and the creator-only navigation disappears for the real creator.

**Fixed.** The interceptor now reports the fact once, as
`SESSION_ENDED_EVENT`, and `AdminAuthContext` listens and clears both
`token` and `admin` — clearing the React token is what actually bounces the
panel to `/login`, because that is what `isAuthenticated` reads. The idiom
was already in this file for `TWO_FACTOR_REQUIRED`; this is the second user
of it. It is deliberately **not** dispatched from `clearAdminAccessToken()`,
which also runs on a real sign-out that tears its own state down and would
race it.

`loadMe()`'s catch no longer invents a profile. Setting
`{ authenticated: true }` said the opposite of what had just happened, and
the placeholder is what made `isRoot` false for the real creator. By the time
that catch runs a 401 is already an event; anything else is a blip, where
leaving the last known profile alone is the honest answer.

## M-10 — A failed site refresh leaves a stale "signed in" marker

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `frontend/src/test/sessionEnded.test.jsx` (3 tests: the event is named once and shared, a listener on it clears the hint that outlives the tab, and a deliberate sign-out does not go through it) — frontend 61 pass / 0 fail

**Where:** `frontend/src/api/client.js`

On refresh failure the interceptor calls `clearAccessToken()` but does not clear
the readable `ndm_session` hint cookie or reset `AuthContext` state. `logout()`
clears the hint; the interceptor does not. The UI can therefore show a
signed-in header with no usable token, and the next page load still believes
there may be a session.

**Fixed** the same way as M-09, and the same shape of bug: the client reports
the session is over, `AuthContext` is the one place that decides what that
means, and it clears the hint and the user together. Three things had to go
and only one was going — which is exactly what happens when three callers each
have to remember three steps.

The listener is registered before the mount effect so the two cannot race, and
`init()`'s own catch stays as it was: it already handled the page-load case
correctly, and the bug was only ever the mid-session one.

Six tests mock `../api/client` and needed the new export; vitest throws on an
export a mock does not define, which is how all six announced themselves at
once. The real value is asserted against the real module, so the doubles
cannot quietly drift from it.

## M-11 — SMTP does not require TLS

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/emailTransport.test.js` — 5 cases, each in its own process (the transport is memoised and the config reads the environment once): port 587 gets `requireTLS` and a TLS 1.2 floor, 465 keeps implicit TLS and takes it as well, loopback is exempt, a host that merely starts with 127 is not, and mock mode builds no transport at all

**Where:** `backend/src/utils/email.js:24`

```js
secure: config.SMTP_PORT === 465,
```

That is the only transport security setting. On the default port 587 nodemailer
will use STARTTLS *if offered* and otherwise continue in plaintext, sending
`SMTP_USER` and `SMTP_PASS` in the clear. `requireTLS: true` is missing.

Worse than "might not encrypt": it **downgrades silently**. An attacker on the
path who strips the STARTTLS capability out of the server's greeting gets the
same plaintext session, and nothing logs a complaint. What crosses it is the
relay password, every verification link, every password-reset token and every
licence key.

**Fixed** with `requireTLS: true` and `tls: { minVersion: 'TLSv1.2' }`. TLS 1.0
and 1.1 are withdrawn; without a floor, node offers whatever the relay asks
for, which makes the downgrade the relay's decision to make. Failing to deliver
mail is a worse outcome than delivering it, and a much better one than handing
the credentials to whoever is listening.

**One exception: a relay on loopback**, where there is no network to be on. A
developer running MailHog or Mailpit on `127.0.0.1:1025` should not have to
terminate TLS to read a test message. The check is deliberately exact —
`localhost`, `::1`, `[::1]` and `127.x.x.x` — because an earlier draft used
`/^127./`, which would have exempted `127.evil.com` and `1270.example.com`.
Both are now cases in the suite. Anything else, including a relay on the LAN,
has a network hop and has to encrypt it.

## M-12 — Team invitations never expire

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/teamInviteExpiry.integration.test.js` — 5 cases: a fresh invite is accepted, an aged one is refused at both readers with `410 INVITE_EXPIRED`, resending revives it, an accepted membership is untouched by age, and a dead invite stops holding a seat

**Where:** `backend/src/routes/team.js`, `backend/src/models/TeamMember.js`

`team_members.invited_at` is recorded but never read. An invite link works
forever until the owner deletes the row or resends (which rotates the token). A
year-old forwarded invitation still joins the team.

The address check on accept is sound — only the invited address may accept — so
this is a staleness problem rather than a takeover. It still matters, because
the invited address is exactly what somebody reading an abandoned mailbox
already has.

**Fixed** with `TEAM_INVITE_TTL_DAYS` (default 14 — long enough for somebody
on holiday, short enough that a forgotten mailbox is not a standing key to
someone else's subscription). The rule lives on the model as
`TeamMember.isExpired` rather than in the routes, because **two** routes read
a token — the pre-sign-in lookup and the accept — and a rule enforced in one
but not the other is the same bug with an extra step.

An expired invitation answers `410 INVITE_EXPIRED` and says so, rather than
being folded into `INVITE_NOT_FOUND`. There is no oracle to protect here:
holding the token is already proof of having been invited, and *"expired, ask
for another"* is actionable where *"no longer valid"* leaves somebody guessing.

**The half that is easy to miss:** `used` counted every row, so an expired
invite would have held a seat for ever. That is the unwanted side of adding
expiry — a five-seat team quietly becoming a four-seat one, with nothing on the
roster explaining why. Expired invites no longer count toward `used` or
`canInvite`, the row stays so the owner can resend it (which revives it, since
`rotateToken` resets `invited_at`), and `memberView` now carries `expired` so
a dead invite reads as dead. The suite pins the opposite case too: an
**accepted** membership must not expire, because getting that wrong would cut
off paying members after a fortnight — far worse than the bug being fixed.

## M-14 — The creator cannot recover from a lost authenticator

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** run against a seeded account in the exact state — 2FA on, secret stored, zero recovery codes: `--dry-run` wrote nothing, the real run cleared all three columns, bumped `token_version`, left `password_hash` untouched and wrote the audit row, the second run reported nothing to clear, and an unknown address and an unknown flag were both refused. Then run on production for the creator who was actually locked out.

**Where:** `backend/src/routes/root.js:260` (`/admins/:id/reset-2fa`), `backend/src/routes/twoFactor.js` (`/2fa/disable`), `backend/src/scripts/createRoot.js`

There are exactly two ways to clear an account's second factor, and neither can
reach the creator:

1. `POST /api/root/admins/:id/reset-2fa` goes through `loadStaffTarget()`, which
   refuses `user.role === 'root'` outright.
2. `POST /<realm>/2fa/disable` needs the account's password **and a current
   code** — useless once the authenticator is gone.

`createRoot.js` rewrites name, role, `email_verified`, `banned` and
`password_hash`, and deliberately does not touch `totp_*`. So a creator who
loses their phone and has no recovery codes left is locked out of `/root`
permanently; the only way back is a hand-written `UPDATE` on the production
database.

This gap pre-dates the audit, but **H-02's fix makes it reachable**: a creator
whose only recovery codes are legacy ones now has them retired on their next
authenticator sign-in, and is one lost phone away from the lockout unless they
notice the audit row and generate a new set (which needs M-15).

**This stopped being hypothetical.** The creator of this deployment lost their
authenticator with no recovery codes left — the exact case above — and found
there was no way back through the product at all. The panel was unreachable
until it was fixed from a shell.

**Fixed** with `npm run reset-2fa -- <email>` (`src/scripts/reset2fa.js`),
the second of the two options. It is deliberately outside the product, and
that is the right trust boundary rather than a weaker one: anyone who can run
it can already read the database and the JWT secrets, so it grants no
authority they did not have. What it adds is that the recovery is one
documented command instead of hand-written SQL against a live table, and that
it leaves an audit row saying it happened.

It clears the same three columns `POST /api/root/admins/:id/reset-2fa`
clears, so the two paths cannot drift into leaving different residue behind,
and revokes sessions for the same reason that route does. It does **not** touch
the password: somebody who has lost their phone still has to know it.

`--dry-run` reports and writes nothing; a confirmation prompt guards the real
run; `--yes` is *required* rather than assumed when there is no tty, because
this is a security control being switched off. Re-running is a no-op.

**M-15 is the other half of this** and landed first: the reason the account had
zero codes was that the panel had no way to generate a set after enrolment.
With both in place the shell script is the last resort it should be, rather
than the only route.

## M-15 — The panel does not surface any of the new recovery-code migration state

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/totp.test.js` — two new cases covering an account with an EMPTY set (regenerating on the authenticator alone; a wrong password still refused), alongside the three that were already there; admin panel lints and builds

**Where:** `admin/src/pages/Security.jsx`

H-02 added `recoveryCodesLegacy` to `GET /<realm>/2fa` and a
`POST /<realm>/2fa/recovery-codes` endpoint, precisely so an admin sitting on
pre-bcrypt codes can be told and can fix it. `Security.jsx` reads
`state.recoveryCodesLeft` and never reads `recoveryCodesLegacy`; nothing calls
the regenerate endpoint. The server-side migration path therefore exists with no
way to drive it from the UI, and an account whose legacy codes were just retired
sees only "0 recovery codes left" with no explanation and no button.

**Found the hard way.** The creator of this deployment asked how to get
recovery codes back, having enrolled, been shown them once and closed the page.
The answer at the time was: you cannot, from the panel. The row said
`totp_recovery = []` while `ADMIN_2FA_REQUIRED` was on — one lost phone from a
permanently locked panel, with no account above the creator to reset it.

**Fixed** in `Security.jsx`:

- A **Generate recovery codes** action next to the count, posting password +
  code to the endpoint that H-02 shipped, and reusing the one-time display the
  enrolment flow already has.
- A **red warning when the count is zero**, which is the state nothing named
  before. It says what is actually at stake, and it says it differently for the
  creator (nobody can reset it) than for a staff admin (the creator can).
- A **warning when `recoveryCodesLegacy` is true** — the finding's original
  subject — explaining that pre-bcrypt codes are recoverable from a database
  read, which is the one thing a second factor should survive.
- The *Lost your authenticator?* card no longer only offers advice that
  presumes a code you may not have. It now says plainly that the codes and the
  regenerate action both need something you can only produce while the device
  is still in your hand.

The two new tests are the case that matters and the one the existing coverage
stepped over: every earlier test starts from a populated set, so nothing proved
an account could get its *first* replacement set. Turning 2FA off and on again
was the only route before, and it is strictly worse — it drops the account to a
password alone for the length of the re-enrolment and discards a working
authenticator enrolment for no reason.

## M-13 — Five routes read `:id` from the URL with no schema validation

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `api.integration` → "an id that is not a number is a 400" (all five routes answer `400 VALIDATION_ERROR`)

**On this base (`audit-on-main`):** `main` fixed this independently — all five routes validate. Nothing to port.

**Fixed by:** `validate(idParamSchema)` on the four admin routes (the schema
already existed, exported and unused) and a new `deviceIdParamSchema` on
`DELETE /user/devices/:id`. The handlers read the coerced `req.params.id`.

Everything else in the codebase validates params with a zod schema. These five
called `Number(req.params.id)` directly, so `NaN` reached the model layer:

| Route | File |
|---|---|
| `GET /api/admin/users/:id/details` | `admin.js:320` |
| `POST /api/admin/users/:id/revoke-sessions` | `admin.js:394` |
| `POST /api/admin/subscriptions/:id/revoke-device` | `admin.js:467` |
| `DELETE /api/admin/releases/:id` | `admin.js:646` |
| `DELETE /api/user/devices/:id` | `user.js:269` |

---

# LOW

## L-01 — `/auth/verify-email` puts its rate limiter before `validate()`

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** the route now reads
`'/verify-email', authLimiter, validate(verifyEmailSchema)`, matching every
other limited route in the file; `rateLimit.integration` still passes

`backend/src/routes/auth.js`. Every other auth route mounts the limiter *after*
`validate()` and says why in a comment: "a request that fails its schema costs
no auth quota". `/verify-email` is the exception, so malformed bodies burn the
verify-email budget.

**On this base (`audit-on-main`): the same hole, worse.** `main` rewrote this
route and `/verify-email` ended up with **no limiter at all** — the order the
finding describes does not exist here, because there is nothing to order. Every
other limited route in the file puts its limiter first, so the fix is
`authLimiter` in that position rather than the one the original text argues
for.

Not about brute force: the token is an unguessable JWT. It is that an
unauthenticated endpoint doing signature verification and a database write
should not be free to call.

## L-02 — The contact-form honeypot does not behave as documented

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `flows.integration` → "the honeypot swallows bots quietly" — still a 400, and `assert.doesNotMatch(res.text, /website/i)`; `schemas.test.js` unchanged and passing

`backend/src/schemas/contact.schema.js`. The comment promised "a bot that fills
every field gets a polite 200 and nothing is sent". In practice
`website: z.string().max(0)` makes a filled honeypot a `400 VALIDATION_ERROR`
whose `details.fieldErrors.website` names the trap — which tells the bot exactly
what caught it and how to avoid it next time.

**Half of this had already been fixed on `main`, in the other direction:** the
comment was rewritten to describe what the code does, so the documentation no
longer lies. What was left is the part that actually matters — the 400 naming
the field.

**Fixed** by moving the emptiness rule from the field to an object-level
`.refine()` with a message that says nothing about which rule failed. Same
refusal, same status code, same schema output; the error now lands in
`formErrors` instead of `fieldErrors.website`. Deliberately *not* changed to
the polite 200 the old comment described: that is a contract change the client
would have to be taught about, for no more benefit than this.

## L-03 — The account export is wrapped in the API envelope

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `flows.integration` → "the export is a complete, secret-free document", which now parses `res.text` and asserts `doc.ok === undefined`

`backend/src/routes/user.js` (`GET /export`). The file downloads as
`nexa-account-<id>.json` but contains `{"ok":true,"data":{…}}` rather than the
export document itself.

**Fixed:** the response is sent bare, with `res.type('application/json')` and
`JSON.stringify(document, null, 2)` — pretty-printed, because this one is read
by a person rather than by our client. Every other route here keeps the
envelope; this is the only response that leaves as a file somebody stores, and
a file is the document, not the document inside a transport wrapper that means
nothing outside this API.

## L-04 — `GET /api/user/me` returns `totp_secret` and `totp_recovery`

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/userView.test.js`

**On this base (`audit-on-main`):** ported with H-01 in `4b64690`; `sanitizeUser` is `publicUser`.

`backend/src/routes/user.js:24` (`sanitizeUser`) stripped four fields and missed
these two. The values are ciphertext and hashes rather than plaintext, so this was
exposure rather than compromise — but for an admin account it handed the
second-factor material to anything that can read one API response. Same root
cause as H-01: a deny-list where an allow-list belongs, and fixed by the same
`publicUser` projection.

## L-05 — Interrupted uploads leave orphaned temp files

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/sweepIncoming.test.js` — 5 cases: an abandoned file goes, an upload still in flight stays, real installers are untouched however old, the cut-off is a boundary on both sides, and a missing upload directory is not an error

`backend/src/utils/releaseFiles.js`. `storeUpload` writes `.incoming-<uuid>` and
renames on success. A process death mid-upload leaves a partial file —
potentially hundreds of MB — in `RELEASE_UPLOAD_DIR` forever. There is no
sweeper.

**Fixed** with `sweepIncoming()`, wired into the housekeeping pass that already
runs in-process every six hours (`utils/housekeeping.js` — the shared host has
no reliable cron for the backend). It is the only step there that touches the
filesystem rather than a table, which is the point: on shared hosting the disk
quota is what runs out first, and a partial installer is up to
`MAX_RELEASE_UPLOAD_MB` of it.

**Age is the entire safety mechanism**, so the cases that matter are the ones
where sweeping would be wrong. An upload in flight has a very recent mtime, so
the twelve-hour cut-off cannot reach it — hours rather than minutes because the
file is somebody's half-finished release and a slow connection pushing 200 MB
is normal rather than stuck. Only the `.incoming-` prefix marks a file as
abandoned, so a year-old installer sitting in the same directory is left alone:
that is a release, not litter. A missing upload directory returns 0 rather than
an error, because a deployment that has never had an upload should not report a
failure every six hours and teach everyone to ignore the log.

## L-06 — `strongPassword` only enforces a minimum length

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/passwordPolicy.test.js` — fixed on `main` independently, nothing to port

**On this base (`audit-on-main`):** **FIXED on `main` independently** — `utils/passwordPolicy.js` rejects common passwords, values containing the address, and (with `PASSWORD_BREACH_CHECK`) anything in Have I Been Pwned's k-anonymity range API. Nothing to port.

`backend/src/schemas/auth.schema.js`. Despite the name it is
`z.string().min(8)`: no maximum, no complexity rule, no common-password check.
The same rule governs admin and root passwords set from the panels.

## L-07 — The download counter also inflates on HEAD and on a missing file

**Status:** FIXED — with H-06 &nbsp;|&nbsp; **Verified by:** `downloadCounter.integration` ("a HEAD is a size probe", "a release whose file is missing answers 404 and counts nothing")

**On this base (`audit-on-main`):** ported with H-06 in `14c8d1d`.

## L-08 — `notFound` reflects the raw request URL

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** the message is now `Route not found: <METHOD>` with nothing from the request in it

`backend/src/middleware/errorHandler.js`. Confirmed live:
`GET /api/nope%3Cscript%3E` → `"Route not found: GET /api/nope%3Cscript%3E"`.
The content type is `application/json`, so this is not browser-exploitable; it is
input reflection worth removing rather than a vulnerability.

**Fixed** by dropping the URL from the message entirely. The caller already
knows what they asked for, and the full URL is in the access log for anyone who
needs it — so echoing attacker-supplied text back earned nothing at all.

## L-10 — "Member since" is always blank on the profile page

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/userView.test.js` → "the camelCase timestamps are ISO strings, or null when the column is empty" — `publicUser` supplies the `createdAt` the page was already reading

**On this base (`audit-on-main`):** fixed by the H-01 port: `main`'s profile page already read `user.createdAt`, and `publicUser` is what now supplies it.

`frontend/src/pages/Profile.jsx:281` reads `user.createdAt`. `GET /api/user/me`
has always served `created_at`, and nothing between the two remaps it —
`AuthContext` passes the payload straight through. So the date never renders and
the page shows its em-dash fallback, on the live site, today.

`frontend/src/pages/Billing.jsx:16` writes `payment.createdAt || payment.created_at`,
so the codebase is already inconsistent about which convention it expects.

**Fix:** read `created_at` in Profile.jsx (the API convention is snake_case
throughout), or decide explicitly that the API camel-cases its output and do it
in one place. Do not add another `a || b`.

## L-09 — Email subjects interpolate unescaped user input

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `headerSafe()` strips CR, LF and tabs, collapses runs of whitespace and truncates; `sendContactMessage` puts both `topic` and `name` through it

`backend/src/utils/email.js` (`sendContactMessage`). `topic` and `name` go
straight into the `Subject`. Nodemailer encodes headers, so this is not
injectable today; the input is simply not newline-stripped at the edge.

**Fixed** with `headerSafe()`. The point is not that today's encoder lets
something through — it does not — but that header safety was one dependency's
implementation detail away from being our problem, and the next thing to build
a header out of this text might not encode at all. It also trims and truncates,
because a subject is one line and sixty characters of topic is already generous.

---

## L-11 — the edge drops `Access-Control-Allow-Origin` but keeps `Allow-Credentials`

**Status:** OPEN &nbsp;|&nbsp; **Verified by:** probed live, both sides of the proxy

Express answers correctly. Asked from the server itself, bypassing everything
in front of it:

```
Access-Control-Allow-Origin: https://nexadownloadmanager.com
Vary: Origin
Access-Control-Allow-Credentials: true
```

The same request to the public URL comes back with only:

```
Vary: Accept-Encoding
Access-Control-Allow-Credentials: true
```

`Access-Control-Allow-Origin` and `Vary: Origin` are gone. It is not
`api-proxy.php`: its response filter strips hop-by-hop headers only, and
neither of these is in that list — which is also why `Allow-Credentials`
survives. That leaves the host stack (LiteSpeed / `hcdn`) rewriting `Vary`
for compression and dropping the origin headers with it.

**This fails closed, which is why it is Low.** Without `Allow-Origin` a
browser refuses to hand the response to a cross-origin caller no matter what
`Allow-Credentials` says, so nothing is exposed. The site itself is unaffected
because it is same-origin, and the desktop app is not a browser.

It is still worth recording. `Allow-Credentials: true` with no `Allow-Origin`
is a header pair that means nothing, and it reads to anyone who looks as if
CORS were configured permissively when the opposite is true. The day something
legitimately needs cross-origin access — a panel on a subdomain, a status
page — it will fail with no clue pointing at the host stack rather than the
code. **Fix:** re-assert both headers in `public_html/.htaccess`, where the
edge cannot drop them, or accept it and note it beside the `cors()` call so
the next person does not debug Express.

---

## L-12 — responses carrying personal data had no `Cache-Control` at all

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/cacheControl.integration.test.js` (4 tests), and probed live before and after

The whole backend set `Cache-Control` on exactly one route: the release feed,
which opts in to `public, max-age=300` deliberately. Everything else —
`/user/me`, `/subscription/status`, the licence key, the team roster, every
admin screen — went out with no cache directive at all. Helmet has not set
one since v4, so nothing was filling the gap.

**No header is not "do not cache."** RFC 9111 lets a shared cache store a
response with no freshness information and serve it again on its own
heuristics. And the CDN in front of this deployment does cache: `Age: 70`
comes back on the feed.

Probed before fixing, it turned out the CDN caches *only* the route that opts
in — repeated hits on `/subscription/plans` and `/ads` never grew an `Age`.
So nothing was leaking. But that is one vendor’s configuration on one
afternoon, not a property of this code, and the thing being protected is a
body with somebody’s email address and licence key in it.

**Fixed** by inverting the default: `middleware/noStore.js` sets
`no-store, private` for everything under `/api`, and a route that is genuinely
public overrides it with its own header. The feed’s opt-in is pinned by a test
precisely because a middleware that silently swallowed it would cost real
bandwidth and nothing would fail.

---

# TEST DEBT

Tests that assert a contract the code has since — deliberately — moved away
from. They only became visible once the integration suite could run (O-03).
Each needs rewriting to pin the *current* behaviour, not deleting.

## T-01 — `rejects a duplicate email` asserts the account oracle that was removed

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `api.integration` → "a second registration with a taken address is indistinguishable and inert"

`backend/test/api.integration.test.js:42` expected a second registration with a
taken address to answer `>= 400`. `/api/auth/register` deliberately answers
`201 { registered: true }` either way — that is the account-enumeration fix
recovered in `9f312a2` — and the test was never brought along.

**Rewritten to pin the real contract:** both registrations answer a
byte-identical `201 { registered: true }` with no cookie; exactly one `users`
row and one free licence exist afterwards; the first account's password hash
is untouched and the newcomer's password does not sign in.

## T-02 — `auth endpoints stop brute force after 5 attempts` asserts the old shared bucket

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/rateLimit.integration.test.js` (rewritten, 6 tests)

`backend/test/rateLimit.integration.test.js:18` expected a `429` after five login
attempts. WP-08 split the budgets: login is **30 per 15 min per IP**, with a
per-**account** slowdown (100 → 2000 ms) instead of a refusal. Seven attempts
therefore get seven `401`s, which is the intended behaviour.

**Rewritten to pin both halves,** each subtest from its own forwarded address:
30 attempts against distinct addresses are `401`s and the 31st is
`429 RATE_LIMITED` while a neighbouring IP is untouched; 35 malformed bodies
spend no budget (the limiters sit after `validate()`); three failures against
one address earn a 100 ms wait, the fourth attempt measurably waits it (lower
bound only — an upper bound would make a slow CI box a failure) and earns 250,
the fifth waits that; a successful sign-in clears the counter.

---

## T-03 — `durableLimiter.test.js` tested whichever store the machine happened to give it, and hung the runner when that was MySQL

**Status:** FIXED &nbsp;|&nbsp; **Found by:** the first CI run that was allowed to start &nbsp;|&nbsp; **Verified by:** the file run twice in a row with `MYSQL_*` set and twice without, and the whole suite under CI's environment

The first run of `website.yml` that GitHub actually started did not fail and
did not pass. It printed `ok 64` and `ok 65` at 15:29:07 and then nothing at
all, and would have sat there until GitHub's six-hour ceiling — billing every
minute — if it had not been cancelled. The orphan list at cancellation shows
why nothing more was coming: one `node`, no child. The runner was waiting for
a test file's process to exit, and that process was never going to.

`test/durableLimiter.test.js` says in its own docblock that it exercises the
store's **in-memory fallback** — "with no database reachable … the one under
test here". It never arranged for that to be true. It was true on a developer
machine, where nothing puts `MYSQL_*` in the shell, so the store's first query
failed and it counted in memory. CI sets `MYSQL_*` for the whole job, so the
store reached the database instead and `config/db.js` built a pool. Nothing
closed it, an idle pooled connection is an open handle, and `node --test` runs
files one at a time and waits for each to exit.

So the file had two defects at once, and they hid each other:

- **It tested the wrong thing, silently.** Its subject was decided by ambient
  environment, so the machine it was written on and the machine that matters
  ran different code under the same green tick. That is O-03's own shape —
  coverage that reads as coverage and is not — which is what makes it worth a
  finding rather than a quiet fix.
- **It stopped the run.** Not failed it. A failure is information; this
  produced none, and cost six hours of a billed runner to produce it.

**Reproduced before fixing**, which is the only reason the cause is not a
guess: the two files run together with no `MYSQL_*` exit 0, and with
`MYSQL_*` pointing at a live database both tests pass and then the file hangs
— killed at 90 s, exit 124, exactly CI's shape.

**Fixed** with an `after()` hook that ends the pool (the load-bearing part;
`getPool()` on a run that never touched a database just builds an idle pool and
closes it, because mysql2 does not dial until a query) and a `before()` hook
that truncates `rate_limits`. The second is needed because the MySQL store is a
table and a budget spent by the previous run is still spent — without it the
suite passes once against a given database and then reports 429 where it asked
for 200, which reads as the limiter miscounting rather than as the test
bringing its own leftovers. The docblock now says the limiter is the subject
and the store is whichever one the environment supplies, which is a claim that
is true on both.

**And the reason it cost six hours rather than twelve minutes:** no job in
`website.yml` had a `timeout-minutes`. All three now do. A hang is worth
finding; it is not worth GitHub's default ceiling to find it.

`--test-timeout` was tried first and rejected: it does not catch this (the
process still hung) and it marked passing tests as failures on the way.

---

## T-04 — a missing `});` turned five Google sign-in tests into subtests that never ran

**Status:** FIXED &nbsp;|&nbsp; **Found by:** the first CI run that got past T-03 &nbsp;|&nbsp; **Verified by:** `test/googleAuth.test.js` — 10 tests, 10 pass, and a sweep confirming no other column-0 `test(` in the suite sits at a non-zero brace depth

`test/googleAuth.test.js` is missing one `});`. The test that starts at
line 107 closes its `withClientId` block and then never closes itself, so the
next five `test(...)` calls — written flush at column 0, looking exactly like
top-level tests — are registered **inside that test's callback**. A stray
`});` further down is what finally closes it.

The five are not incidental. They are the ones asserting that the signature
path refuses a wrong issuer, an expired token and an unverified email; that
`alg=none` never reaches verification; that an unknown key id forces exactly
one refetch and the key set is otherwise cached; that nothing is verified at
all with no client ID; and that a missing or malformed credential is refused
before any network call. That is most of what makes Google sign-in safe.

Because the parent never awaits them, Node 22 cancels them —
`cancelledByParent`, *"test did not finish before its parent and was
cancelled"* — so **they do not run**. Node 24 waits for them, which is why they
pass on this machine and why the count still read 533. CI pins Node 22 because
production runs Node 22, and this is the whole argument for pinning it: the
suite that counts is the one on the version you ship.

The damage was not limited to the five. The parent's `finally` restored
`GOOGLE_CLIENT_ID` to empty while the cancelled children were still in
flight, so the *next* real test failed with `Google sign-in is not
configured` — a failure whose cause was four tests away.

**Fixed** by closing the test at line 107 and removing the stray closer, each
anchor asserted line by line before anything moved. All ten are top-level now,
at brace depth zero, and all ten pass. A sweep of every test file says this was
the only place it happened.

---

## T-05 — a fake that could only answer an abort, on a timer that does not hold the loop open

**Status:** FIXED &nbsp;|&nbsp; **Found by:** the same CI run &nbsp;|&nbsp; **Verified by:** `test/passwordPolicy.test.js` — 6 pass, the slow case taking 51 ms against its 50 ms budget, and `[password] breach check skipped: aborted` in the output, which is the abort actually firing

`the check fails open when HIBP is down or slow` stands up a `fetchImpl`
that returns a promise with exactly one exit: an `abort` listener. The abort
is supposed to arrive from the breach check's own
`AbortSignal.timeout(PASSWORD_BREACH_TIMEOUT_MS)`.

That signal's timer is **unref'd by design** — it does not keep the event loop
alive. So the test hands the runner a promise that settles only on a timer
which is not holding the process open, and whether the loop drains first is a
race. On CI it drained first, and node answered *"Promise resolution is still
pending but the event loop has already resolved"*, cancelling this test and the
one after it.

Worth separating from T-04 because nothing here is mistyped. The test is wrong
about the runtime: it assumed a timer keeps the process alive, when this
particular timer is documented not to.

**Fixed** by giving the fake its own ref'd `setTimeout` — that is what holds
the loop open until the abort arrives, and it is cleared when it does. If the
abort never comes, the test now fails with *"the breach check never aborted its
request"* rather than dissolving into a runner message about the event loop.

---

## T-06 — the admin and creator panels have no automated tests at all

**Status:** OPEN &nbsp;|&nbsp; **Verified by:** counted — 11 pages, 13 components, **0** test files; CI runs `lint`, `build`, `npm audit` and nothing else

This is the largest single gap in the project and it is on the most sensitive
surface there is. The panels read customer emails, licence keys, subscription
records and the audit log; they can ban an account, edit a subscription, and
now change who may reach the panels at all. Not one line of that is covered by
a test.

What the backend suite covers is the **API** those screens call — which is the
half that matters for data exposure, and it is well covered (575 tests before
this pass). What nothing covers is the panel’s own logic: that
`ProtectedAdminRoute` actually redirects, that `mustEnrol` clears after
enrolling, that a 401 ends the session rather than leaving a dead screen, that
the IP editor refuses to lock you out before the server does. Every one of
those was verified by hand while it was built, which is exactly the kind of
verification that does not survive the next change.

**Fix:** vitest + Testing Library, as the frontend already uses. Start with
the four behaviours above rather than with page snapshots.

---

## T-07 — two thirds of the site’s pages have no test naming them

**Status:** OPEN &nbsp;|&nbsp; **Verified by:** counted — 27 pages, 8 test files, **18 pages** not named by any of them

The 61 frontend tests are real and they cover the right things first: the
account, billing, team, activation and session-ended flows. But the pages with
no coverage include the ones where a mistake is worst:

```
Login  ForgotPassword  ResetPassword  VerifyEmail  TeamJoin  Profile  Security
```

Every one of those is an authentication path. `ResetPassword` and `VerifyEmail`
consume single-use tokens; `TeamJoin` accepts an invitation; `Login` is the
front door. The backend half of each is covered by an integration suite — so
the *contract* is tested — but nothing checks that the page calls it correctly,
handles its failures, or does not leave a token in a URL it then navigates
away from.

The remaining eleven (About, Benchmarks, Changelog, Contact, Docs, Features,
NotFound, Privacy, Reviews, Terms, Tutorials) are mostly static and are a much
lower priority; `Contact` is the exception, because it posts.

---

## T-08 — thirteen backend routes are named by no test

**Status:** OPEN &nbsp;|&nbsp; **Verified by:** 132 routes extracted from `src/routes/*.js` and matched against every file under `test/`; 119 matched, 13 did not

Each of the thirteen was then read by hand, and **all thirteen are correctly
guarded** — so this is missing coverage, not a live hole:

| Route | Guard it actually has |
|---|---|
| `GET /admin/activity`, `/users/export`, `/subscriptions/export`, `/security/token-rejections`, `/faq/votes`, `/contact/stats`, `PUT /admin/reviews/bulk` | all below `router.use(requireAdmin)`, all zod-validated; both exports project through `safeUser` (the H-01 allow-list) |
| `POST /ai/rename`, `/ai/command` | `aiLimiter` + a signed licence token whose plan includes AI + zod |
| `POST /subscription/checkout`, `/coupon`, `/portal` | `requireAuth` + zod; all three answer 503 while billing is disabled |
| `GET /releases/history` | public on purpose, and projects a fixed field list with no download URLs |

Worth recording rather than waving away: `/users/export` and
`/subscriptions/export` are precisely the shape H-01 was about — a bulk read
of the users table — and the only reason they are safe is that they happen to
call `safeUser`. Nothing would fail if someone changed that line.

---

# OPERATIONAL

These are deployment gaps, not code defects. They were found during the server
work earlier on 2026-09-19 and are recorded here so the list is complete.

## O-01 — No automated database backups

**Status:** OPEN &nbsp;|&nbsp; **Needs:** hPanel → Advanced → Cron Jobs

`ndm-website/deploy/hostinger/daily-maintenance.sh` runs the DB backup and the
trial-reminder emails, and documents the cron line it expects. That cron was
never created: the run log holds **one** entry (2026-09-02) and the newest backup
is **2026-09-13**. `crontab` is unavailable in the Hostinger shell and
`/var/spool/cron/` is empty.

```
15 3 * * *  /bin/bash /home/u941499432/domains/nexadownloadmanager.com/daily-maintenance.sh >/dev/null 2>&1
```

Knock-on effect: `sendTrialReminders.js` has never run either, so nobody on a
7-day trial has ever received the "your trial ends in 2 days" email.

**Found during deploy prep (2026-09-20):** even with the cron in place the backup
would have failed twice over. (1) The deployed `src/scripts/backup.sh` had
**CRLF** line endings — `deploy/build-and-upload.sh` rsyncs the Windows
working copy byte for byte, and `core.autocrlf=true` writes every file as
CRLF — so `set -o pipefail` was "invalid option name" on the host. (2) It
read `.env` through `< <(grep …)`, and CageFS provides no `/dev/fd`, so the
process substitution failed with "/dev/fd/63: No such file or directory".
Both fixed: a `.gitattributes` pins `*.sh` to LF on every checkout, the
deploy script strips CRs from staged scripts and refuses to ship one that
still has them, and `backup.sh` reads `.env` through a here-string (and
`chmod 600`s the dump). Verified on the host: `nexa-20260920-1412.sql.gz`,
22 tables, `gunzip -t` clean — the first backup since 2026-09-13. The hPanel
cron is still the owner's to create.

## O-02 — Nothing restarts the API after a reboot

**Status:** OPEN &nbsp;|&nbsp; **Needs:** hPanel → Advanced → Cron Jobs

`supervisor.sh` (pid 4096195, PPID 1) was started by hand with `setsid nohup` on
2026-09-19. It is a stand-in for cron and does not survive a reboot; no hPanel
cron exists to bring it or the API back. Shared hosting has no user systemd.

```
*/1 * * * *  /bin/bash /home/u941499432/domains/nexadownloadmanager.com/run-api.sh >/dev/null 2>&1
```

`run-api.sh` holds its own `flock`, so this and `supervisor.sh` can run together
without fighting.

## O-03 — The integration tests never actually run

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** run `35775527617` on `audit-on-main` — all three jobs green. Backend 3 m 21 s on MariaDB 11.8 with `tests 533 / pass 533 / fail 0 / skipped 0`, the guard step reading those numbers back as `tests=533 fail=0 skipped=0`, and `found 0 vulnerabilities` from the production dependency audit; frontend 24 s, admin 17 s. It took four attempts to get here. Two never started — *"The job was not started because recent account payments have failed or your spending limit needs to be increased"* — because the repository was private and Actions minutes are billed; it was made public on 2026-09-22. Both runs that then executed found a real defect: **T-03** (a test that chose its own store and hung the runner), then **T-04** and **T-05** (five Google sign-in tests a missing brace stopped Node 22 from running at all, and a fake whose promise could outlive the event loop). None of the three was visible from a local suite that reported 533 passing, which is the argument for this finding in one sentence.

**On this base (`audit-on-main`):** O-03a and O-03b came across in `d086ec9` (`test/tools/testdb.sh`, now with a resumable download, a data-only `wipe` and a `purge`). O-03c is code-complete on this base too: `website.yml` runs the suite against `mariadb:11.8` on every branch that touches `ndm-website/`, and `build.yml`'s quality job loses the duplicated website steps — including the second full `npm test` it ran only to grep the log. It stays **IN PROGRESS** until a run is green on this branch. Running the suite twice here is also what found the `faq_votes` / `license_token_rejections` leak in `srv.reset()`.

**Pushed 2026-09-22.** The first run (`35745664153`) was the billing refusal
again, verbatim on all three jobs: *"The job was not started because recent
account payments have failed or your spending limit needs to be increased."*
No job started, so no step ran. The repository was then made public, and the
next run (`35747534001`) **started** — which is the first time any of this
workflow has executed anywhere.

It was worth the wait: the frontend and admin jobs went green in 25 s and
14 s, and the backend job **hung**. Not failed — hung, silently, and would
have run out GitHub's six-hour ceiling on a billed runner. That is **T-03**,
and it is exactly the kind of thing O-03 exists to catch: a test file that
tested one store on a developer machine and a different one on CI, and kept
the runner alive afterwards by leaving a connection pool open. It is fixed,
the cause was reproduced locally before it was, and all three jobs now carry
a `timeout-minutes` so the next one costs minutes rather than hours.

O-03 closed on run `35775527617`. The suite is green wherever it is run:
**535 pass / 0 fail / 0 skipped** locally against MariaDB 11.8.9, repeatable,
under CI's own environment, and on CI itself.

`npm test` reports **95 pass / 5 skipped** and exits green. All five skips are
the integration suites — `api`, `smoke`, `rateLimit`, `downloadCounter`,
`releaseVersionInvariant` — which `t.skip()` themselves when no MySQL is
reachable, which is the case on every developer machine and in the deploy path.

So the entire HTTP + database layer has **no effective coverage**. Only
`npm run test:unit` (86 tests over pure functions) asserts anything. This is
precisely why H-06 and H-07 shipped unwired with a passing test suite.

**What running them showed (2026-09-19):** a portable MariaDB 11.8.9 — the
same major.minor.patch as production — on `127.0.0.1:3399` with the harness
defaults from `test/helpers/testServer.js`. Result at `40980ed`:
**181 tests, 168 pass, 13 fail, 0 skipped.** Every suite runs; there is no
MariaDB-vs-MySQL dialect problem. The 8 leaf failures are all real:

| Suite | Failures | Cause |
|---|---|---|
| `downloadCounter` | 3 | H-06 |
| `releaseVersionInvariant` | 3 | H-07 |
| `api` | 1 | T-01 (stale) |
| `rateLimit` | 1 | T-02 (stale) |

**Done:** `test/tools/testdb.sh` stands the exact production engine up on any
machine; `test/README.md` documents it; and `.github/workflows/website.yml`
runs the suite on **every push to any branch** that touches `ndm-website/`.
The existing `build.yml` did have a MySQL 8 service and a skip guard, but it
only ran for `main` — this branch had never been through CI — it ran the
suite twice, and its guard's regex (`^. skipped`) matched the TAP marker only
by accident. The website checks moved out of it into the new workflow, which
matches production (MariaDB 11.8, Node 22) and reads the summary counts.

---

# Verified clean

Checked deliberately and found correct. Recorded so the same ground is not
re-covered, and so a regression here is visible as a change.

| Area | Result |
|---|---|
| SQL injection | No dynamic SQL from user input anywhere. Every interpolated identifier is behind an `UPDATABLE_COLUMNS` allow-list; every `LIMIT`/`OFFSET` is `Number()`-coerced and clamped. |
| XSS sinks | No `dangerouslySetInnerHTML` or `innerHTML` in `frontend/src` or `admin/src`. |
| Security headers (live) | CSP, HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options`, Referrer-Policy, COOP, Permissions-Policy all present on both the site and the API. |
| JWT token confusion | `verifyTyped()` checks `typ` on every family; admin / root / access / license are four separate secrets, asserted by `jwt.test.js` and `rootTier.test.js`. |
| Trust-proxy handling | `TRUST_PROXY=loopback`. Confirmed live: a spoofed `X-Forwarded-For` does **not** move the rate-limit bucket, so limits key on the real client IP. |
| Admin IP gate | Working as configured — see M-06 for the operational caveat. |
| Stripe webhook | Signature-verified, replay-protected via `stripe_webhook_events` with a payload hash, and refused twice while billing is off — `503` in-app plus a `403` at the edge (confirmed live). |
| Seat accounting | `acquireSeat` locks the subscription row `FOR UPDATE` and counts other devices with the same `NOW()`; `revoked_at` correctly stops a heartbeat re-taking a freed seat. |
| Team seat maths | `count + 1 >= seats` and `members.length + 1 < seats` agree; pending invites consume seats. Owner + 4 members on a 5-seat plan. |
| Google Sign-In | ID token verified against Google's JWKS with `aud`, `iss`, `exp` and `email_verified` all enforced before anything is trusted. |
| Datetime columns | `expiry_date`, `trial_ends_at`, `lease_expires_at`, ad scheduling are all `DATETIME`, not `TIMESTAMP` — no 2038 cliff. Pool pins every connection to UTC. |
| Path traversal | `resolveStoredPath()` uses `basename()` plus a containment re-check; upload extensions are allow-listed. |
| Byte-range serving | `sendFile()` handles `206`, `416`, suffix ranges and `HEAD` correctly. |
| Account enumeration | `/auth/register` returns an identical `201` either way and hashes before the lookup. (But see M-04.) |
| Build + lint | Admin and frontend ESLint clean. Admin production build reproduces the committed `dist` asset hashes exactly — the deployed panel is built from current source. |
| MariaDB compatibility | The full backend suite (181 tests) runs on MariaDB 11.8.9, production's exact version, with no dialect failures — the `LIMIT`-interpolation comments in the models are honoured. |

---

# Verification pass — 2026-09-23

The owner asked a fair question: is it *actually* all fixed? A tally is not an
answer to that, so everything below was re-run or re-probed from scratch rather
than quoted from earlier in this file. It found two new defects (L-11, L-12)
and three coverage gaps (T-06, T-07, T-08), and it turned O-01 from a
prediction into an observation.

### Re-run here

| | Result |
|---|---|
| Backend suite, MariaDB 11.8.9 | **580 / 580**, 0 failed, 0 skipped (575 before L-12’s four) |
| Frontend suite | **61 / 61**, 8 files |
| Admin panel | lint clean; build reproduces `index-BgHnUnlA.js` — the exact asset the live site serves, so the deployed panel is built from this source |
| `npm audit --omit=dev` × 3 | **0 vulnerabilities** in backend, frontend and admin |
| Secrets in the repository | none. No `.env` tracked; the only matches for key-shaped strings are variable *names* and `sk_test_not_a_real_key` in a Stripe version test |

### Probed against the live site

| Check | Result |
|---|---|
| Security headers | CSP with `frame-ancestors ‘none’`, HSTS 1 year + subdomains, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`. No `X-Powered-By` |
| `/.env`, `/nexa-api/.env`, `/.git/config`, `/.git/HEAD` | 403. `/package.json` 404 |
| Admin, root and user endpoints without a token | 401 every time, with no detail beyond "authentication required" |
| `POST /subscription/mock-complete` | refused at the edge (403) — and dead anyway: `isStripeMock` is **false** on production, checked in-process on the server |
| Rate limiting, live | five wrong passwords → 401, then `429` from the sixth on |
| CORS from a forged origin | no `Access-Control-Allow-Origin` — refused. See L-11 for the part that is wrong about *how* |
| CDN caching | only the release feed is cached (`Age` present); `/plans` and `/ads` never grew one. See L-12 |

### The database, on production

Connections pinned to `+00:00`; 23 tables, every one InnoDB. No duplicate
subscription for any user (the `uq_subscriptions_user` added under M-07 is
holding), no orphaned subscription, session or team row, and no expired session
still stored. `audit_logs` (111) and `security_events` (56) are being written,
so the trail that H-08 and M-05 depend on exists.

### O-01, no longer a prediction

`nexa-data/` holds three directories. All three are **pre-deploy** backups taken
by hand — `pre-audit-deploy-20260902`, `pre-audit-on-main-20260922`,
`pre-phase5-20260923`. There is no dated nightly among them, because nothing
has ever run `daily-maintenance.sh`. The script works; no cron calls it. The
same is true of `run-api.sh`, which is why the API is currently up only because
it was started by hand — a reboot ends it.

### What this pass did not cover

Worth stating so the green numbers above are not read as more than they are.
No penetration test and no fuzzing. No load or concurrency testing. The panels
were exercised through the API and through the middleware directly, never
through a browser session, because that needs the owner’s password. Playwright
(`npm run test:e2e`) was not run. And a passing suite says the code does what
its tests say — T-06 and T-07 are the measure of how much of the two UIs never
makes that claim at all.

# Fix plan

**The original plan had six phases, and this one has five.** That is worth
saying plainly, because a reader who saw the first plan will count and come up
short. Phase 6 was *UX and polish* — M-08, M-09, M-10, M-15, L-10 and the
L-0* block. At the rebase most of it had either already been done on `main` or
had collapsed into a change sitting beside a Phase 5 item, so splitting them
would have meant two deploys for one afternoon of work. It was folded into
Phase 5 rather than dropped: every one of its findings is in the list below or
in the ported block above, and none of them is still open.

Phases 1–4 were done on `windows-fixes-v3` and are recorded in the change log
below. Phase 4.5 re-based that work onto `main`. Phase 5 is what was left,
and it now carries what used to be Phase 6.

## Done — Phases 1–4, ported to this base (Phase 4.5)

Every one verified against MariaDB 11.8.9 before the next was started, one
commit per finding. Where `main` had solved something independently its version
was kept and the port skipped, which is recorded under each finding.

- [x] H-01 / L-04 / L-10 — one allow-listed projection of a users row; the details view gated like every write &nbsp;`4b64690`. L-10 came with it: `publicUser` supplies the `createdAt` the profile page was already reading, so "Member since" stopped being blank without a second change
- [x] H-02 / M-03 — bcrypt recovery codes, legacy retirement, `/2fa/recovery-codes`, conditional spends &nbsp;`4839060`
- [x] H-06 / L-07 — the counter wired on both download paths &nbsp;`14c8d1d`
- [x] H-07 — an installer must be the release's version &nbsp;`03afe5d`
- [x] M-07 — one subscription per account, staff guard on both write paths &nbsp;`5d495fc`
- [x] M-05 — both panel sign-ins cost the same whatever the address is &nbsp;`bb6193e`
- [x] O-03a / O-03b — the suite runs on every branch against production's engine; `testdb.sh` locally &nbsp;`d086ec9`
- [x] deploy — `build-and-upload.sh` works from Git Bash on Windows &nbsp;`82a2912`
- [x] H-03 — a ban reaches the desktop app, on both halves of a shared key &nbsp;`98d1d1d`
- [x] M-04 — `headersSent`; a deliberate 5xx keeps its wording &nbsp;`d72e068`
- [x] H-04 — `customer.subscription.created` mirrored &nbsp;`a2cead1`
- [x] H-08 — a revoked panel session actually ends &nbsp;`a6fb9dd`

Already fixed on `main`, nothing to port: **H-05**, **M-01**, **M-02**,
**M-13**, **L-06**, and the `/dev/fd` half of O-01's backup script.

## Phase 5 — what is left

**The two deploy prerequisites are done** — both are recorded below under
*Deploying this base*, and neither blocks. Then, in this order:

- [x] O-03c — a green CI run on this branch &nbsp;`35775527617`. Every run that
      actually executed found a real defect on the way: T-03, then T-04 and T-05
- [x] M-14 — `npm run reset-2fa`, the last resort when the panel cannot help
- [x] M-15 — Security page: the zero-codes and legacy warnings, and a regenerate action
- [x] M-06 — CIDR + IPv6 matching, and the allow-list moved into the creator panel
- [x] M-11 — SMTP must negotiate TLS, with a 1.2 floor; loopback relays exempt
- [x] M-12 — invitations expire after `TEAM_INVITE_TTL_DAYS`, and stop holding a seat
- [x] M-08 — already done on `main`: `/subscription/plans` publishes `billing` and Pricing renders "coming soon" rather than a button that answers 503
- [x] M-09 / M-10 — both UIs notice when the session has actually ended
- [x] L-05 — orphaned `.incoming-*` files swept by the housekeeping pass that already runs
- [x] L-01, L-02, L-03, L-08, L-09 — re-read on this base and all five fixed.
      The re-read earned its place: `/verify-email` had **no limiter at all**
      here rather than one in the wrong order, and half of L-02 had already been
      fixed on `main` — by correcting the comment to match the code, which left
      the half that mattered untouched
- [ ] O-01, O-02 — the two hPanel cron entries **(owner action — cannot be done over SSH)**

**Phase 5 is done.** Everything that can be changed in this repository has
been. O-01 and O-02 are the only findings left and neither is a code change:
they are cron entries in Hostinger's control panel, which has no SSH or API
route in. The scripts they would run — `daily-maintenance.sh` and
`run-api.sh` — are deployed and working; nothing is scheduling them.

## Deploying this base

Not a routine deploy, because production is running the other lineage. Two
things were checked before planning it, and both came back clean.

### The environment — nothing to add before the deploy

`main` reads twelve settings the deployed lineage never did
(`ACCESS_TOKEN_TTL`, `ADMIN_2FA_REQUIRED`, `AD_EVENT_SECRET`, `AI_MODEL`,
`ANTHROPIC_API_KEY`, `LICENSE_AUTO_SUSPEND`, `LOGIN_LOCKOUT_MINUTES`,
`LOGIN_LOCKOUT_THRESHOLD`, `PASSWORD_BREACH_CHECK`,
`PASSWORD_BREACH_TIMEOUT_MS`, `SECURITY_ALERT_EMAIL`,
`TURNSTILE_FAIL_CLOSED`). **Every one has a default**, so none of them can
fail the boot — which was the worry, because `config/env.js` collects its
problems and refuses to start rather than running degraded. The hard
requirements themselves (the four JWT secrets, `MYSQL_PASS`,
`ROOT_ADMIN_EMAIL`, `SMTP_HOST`, HTTPS origins, `ADMIN_ALLOWED_IPS`,
`TRUST_PROXY`) are the same set the live `.env` already satisfies.

Three of those defaults change behaviour on a live deployment, and only the
first needs anyone to do anything:

- **`ADMIN_2FA_REQUIRED` defaults to ON** for any hardened deployment. Until
  an admin enrols an authenticator, every panel route but `/me`, `/logout`
  and the `/2fa` enrolment routes answers `403 TWO_FACTOR_REQUIRED` and the
  SPA parks them on the Security screen. That is the intended posture, but it
  means **the creator and every staff admin must enrol immediately after the
  deploy**, in the same session they sign in again for H-08.
- **`PASSWORD_BREACH_CHECK` defaults to ON** — sign-up and reset call
  api.pwnedpasswords.com with a 2.5 s timeout. It **degrades open**: a
  failure logs `[password] breach check skipped` and the password is
  accepted, so a host that cannot reach the internet costs latency, not
  sign-ups.
- **`LICENSE_AUTO_SUSPEND` defaults to ON.** The thresholds are far above
  anything a customer produces — 30 devices per seat plus a flat allowance of
  3, or 20 new devices inside the window — so a one-seat licence needs 33
  distinct machines before it suspends. Left on.

### The migration — runs clean over a production-shaped database

`test/tools/migrate-check.js` builds a database with the deployed lineage's
`initSchema`, runs this base's over the top, builds a second from nothing and
diffs them. It succeeds: the eight new tables are created and every rotation
column is added to `user_sessions`. Three columns differed; two were fixed
(`user_sessions.created_at` / `last_used_at` retyped from TIMESTAMP to
DATETIME) and one is documented and left (`users.totp_last_step` signed
rather than unsigned — a table rewrite for a value that cannot reach either
limit). `user_sessions.realm` stays as an unread column with a default. Run
against itself the tool reports no drift at all, so the migration is
idempotent.

### Phase 5 deployed — 2026-09-23

Backed up first to `nexa-data/pre-phase5-20260923-032918/` (verified dump plus
tarballs of `nexa-api/` and `public_html/`). CI was green on all three jobs
before it went — backend 3 m 7 s on MariaDB 11.8 — and the API came back on the
pinned Node 22 with `[db] schema initialized`.

**One thing was checked before deploying rather than after**, because it could
have stopped mail entirely: M-11 makes `requireTLS` a refusal to send, so the
production relay was probed from the server first. `smtp.gmail.com:587`
advertises STARTTLS in its EHLO response, so the new setting costs nothing
here. A relay that did not would have needed the finding rethought, not the
deploy rolled back at 3am.

Verified against the live site:

| | |
|---|---|
| **M-06** | `admin_ip_rules` created; `matchesEntry('103.157.248.0/24', …)` matches the owner's address and refuses the neighbouring block |
| **M-08** | `/api/subscription/plans` publishes `"billing":"disabled"` |
| **M-12** | `TEAM_INVITE_TTL_DAYS = 14` |
| **L-01** | `/api/auth/verify-email` answers 400 — route intact behind its new limiter |
| **L-02** | the honeypot's 400 now reads `fieldErrors: {}`; the trap does not name itself |
| **L-08** | `GET /api/nope%3Cscript%3E` → *"Route not found: GET"*, nothing reflected |
| **panel** | the served admin bundle carries *Who can reach the panels* |

The boot warning still names `ADMIN_ALLOWED_IPS=*` and no longer names
`ADMIN_2FA_REQUIRED`, which is correct: 2FA was put back on 2026-09-22 and the
IP gate is still deliberately open. See *Temporary loosenings*.

### The deploy — done 2026-09-22

Backed up first, to `nexa-data/pre-audit-on-main-20260922-151545/`: the
verified dump plus tarballs of `nexa-api/` and `public_html/`, which is a
rollback and not just a database one. Then
`deploy/build-and-upload.sh`, and the keepalive brought the API up on the
pinned Node 22 at 15:22:01Z:

```
[run-api] 2026-09-22T15:22:01Z starting API with …alt-nodejs22…/node (v22.22.0)
[db] schema initialized
[server] NDM backend listening on 127.0.0.1:3001 (NODE_ENV=production, public deployment, production checks ON)
```

Checked live, against production:

- **The migration landed as `migrate-check.js` predicted.** All eleven new
  tables exist (`security_events`, `device_codes`, `device_tokens`,
  `rate_limits`, `stripe_webhook_events`, `used_id_tokens`, `audit_logs`,
  `faq_votes`, `ad_event_nonces`, `license_email_deliveries`,
  `license_token_rejections`); `user_sessions` has `family` and
  `prev_token_hash`; `created_at`/`last_used_at` are now `datetime`, so the
  drift fix ran on the real database; `realm` is still there, unread, as
  documented.
- **M-07 is enforced by the database**: `uq_subscriptions_user (user_id)`.
- **H-06 at the origin, bypassing the CDN**: count 683 before, `HEAD` → 200,
  count 683; `Range: bytes=0-0` → 206, count 683. Neither counts.
- **M-05 is real in production**: signing in as an address that does not
  exist took **1.09 s** — a full bcrypt, not the early return that used to
  answer in under 2 ms.
- `POST /auth/refresh` with no cookie → `401 NO_REFRESH_TOKEN`; a protected
  route with no bearer → `401 UNAUTHORIZED`. No 500s on either.
- Both SPA bundles are the ones just built (`index-BcXmwx86.js`,
  `index-BC7zJvrk.js`) and both carry `/api` — the admin through its
  `BASE_URL` const, which is why a `baseURL:"…"` grep finds nothing there.
- `exposeStackTraces = false` (M-04), and **zero** `breach check skipped`
  lines, so HIBP is reachable from this host.

**Two things the deploy turned up about the creator's account:**

1. `ADMIN_2FA_REQUIRED` is now `true`, as expected — and it locks nobody out,
   because the one `root` account already has an authenticator enrolled and
   there are **no staff admins**. The `TOTP_ENCRYPTION_KEY` did not change, so
   that enrolment still decrypts. The creator does have to **sign in again**
   (H-08: `token_version` moved).
2. `totp_recovery` is `[]` — **the creator has no recovery codes at all.** Not
   legacy ones; none. With `ADMIN_2FA_REQUIRED` on and no second route in,
   losing that authenticator locks the panel permanently. `POST
   /api/root/2fa/recovery-codes` is live (it answers 401, not 404), so the fix
   is one signed-in call — but until M-14 lands there is no path back if the
   authenticator is lost first.

---

# Change log

| Date | Change |
|---|---|
| 2026-09-19 | Initial audit. 31 findings across backend, frontend, admin panel and deployment. |
| 2026-09-19 | Stood up MariaDB 11.8.9 for the tests (O-03a). Baseline run exposed H-07 (release-version check unwired) and two stale tests (T-01, T-02); H-06 confirmed empirically. 34 findings. |
| 2026-09-19 | O-03b: `test/tools/testdb.sh` checked in and verified from a cold start. |
| 2026-09-19 | **Phase 1 done** — H-01, L-04, H-02 fixed and verified (201 tests, 188 pass, no new failures). Opened M-14, M-15, L-10. 37 findings, 3 fixed. |
| 2026-09-19 | Phase 2's adversarial review surfaced H-08: `requireAuth` never checks `user_sessions`, so every "revoke sessions" action is a no-op for the 7-day life of the access token. Blocks M-01. 38 findings. |
| 2026-09-20 | **Phase 2 done** — H-05, H-03, M-02, M-03 fixed; M-01 fixed as far as a route can be (access-token half waits on H-08). Password change moved to `POST /auth/change-password`. 252 tests / 239 pass. 7 fixed. |
| 2026-09-20 | **Phases 1–4 deployed to production** with `deploy/build-and-upload.sh` after a verified backup. Two deploy-script bugs found on the way and fixed (`c30cfd9`): the MSYS runtime turned `VITE_API_URL=/api` into `C:/Program Files/Git/api` inside the bundle, and the Cygwin rsync could not take Git Bash paths or spawn its ssh. Live checks: health up, all three migrations present, auth/refresh/gate answers as specified, counter honest at the origin (CDN HEAD caveat under H-06), new site + admin bundles with `/api` and the Google client ID. Admins must sign in once more (H-08). |
| 2026-09-20 | Deploy prep: production checked for duplicate subscriptions (none) and `uq_subscriptions_user` added (M-07 closed fully); the deployed `backup.sh` found broken twice over (CRLF from the Windows checkout, and `/dev/fd` under CageFS) and fixed — first verified backup since 09-13. |
| 2026-09-20 | **Phase 3 code done** — O-03c: `website.yml` runs the backend suite against MariaDB 11.8 on every branch, with the skip guard reading the summary counts. First run refused by GitHub Actions billing on the account (owner action); the finding stays IN PROGRESS until a run is green. |
| 2026-09-20 | **Phase 4 done** — H-08 (all three realms' sessions in one table, every bearer bound to its row, 15-min TTL), H-06, H-07, H-04, M-01, M-04, M-07, M-13, L-07, T-01, T-02. Found on the way: `invoice.payment_failed` threw on every real event. **288 / 288, 0 skipped** — first green run. 18 fixed, 20 open; every High closed. |
| 2026-09-22 | **Phase 4.5 — re-based onto `main`.** The audit ran on the lineage production uses; `main` was 63 commits ahead with none of it live. `main` became the base and the audit's fixes were ported onto it, one finding per commit, each verified against MariaDB 11.8.9. Seven findings turned out to be fixed on `main` already (H-05, M-01, M-02, M-13, L-06, most of H-04, the customer half of H-08) and were left alone; two the audit had called FIXED were only half-fixed here (the panel gates never checked the token generation; `customer.subscription.created` was ignored) and are now closed with tests that fail without them. M-05 was fixed while in the same files. One new defect found by running the suite twice: `srv.reset()` never truncated `faq_votes` or `license_token_rejections`, so those suites passed only on a virgin database — invisible for as long as the integration tests were skipping themselves. **532 / 532, 0 skipped, repeatable.** 21 fixed, 17 open. |
| 2026-09-23 | **M-15 fixed, prompted by the creator asking how to get recovery codes back.** They had enrolled, been shown the set once and closed the page; the answer from the panel was that they could not. `totp_recovery` was `[]` with `ADMIN_2FA_REQUIRED` on — one lost phone from a permanently locked panel, and no account above the creator to reset it. The endpoint had shipped with H-02; only the UI was missing. Security.jsx now carries a regenerate action, a red warning when the count is zero (worded differently for the creator than for a staff admin), the legacy-hash warning the finding was originally about, and honest lost-device copy. Two tests added for the case the existing three stepped over: regenerating from an EMPTY set on the authenticator alone, and a wrong password still refused there. 41 findings, 26 fixed, 15 open. |
| 2026-09-23 | **Phase 5 finished.** M-08 turned out to be already done on `main` (checked, not assumed). L-05 got a sweeper in the housekeeping pass that already runs. The five deferred Low findings were re-read on this base first, which earned its place twice: `/verify-email` had **no limiter at all** here rather than one in the wrong order, and half of L-02 had been fixed on `main` by correcting the comment to match the code — leaving the half that mattered, a 400 naming the honeypot field. Also corrected three Status lines that still said OPEN while their own bodies said FIXED, and an Operational row that had its open and fixed counts the wrong way round. **41 findings, 39 fixed, 2 open** — and both of those are hPanel cron entries only the owner can add. Backend 575 / frontend 61, 0 fail, 0 skipped. |
| 2026-09-23 | **M-11 and M-12.** SMTP now requires STARTTLS with a TLS 1.2 floor — it was not merely "might not encrypt" but a silent downgrade, since stripping the capability from the greeting sent the relay password, every reset token and every licence key in the clear with nothing logged. A relay on loopback is exempt, checked exactly, because an earlier draft of that check would have exempted `127.evil.com`. Team invitations expire after `TEAM_INVITE_TTL_DAYS` (14), enforced on the model because two routes read a token and a rule in one of them is the same bug with an extra step. Adding expiry had an unwanted half worth naming: an expired invite would have held a seat for ever, quietly turning a five-seat team into a four-seat one, so it no longer counts toward `used` and the roster shows it as dead. 41 findings, 32 fixed, 9 open. |
| 2026-09-23 | **Phase 5 half done.** M-15 (recovery codes had no way back), M-14 (`npm run reset-2fa`, after the creator was locked out for real), M-06 (CIDR + IPv6 matching, and the allow-list moved into the creator panel behind a lock-out guard), M-09 and M-10 (both UIs kept rendering signed-in over a dead session; one event each, one place that decides what signed-out means). Two of those were found by the owner hitting them rather than by reading code, which is the honest way to say why they were rated Medium and should have been higher. Backend 560 / frontend 61, 0 fail, 0 skipped. 41 findings, 30 fixed, 11 open. |
| 2026-09-23 | **O-03 closed — a green CI run.** Run `35775527617`: backend 3 m 21 s on MariaDB 11.8, `tests 533 / pass 533 / fail 0 / skipped 0` with the guard reading those counts back, `found 0 vulnerabilities` from the production audit, frontend 24 s, admin 17 s. Four attempts: two refused before any job started (private repository, billed minutes), then two that ran and each found a real defect — T-03, then T-04 and T-05. The finding that said the integration tests never actually run is now a workflow that runs them on every push, and it paid for itself three times before it first went green. 41 findings, 25 fixed, 16 open. Phase 5 has 16 left, two of them owner-only. |
| 2026-09-23 | **The second CI run got past the hang and found two more.** With T-03 fixed the backend job ran for real — 4 m 25 s — and failed cleanly rather than hanging, which was the point of the timeouts. It failed on seven tests in two files, and neither was a flake. **T-04**: a single missing `});` in `test/googleAuth.test.js` had quietly nested five tests inside another one, so Node 22 cancelled them without running them — wrong issuer, expired token, unverified email, `alg=none`, key rotation and caching, no-client-ID, malformed credential. They pass on Node 24, which is why this machine never noticed; CI pins Node 22 because production runs it. **T-05**: the HIBP slow-path fake returned a promise that could only settle on `AbortSignal.timeout()`, whose timer is unref’d and does not hold the event loop open, so the runner could resolve out from under it. Both fixed and verified; a sweep confirms no other test file nests a column-0 `test(`. 41 findings, 24 fixed. |
| 2026-09-22 | **CI ran for the first time, and found something.** The repository was made public, so the jobs were allowed to start (run `35747534001`). Frontend and admin green in 25 s and 14 s; the backend job printed `ok 65` and then hung — it would have burned GitHub's six-hour ceiling on a billed runner. Cause reproduced locally before fixing: `durableLimiter.test.js` documents itself as testing the in-memory fallback but never ensures one, so CI's job-level `MYSQL_*` sent it down the MySQL path instead, and the pool it opened kept the process alive while `node --test` waited for it. Opened and fixed as **T-03** — an `after()` that ends the pool, a `before()` that truncates `rate_limits` so the table-backed store starts from a clean budget, and an honest docblock. All three jobs given `timeout-minutes`. 39 findings, 22 fixed. |
| 2026-09-22 | **`audit-on-main` pushed and deployed to production.** 15 commits pushed; the `website` workflow fired and was refused by GitHub Actions billing again (run `35745664153`, all three jobs, no step run) — the repository still reports `PRIVATE`, so O-03 stays IN PROGRESS. The deploy itself went clean after a verified full backup: schema initialized, and H-06, M-04, M-05, M-07 and both SPA bundles verified against the live site (see *The deploy*). One deploy-script bug on the way: the `baseURL` assertion added last time matched only a double-quoted literal, and Vite 8 minifies it to a backtick template, so a correct bundle failed the check. Found the creator has **no recovery codes** (`totp_recovery` = `[]`) while `ADMIN_2FA_REQUIRED` is on — see M-14. |
| 2026-09-22 | **Deploy prerequisites cleared.** Rebased onto `origin/main` @ `5de449b` (the tip had moved nine commits; none of them touch anything this port changes) — 533/533. Checked the twelve settings `main` reads that the live `.env` has never had to satisfy: all defaulted, none can fail the boot, and three change behaviour (`ADMIN_2FA_REQUIRED` on, which the creator and every staff admin must act on at the deploy; `PASSWORD_BREACH_CHECK` on and degrading open; `LICENSE_AUTO_SUSPEND` on with thresholds no customer reaches). Checked the migration by running it: `test/tools/migrate-check.js` builds a production-shaped database, migrates it and diffs against a fresh one. It runs clean; two TIMESTAMP columns were retyped to DATETIME as a result and two harmless leftovers are documented. |
