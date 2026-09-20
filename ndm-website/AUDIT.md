# Nexa Download Manager — Website Audit

Full-surface review of the website: Express/MySQL backend, React site, and the
admin + root control panels. Every finding below was reached by reading the code
and, where possible, confirmed against the live deployment or a test run. The
evidence for each one is recorded so nothing has to be re-derived later.

- **Audit started:** 2026-09-19
- **Branch:** `windows-fixes-v3` @ `40980ed`
- **Scope:** `ndm-website/backend` (8,495 LOC), `ndm-website/frontend` (7,767 LOC), `ndm-website/admin` (30 files)
- **Live target:** https://nexadownloadmanager.com (NODE_ENV=production, billing `disabled`)

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

## Scoreboard

| Severity | Count | Open | Fixed |
|---|---|---|---|
| High | 8 | 4 | 4 |
| Medium | 15 | 13 (1 in progress) | 2 |
| Low | 10 | 9 | 1 |
| Test debt | 2 | 2 | 0 |
| Operational | 3 | 3 (1 in progress) | 0 |
| **Total** | **38** | **31** | **7** |

Baseline at audit time: backend unit tests **86/86 pass**; full backend suite
**95 pass / 5 skipped** with no database; frontend **23/23 pass**; admin +
frontend ESLint clean; admin production build reproduces the committed `dist`
hashes exactly.

Baseline against a real database (MariaDB 11.8.9 — the production version — on
`127.0.0.1:3399`, clean checkout of `40980ed`): **181 tests, 168 pass, 13 fail,
0 skipped**. Every failure is either a confirmed defect (H-06 ×3, H-07 ×3) or a
test that predates a deliberate contract change (T-01, T-02). See O-03.

After Phase 1: **201 tests, 188 pass, 13 fail, 0 skipped** — 20 new tests, and
the failures are byte-for-byte the same eight leaves as the baseline. No
regressions.

After Phase 2: **252 tests, 239 pass, 13 fail, 0 skipped** — 51 more tests
(three new integration suites drive the real endpoints), same eight leaves.
Frontend 23/23, ESLint clean.

---

# HIGH

## H-01 — `GET /api/admin/users/:id/details` hands a staff admin the creator's credential material

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/userView.test.js` (7 new tests) + full suite 188 pass / 0 new failures

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

**Status:** OPEN &nbsp;|&nbsp; **Verified by:** —

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

**Status:** OPEN &nbsp;|&nbsp; **Verified by:** —

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

**Status:** OPEN &nbsp;|&nbsp; **Verified by:** —

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

**Status:** OPEN &nbsp;|&nbsp; **Verified by:** —

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

**Status:** IN PROGRESS — the route does everything a route can; the remaining half is H-08 &nbsp;|&nbsp; **Verified by:** `test/passwordChangeSessions.integration.test.js` (11 tests, two independent cookie jars)

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

**Not done, and not doable from this route:** the other browser's *access
token* keeps working until it expires — see H-08. The suite pins that gap on
purpose (`KNOWN GAP: the revoked browser keeps its access token`) so the day
H-08 lands, the assertion flips.

`/api/auth/reset-password` correctly calls `UserSession.removeAllForUser(user.id)`
and comments that a reset signs you out everywhere. `PUT /api/user/profile`,
which is the other way to change a password, does not. Someone who suspects
their account is compromised and changes their password from the profile page
leaves the attacker's session alive for its full 30 days.

**Blocked by H-08.** Deleting the session rows does not end the other browser's
access — `requireAuth` never looks at `user_sessions`, so a 7-day access token
outlives the revocation. This finding cannot be closed on its own.

## M-02 — Password-reset tokens stay valid after use

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/jwt.test.js` (+5), `test/authResetBan.integration.test.js` + full suite

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

**Status:** OPEN &nbsp;|&nbsp; **Verified by:** —

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

**Status:** OPEN &nbsp;|&nbsp; **Verified by:** —

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

**Status:** OPEN &nbsp;|&nbsp; **Verified by:** —

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

**Fix:** support CIDR ranges and IPv6 in `ipAllowed()`.

## M-07 — Duplicate subscriptions are possible and stale licence keys never die

**Status:** OPEN &nbsp;|&nbsp; **Verified by:** —

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

**Status:** OPEN &nbsp;|&nbsp; **Verified by:** —

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

## M-09 — The admin panel keeps rendering as signed-in after its session dies

**Status:** OPEN &nbsp;|&nbsp; **Verified by:** —

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

## M-10 — A failed site refresh leaves a stale "signed in" marker

**Status:** OPEN &nbsp;|&nbsp; **Verified by:** —

**Where:** `frontend/src/api/client.js`

On refresh failure the interceptor calls `clearAccessToken()` but does not clear
the readable `ndm_session` hint cookie or reset `AuthContext` state. `logout()`
clears the hint; the interceptor does not. The UI can therefore show a
signed-in header with no usable token, and the next page load still believes
there may be a session.

## M-11 — SMTP does not require TLS

**Status:** OPEN &nbsp;|&nbsp; **Verified by:** —

**Where:** `backend/src/utils/email.js:24`

```js
secure: config.SMTP_PORT === 465,
```

That is the only transport security setting. On the default port 587 nodemailer
will use STARTTLS *if offered* and otherwise continue in plaintext, sending
`SMTP_USER` and `SMTP_PASS` in the clear. `requireTLS: true` is missing.

## M-12 — Team invitations never expire

**Status:** OPEN &nbsp;|&nbsp; **Verified by:** —

**Where:** `backend/src/routes/team.js`, `backend/src/models/TeamMember.js`

`team_members.invited_at` is recorded but never read. An invite link works
forever until the owner deletes the row or resends (which rotates the token). A
year-old forwarded invitation still joins the team.

The address check on accept is sound — only the invited address may accept — so
this is a staleness problem rather than a takeover.

## M-14 — The creator cannot recover from a lost authenticator

**Status:** OPEN &nbsp;|&nbsp; **Verified by:** —

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

**Fix:** either let `createRoot.js` clear `totp_*` for the configured
`ROOT_ADMIN_EMAIL` (a shell on the box is already full control, so this grants
nothing new), or add a `npm run reset-root-2fa` script that does only that and
says loudly what it did. Do this **before** relying on the legacy retirement.

## M-15 — The panel does not surface any of the new recovery-code migration state

**Status:** OPEN &nbsp;|&nbsp; **Verified by:** —

**Where:** `admin/src/pages/Security.jsx`

H-02 added `recoveryCodesLegacy` to `GET /<realm>/2fa` and a
`POST /<realm>/2fa/recovery-codes` endpoint, precisely so an admin sitting on
pre-bcrypt codes can be told and can fix it. `Security.jsx` reads
`state.recoveryCodesLeft` and never reads `recoveryCodesLegacy`; nothing calls
the regenerate endpoint. The server-side migration path therefore exists with no
way to drive it from the UI, and an account whose legacy codes were just retired
sees only "0 recovery codes left" with no explanation and no button.

**Fix:** a warning row when `recoveryCodesLegacy` is true, a "Generate new
recovery codes" action posting password + code to `/2fa/recovery-codes`, and the
same one-time display the enable flow already has.

## M-13 — Five routes read `:id` from the URL with no schema validation

**Status:** OPEN &nbsp;|&nbsp; **Verified by:** —

Everything else in the codebase validates params with a zod schema. These five
call `Number(req.params.id)` directly, so `NaN` reaches the model layer:

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

**Status:** OPEN

`backend/src/routes/auth.js`. Every other auth route mounts the limiter *after*
`validate()` and says why in a comment: "a request that fails its schema costs
no auth quota". `/verify-email` is the exception, so malformed bodies burn the
verify-email budget.

## L-02 — The contact-form honeypot does not behave as documented

**Status:** OPEN

`backend/src/schemas/contact.schema.js`. The comment promises "a bot that fills
every field gets a polite 200 and nothing is sent". In practice
`website: z.string().max(0)` makes a filled honeypot a `400 VALIDATION_ERROR`
whose `details.fieldErrors.website` names the trap — which tells the bot exactly
what caught it and how to avoid it next time.

## L-03 — The account export is wrapped in the API envelope

**Status:** OPEN

`backend/src/routes/user.js` (`GET /export`). The file downloads as
`nexa-account-<id>.json` but contains `{"ok":true,"data":{…}}` rather than the
export document itself.

## L-04 — `GET /api/user/me` returns `totp_secret` and `totp_recovery`

**Status:** FIXED &nbsp;|&nbsp; **Verified by:** `test/userView.test.js`

`backend/src/routes/user.js:24` (`sanitizeUser`) stripped four fields and missed
these two. The values are ciphertext and hashes rather than plaintext, so this was
exposure rather than compromise — but for an admin account it handed the
second-factor material to anything that can read one API response. Same root
cause as H-01: a deny-list where an allow-list belongs, and fixed by the same
`publicUser` projection.

## L-05 — Interrupted uploads leave orphaned temp files

**Status:** OPEN

`backend/src/utils/releaseFiles.js`. `storeUpload` writes `.incoming-<uuid>` and
renames on success. A process death mid-upload leaves a partial file —
potentially hundreds of MB — in `RELEASE_UPLOAD_DIR` forever. There is no
sweeper.

## L-06 — `strongPassword` only enforces a minimum length

**Status:** OPEN

`backend/src/schemas/auth.schema.js`. Despite the name it is
`z.string().min(8)`: no maximum, no complexity rule, no common-password check.
The same rule governs admin and root passwords set from the panels.

## L-07 — The download counter also inflates on HEAD and on a missing file

**Status:** OPEN — folded into H-06

## L-08 — `notFound` reflects the raw request URL

**Status:** OPEN

`backend/src/middleware/errorHandler.js`. Confirmed live:
`GET /api/nope%3Cscript%3E` → `"Route not found: GET /api/nope%3Cscript%3E"`.
The content type is `application/json`, so this is not browser-exploitable; it is
input reflection worth removing rather than a vulnerability.

## L-10 — "Member since" is always blank on the profile page

**Status:** OPEN

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

**Status:** OPEN

`backend/src/utils/email.js` (`sendContactMessage`). `topic` and `name` go
straight into the `Subject`. Nodemailer encodes headers, so this is not
injectable today; the input is simply not newline-stripped at the edge.

---

# TEST DEBT

Tests that assert a contract the code has since — deliberately — moved away
from. They only became visible once the integration suite could run (O-03).
Each needs rewriting to pin the *current* behaviour, not deleting.

## T-01 — `rejects a duplicate email` asserts the account oracle that was removed

**Status:** OPEN

`backend/test/api.integration.test.js:42` expects a second registration with a
taken address to answer `>= 400`. `/api/auth/register` now deliberately answers
`201 { registered: true }` either way — that is the account-enumeration fix
recovered in `9f312a2` — and the test was never brought along.

**Rewrite:** both registrations answer `201`; exactly one `users` row exists for
the address afterwards; the second call must not open a session or change the
first account's password hash.

## T-02 — `auth endpoints stop brute force after 5 attempts` asserts the old shared bucket

**Status:** OPEN

`backend/test/rateLimit.integration.test.js:18` expects a `429` after five login
attempts. WP-08 split the budgets: login is now **30 per 15 min per IP**, with a
per-**account** slowdown (100 → 2000 ms) instead of a refusal. Seven attempts
therefore get seven `401`s, which is the intended behaviour.

**Rewrite:** (a) 31 attempts against *distinct* addresses from one IP → the
31st is `429 RATE_LIMITED` (distinct addresses so the per-account delay does not
make the test take a minute); (b) repeated failures against *one* address get
measurably slower (`loginDelayFor` steps) and a successful sign-in clears the
delay.

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

**Status:** IN PROGRESS &nbsp;|&nbsp; **Verified by:** `npm test` at `40980ed` on MariaDB 11.8.9 → 181 tests, 0 skipped

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

**Remaining for FIXED:** a checked-in script that stands the database up the
same way on any machine (the throwaway used here lives outside the repo), a
README section for it, and a CI job so the suite runs on every push.

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

# Fix plan

Ordered so that each phase is independently shippable and verifiable. Nothing
moves to `FIXED` until the `Verified by` field names a test or a live check.

### Phase 1 — Credential exposure  &#9745; **DONE 2026-09-19**
Closes the one chain that leads to a full account takeover.
- [x] H-01 — allow-list `safeUser` in `admin.js` and `root.js`; guard `/users/:id/details`
- [x] L-04 — allow-list `sanitizeUser` in `user.js` (same change, same reason)
- [x] H-02 — full-entropy recovery codes + bcrypt at rest
- **Verified:** `test/userView.test.js` (7 tests) pins that no secret column, no
  `*_hash` key and no future-added column survives the projection; `test/totp.test.js`
  extended for entropy, shape, bcrypt-at-rest, legacy consumption and corrupt-row
  handling. Full suite **201 tests / 188 pass**, the 13 failures identical to the
  pre-Phase-1 baseline.
- **Opened:** M-14, M-15 (both consequences of the legacy-code retirement).

### Phase 2 — Enforcement gaps  &#9745; **DONE 2026-09-20** (H-08 carried forward)
Things that are supposed to stop someone and do not.
- [x] H-05 — `banned` check in `/auth/login`
- [x] H-03 — `banned` check in licence validate + heartbeat; Team key rotation for a banned member
- [ ] H-08 — make session revocation actually revoke access **(blocks the second half of M-01; moved to Phase 4)**
- [x] M-01 — `POST /auth/change-password`: sessions revoked, caller kept — the access-token half waits on H-08
- [x] M-02 — single-use reset tokens (`pv` claim + conditional write)
- [x] M-03 — single-use TOTP and recovery codes (conditional spends)
- **Verified:** three new integration suites drive the real endpoints —
  `authResetBan`, `licenseBan`, `passwordChangeSessions` — plus `jwt.test.js`
  and `totp.test.js` extended with race tests. Full suite **252 tests / 239
  pass**, same eight pre-existing failures. Also fixed on the way:
  `/auth/reset-password` now clears `root_refresh_token_hash` too (it cleared
  only two of the three slots), and CONTRACT.md documents every new contract.
- **Opened:** H-08.

### Phase 3 — Test infrastructure  &#9744;
Do this early: Phases 2, 4 and 5 cannot be properly verified without it.
- [x] O-03a — a reachable database for the test run (portable MariaDB 11.8.9 on :3399; 0 skipped)
- [x] O-03b — `backend/test/tools/testdb.sh` + a README section, run end-to-end from a cold start
- [ ] O-03c — CI job running `npm test` with a database service
- **Verify:** `npm test` reports 0 skipped, on a second machine or in CI.

### Phase 4 — Correctness  &#9744;
- [ ] H-08 — session-bound access tokens (then flip the `KNOWN GAP` assertion in `passwordChangeSessions`)
- [ ] H-06 — wire up `shouldCountDownload`; stop counting HEADs and 404s
- [ ] H-07 — wire up `artifactVersionFromFile` in the upload route
- [ ] T-01, T-02 — rewrite the two stale tests to the current contracts
- [ ] H-04 — handle `invoice.payment_succeeded` and `customer.subscription.updated`
- [ ] M-07 — one subscription per user; reconcile the two admin write paths
- [ ] M-04 — drop `sqlMessage` from production responses
- [ ] M-13 — zod schemas on the five unvalidated `:id` params
- **Verify:** `downloadCounter` and `releaseVersionInvariant` integration suites pass for real; new webhook renewal test; full suite 0 fail / 0 skipped.

### Phase 5 — Hardening and operations  &#9744;
- [ ] M-14 — a way for the creator to recover from a lost authenticator **(do this before trusting H-02's legacy retirement)**
- [ ] M-05 — constant-time panel login; handle a null password hash
- [ ] M-06 — CIDR + IPv6 in `ipAllowed`
- [ ] M-11 — `requireTLS: true` on SMTP
- [ ] M-12 — expiry on team invitations
- [ ] L-05 — sweep orphaned `.incoming-*` files
- [ ] L-06 — a real password policy
- [ ] O-01, O-02 — the two hPanel cron entries **(owner action — cannot be done over SSH)**
- **Verify:** live check that a backup lands overnight and that the API comes back after a restart.

### Phase 6 — UX and polish  &#9744;
- [ ] M-08 — publish `billingMode`; make Pricing honest about it
- [ ] M-09 — admin panel bounces to login when its session dies
- [ ] M-10 — clear the session hint when a refresh fails
- [ ] M-15 — Security page: surface `recoveryCodesLegacy` + a regenerate action
- [ ] L-10 — "Member since" reads the wrong key
- [ ] L-01, L-02, L-03, L-08, L-09
- **Verify:** frontend tests for the signed-out transition; manual pass over Pricing with billing disabled.

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
