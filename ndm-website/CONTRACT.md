# NDM Backend — CONTRACT (single source of truth)

Every agent working on the backend reads this file first. The **foundation**
(config, models, schemas, middleware, utils, app.js, server.js) is already built
and OWNED by the foundation. Route agents only fill in route handler bodies.

---

## 1. Module system + folder layout

**CommonJS** everywhere (`require` / `module.exports`). JavaScript only. Node >= 18.

```
backend/
  .env.example  .env  .gitignore  package.json
  src/
    config/      env.js  db.js  plans.js
    models/      User.js  Subscription.js  Payment.js  Review.js  Release.js StripeEvent.js
    schemas/     auth.schema.js  user.schema.js  subscription.schema.js
                 license.schema.js  review.schema.js  admin.schema.js  root.schema.js  release.schema.js
    middleware/  validate.js  auth.js  adminAuth.js  rateLimiter.js  errorHandler.js
    utils/       asyncHandler.js  respond.js  jwt.js  email.js  license.js  stripe.js
                 releaseFeed.js
    routes/      auth.js  user.js  subscription.js  license.js
                 reviews.js  releases.js  admin.js  root.js  webhooks.js
    scripts/     createAdmin.js  seed.js
    app.js  server.js
```

---

## 2. Response envelope

Use the helpers in `src/utils/respond.js`:

```js
const { ok, fail } = require('../utils/respond');
ok(res, data, status = 200);                 // → { ok:true, data }
fail(res, code, message, status = 400, details); // → { ok:false, error:{ code, message, details? } }
```

- **Success:** `{ ok: true, data }`
- **Error:** `{ ok: false, error: { code, message, details? } }`

### EXCEPTION 1 — `POST /api/license/validate`

This endpoint is consumed by the NDM **C++ app**, so it returns a LITERAL shape,
**NOT** the envelope:

```json
// valid
{ "valid": true, "plan": "pro", "expires": "2027-01-01T00:00:00.000Z", "token": "<15m Ed25519 jwt>", "trial": false }
// valid, signed in with an account (no licence key on the wire)
{ "valid": true, "plan": "pro", "token": "<15m Ed25519 jwt, sub:'user:7', acct:7>", "trial": false,
  "account": { "id": 7, "email": "owner@example.com", "name": "Owner" } }
// invalid
{ "valid": false, "reason": "expired", "trial": false }   // reason in not_found | expired | cancelled | banned | device_mismatch | seat_limit | signed_out | invalid
```

**A ban reaches the app.** `users.banned` is read with the key on every
`/validate` and `/heartbeat` (`Subscription.findByLicenseKeyForValidation`),
before status, expiry or trial state: a banned owner answers
`reason:"banned"`, which the client treats like any other terminal reason —
it drops the stored key and falls back to Free. Without it, banning locked the
website only and the desktop app went on collecting a fresh Pro token every
day. A banned account's `/release` still works on purpose: handing a seat back
is housekeeping, and a seat left pinned is one a colleague cannot take.

A **Team** licence is one key shared by the roster, and `/api/user/license`
hands a member the owner's key, so the banned person is usually not the row
that lookup reads. The request carries no user identity — a key and a device
fingerprint — so there is no device to single out. The shared secret is
withdrawn instead: the first validate or heartbeat after the ban drops the
banned members from `team_members`, rotates `license_key` and revokes every
seat (`Subscription.revokeBannedMembers`, one transaction). That request
answers `not_found`, because the key it sent no longer names anything;
everyone still entitled re-copies the new key from their dashboard, and the
banned member cannot, because the ban is what stops them signing in.

**The request carries exactly one credential**: `license_key` (manual activation)
or `device_token` (a machine signed in to an account — see `routes/device.js`).
Sending both, or neither, is a `400`. A device token resolves to the account's
subscription, or to the Team the account belongs to
(`utils/accountPlan.js#subscriptionForUser`), so a Team member never holds the
owner's key. The token's `sub` is then `user:<id>` rather than a key, and `acct`
names the account — the claim the app checks in place of the key comparison.
Always HTTP 200 with this body (even when `valid:false`) so the C++ client parses it cleanly.
`trial` is **always present**: `true` while the 7-day no-card Pro trial is running
(`subscriptions.trial_ends_at` in the future, no `stripe_subscription_id`), else `false`.
The handler calls `Subscription.current(sub)` first — lazy trial expiry, then lazy
paid-plan lapse — so a finished trial *and* a lapsed paid plan both validate as
`plan:"free"` (no cron).

**A period running out is never `expired`.** The desktop client deletes a key it is
told is expired, so a late renewal webhook used to cost the customer their licence.
`expired` and `cancelled` are now reserved for a licence somebody deliberately
stopped (`subscriptions.status`); everything that merely lapses falls back to Free
with a working key. `utils/license.js#PAID_GRACE_DAYS` (3) is the window that
absorbs a slow or retried renewal before a plan counts as lapsed.

**`signed_out` is the only reason a signed-in app throws its credential away.**
It means *this machine* is no longer connected (its token was revoked from the
dashboard, replaced, or presented by a different machine). A plan that merely
stopped answers `cancelled`/`expired`, and the app stays signed in on Free so a
renewal reaches it with nothing for anyone to re-enter — the account equivalent
of the rule above.

### EXCEPTION 2 — `GET /api/releases/feed?os=windows|linux`

Update feed polled by the desktop app. LITERAL body, never the envelope:

```json
// HTTP 200, Cache-Control: public, max-age=300
{ "version": "0.1.0", "url": "https://<PUBLIC_API_URL>/api/releases/download/windows",
  "notes": "<changelog>", "sha256": "<64 hex or empty string>",
  "publishedAt": "2026-08-01T12:34:56.000Z", "signature": "<base64url Ed25519>" }
// HTTP 404 — no latest release, or no artifact URL for that OS
{ "error": "no_release" }
```
`url` points at the **counting redirect** (`GET /api/releases/download/:os`, built from
`config.PUBLIC_API_URL`, which defaults to `FRONTEND_URL`) so app-driven downloads are
counted. `sha256` is `""` when the admin has not recorded a checksum — never fabricated.
Shaping lives in the pure helper `utils/releaseFeed.js` → `buildFeed(release, os, baseUrl)`.

**`signature` is required, and the desktop app refuses a feed without a valid one.** It is an
Ed25519 signature (same key as licence tokens) over exactly:

```
nexa-update-v1\n<version>\n<url>\n<sha256>
```

This exists because the feed names an installer *and* the checksum it is verified against, and the
app then executes what it downloads — so whoever controls this response controls both halves and the
checksum alone proves nothing. `notes` and `publishedAt` are deliberately outside the signature, so a
changelog can be corrected without re-signing a release. Produced by `signFeed(feed, privateKey)`;
verified client-side by `feedSignatureValid()` in `src/core/UpdateChecker.cpp`.

Rollout order when changing this: **deploy the backend first** (older clients ignore the extra
field), then ship the client that requires it.

---

## 3. Authentication

Header: `Authorization: Bearer <token>`.

| Token | TTL | Secret | Signed by | Verified by |
|-------|-----|--------|-----------|-------------|
| user access | `ACCESS_TOKEN_TTL` (15m) *(CHANGED from 7d)* | `JWT_SECRET` | `signAccessToken(user)` | `verifyAccess` / `requireAuth` |
| admin | 8h | `JWT_ADMIN_SECRET` | `signAdminToken(user)` | `verifyAdmin` / `requireAdmin` |
| root (creator) | 4h | `JWT_ROOT_SECRET` | `signRootToken(user)` | `verifyRoot` / `requireRoot` |
| email verify | 1h | `JWT_SECRET` | `signEmailToken(user)` | `verifyEmailToken` |
| password reset | 1h | `JWT_SECRET` | `signResetToken(user)` | `verifyResetToken` |
| license | 15m | `LICENSE_JWT_PRIVATE_KEY` (Ed25519) | `signLicenseToken(payload)` | `verifyLicense`, **and the desktop app itself** |

The licence token is the odd one out: it is **Ed25519, not HMAC**, because the
desktop app verifies it locally against a public key compiled into the binary.
Everything the app gates on — `plan`, `features`, the `device` it was issued to,
`iat` — is inside that signature, so a fake licence server, a rewritten response
body, or a hand-edited settings file cannot manufacture a paid plan. Verification
pins the algorithm to `EdDSA`; accepting an HMAC algorithm would let anyone sign
a token using the published public key as the secret.

Its TTL matches `SEAT_LEASE_SECONDS`, and **`POST /api/license/heartbeat` re-issues
one on every beat**. That pairing is the point: the client re-validates only every
six hours, so without re-issuing it would spend most of a session holding an
expired token — which is why the TTL used to be 24h, and why a token captured from
a revoked licence stayed usable on plan-gated endpoints for a day. A beat has
already resolved the subscription and renewed the seat, so minting costs one
signature and cuts that window to 15 minutes.

**Refresh token:** opaque random string (CSPRNG, `generateRefreshToken()` →
`{ token, hash }`) in an **httpOnly cookie named `ndm_refresh`**. Only the
SHA-256 hash is stored — **one row per browser in `user_sessions`**
(`models/UserSession.js`), not a single column on the user *(CHANGED)*: a
person signed in on a laptop and a phone holds two independent sessions, and
the account page lists and revokes them (`GET/DELETE /api/user/sessions`).
`utils/session.js#issueSession(req, res, user)` creates the row, sets the
cookie (+ the `ndm_session` hint) and returns `{ token, user }`; every path
that opens a customer session goes through it (`/login`, `/login/2fa`,
`/google`, a password change).

`POST /api/auth/refresh` **rotates** the cookie on every use: the row's
`token_hash` becomes the new hash, the old one moves to `prev_token_hash` with
`rotated_at`, and the access token comes back short-lived (`ACCESS_TOKEN_TTL`,
15 minutes) so the cookie — not the bearer — is what carries the session.
**Replay detection:** presenting a hash that only matches `prev_token_hash`
means the token has been used twice. Within 30 seconds of the rotation that is
two tabs racing on one cookie jar and the newer cookie is simply re-sent;
after that it is a stolen cookie and **the whole `family` is revoked** —
the thief's copy and the victim's — and a `session.reuse_detected` security event
is recorded. `family` (random, fixed for the life of the browser session) is
what ties the rotated generations together. `User.revokeSessions` (password
change, role change, ban, admin revoke) revokes every row for the user and
bumps `token_version`, which also kills outstanding bearers.

The cookie flags come from **`utils/cookies.js`**
(`refreshCookieOptions(path, maxAge)`) — the one place they are decided, shared
by all three refresh cookies:
```js
res.cookie('ndm_refresh', token, refreshCookieOptions('/api/auth', 30 * 24 * 60 * 60 * 1000));
// = { httpOnly: true, secure: config.secureCookies, sameSite: 'strict',
//     path: '/api/auth', maxAge: 30 * 24 * 60 * 60 * 1000 }
```
`sameSite: 'strict'` *(CHANGED from `lax`)*: a refresh cookie is only ever
needed by XHR from our own page, and a same-site XHR carries it whatever link
the visitor arrived by; `lax` additionally sent it on cross-site top-level GETs,
which nothing needs. The non-httpOnly `ndm_session` hint stays `lax` on
purpose — it holds no secret and must survive a cross-site navigation so a
link from an email does not land a signed-in person on a page that thinks they
are signed out (`sessionHintCookieOptions`).

**Admin refresh token:** same scheme for the admin SPA, cookie **`ndm_admin_refresh`**,
hash stored on `User.adminRefreshTokenHash` (`users.admin_refresh_token_hash`, 64-char hex).
Set by `POST /api/admin/login`, rotated by `POST /api/admin/refresh`, cleared by
`POST /api/admin/logout` and by `POST /api/admin/users/:id/revoke-sessions`:
```js
res.cookie('ndm_admin_refresh', token, refreshCookieOptions('/api/admin', 8 * 60 * 60 * 1000));
```
The lifetime matches the 8h admin JWT; after a page refresh the SPA calls
`POST /api/admin/refresh` (cookie only, no bearer) to get a new `{ token }`, then
`GET /api/admin/me` for its identity.

**Root refresh token:** the same scheme again for the creator console, cookie
**`ndm_root_refresh`**, hash stored on `User.rootRefreshTokenHash`
(`users.root_refresh_token_hash`, 64-char hex), path `/api/root`, 4h lifetime.
Set by `POST /api/root/login`, rotated by `POST /api/root/refresh`, cleared by
`POST /api/root/logout`. Because the cookie paths differ (`/api/admin` vs
`/api/root`), a staff session and a creator session coexist in one browser
without either being able to act as the other.

### Two admin tiers

`users.role` is `ENUM('user','admin','root')`.

| | staff admin | root (creator) |
|---|---|---|
| Panel | `/admin` | `/root` |
| API | `/api/admin/*` | `/api/root/*` (**plus** all of `/api/admin/*`) |
| Gate | `requireAdmin` | `requireRoot` |
| Can manage customers, reviews, releases, ads | yes | yes |
| Can change any role | **no** | only via `/api/root/admins` |
| Can touch another control-panel account | **no** (403) | yes, except another `root` |
| Can read the full audit trail / delete accounts | **no** | yes |

**How a creator is minted:** never over HTTP. `npm run create-root` is the only
path. `requireRoot` demands `role === 'root'` **and** `email === ROOT_ADMIN_EMAIL`,
so a rogue `UPDATE users SET role='root'` is not sufficient on its own. Both
`JWT_ROOT_SECRET` and `ROOT_ADMIN_EMAIL` are fail-closed in production.

The two token families are cryptographically distinct, so a staff token — even
one whose payload claims `role:'root'` — fails signature verification against
`JWT_ROOT_SECRET` and is rejected `401 INVALID_TOKEN`, not 403.

### Request shapes after middleware
- `req.user` — MySQL user row (set by `requireAuth`). Use `req.user.id`, `.email`, `.role`.
- `req.admin` — MySQL user row (set by `requireAdmin`); `role === 'admin'`, or `'root'`
  when the creator is using a staff screen.
- `req.isRoot` — `true` only when the request carried a **root-family** token.
  Route guards use this to let the creator through checks that block staff.
- `req.root` — the creator's user row (set by `requireRoot` only).

Access JWT payload: `{ sub, email, role, typ:'access', iat, exp }`.

---

## 4. Validation — `validate(schemas)`

```js
const validate = require('../middleware/validate');
const { registerSchema } = require('../schemas/auth.schema');
router.post('/register', authLimiter, validate(registerSchema), asyncHandler(handler));
```

Each exported schema is an object `{ body?, query?, params? }` of zod types. `validate`
parses each present part and **assigns the parsed result back to `req.body/query/params`**
(so coercion + unknown-key stripping is applied). Every object uses `.strict()` — unknown
keys are rejected (injection defense). `app.set('query parser', 'simple')` keeps
`req.query` flat — `?q[]=x` is the literal key `q[]` (which a strict schema
refuses), never an array or a nested object — and form bodies are parsed
`extended: false` at 64 KB. On `ZodError`: `400 VALIDATION_ERROR` with
`details = err.flatten()`.

### Exact export names per domain schema file

| File | Exports |
|------|---------|
| `auth.schema.js` | `registerSchema`, `loginSchema`, `verifyEmailSchema`, `forgotPasswordSchema`, `resetPasswordSchema` |
| `user.schema.js` | `updateProfileSchema` |
| `subscription.schema.js` | `checkoutSchema` |
| `license.schema.js` | `validateLicenseSchema`, `heartbeatSchema`, `releaseSeatSchema` |
| `device.schema.js` | `deviceCodeRequestSchema`, `devicePollSchema`, `deviceUserCodeParamsSchema`, `deviceDecisionSchema`, `deviceSignOutSchema`, `deviceToken` |
| `review.schema.js` | `createReviewSchema`, `listReviewsQuerySchema` |
| `admin.schema.js` | `adminLoginSchema`, `updateUserSchema`, `updateReviewSchema`, `createReleaseSchema`, `updateReleaseSchema`, `listQuerySchema`, `idParamSchema`, `sha256` |
| `root.schema.js` | `rootLoginSchema`, `createAdminSchema`, `updateAdminSchema`, `resetAdminPasswordSchema`, `idParamSchema`, `auditQuerySchema`, `deleteUserSchema` |
| `release.schema.js` | `downloadOsSchema` (`params:{ os }`), `feedQuerySchema` (`query:{ os }`) — `os ∈ windows | linux` |
| `ad.schema.js` | `createAdSchema`, `updateAdSchema`, `adIdParamSchema`, `serveAdsSchema`, `adEventSchema` |

Schema field notes:
- `registerSchema.body`: `{ name, email, password(min 8) }`
- `updateProfileSchema.body`: `{ name?, currentPassword?, newPassword?(min 8) }` (newPassword requires currentPassword)
- `checkoutSchema.body`: `{ plan: pro|team, billingCycle: monthly|yearly }`
- `validateLicenseSchema.body`: `{ license_key?: /^NDM(-[A-Z0-9]{4}){3}$/, device_token?: /^ndt_[A-Za-z0-9_-]{43}$/, device_fingerprint: /^[a-f0-9]{16,64}$/i, device_name?, app_version? }`
  with a `.refine` — **exactly one** of `license_key` / `device_token`. `heartbeatSchema` is the same
  without `app_version`; `releaseSeatSchema` is the credential plus `device_fingerprint`
- `devicePollSchema.body`: `{ device_code: /^[A-Za-z0-9_-]{43}$/, device_fingerprint }`;
  `deviceDecisionSchema.body`: `{ user_code }` (8-12 chars, normalised server-side)
- `createReviewSchema.body`: `{ rating: 1..5, comment }`
- `listReviewsQuerySchema.query`: `{ page=1, limit=10, rating? }` (coerced)
- admin `updateUserSchema.body`: `{ banned?, emailVerified?, plan? }` — **no `role`**, by design; role changes are creator-only. `updateReviewSchema.body`: `{ status }`
- admin `updateSubscriptionSchema.body`: `{ plan?, status?, seats?, expiryDate? }`. `expiryDate` is an ISO
  datetime and always wins over the date a plan change implies — it is how support extends a customer
  whose renewal webhook went missing, or shortens one after a refund.
- admin `idParamSchema.params` / `*ReleaseSchema.params` / `updateUserSchema.params`: positive numeric MySQL id
- admin `createReleaseSchema.body` / `updateReleaseSchema.body` also accept optional `windowsSha256`, `linuxSha256`
  (`sha256` = trimmed, lower-cased, `/^[a-f0-9]{64}$/`; `updateReleaseSchema` additionally allows `null` to clear)
- `createAdSchema.body`: `{ title(1..120), body?(<=300), imageUrl?, targetUrl, ctaLabel?(def 'Learn more'), placement?(def 'app_banner'), active?(def true), weight?(1..100 def 1), startsAt?, endsAt? }`.
  Both URL fields must be **https** (they are opened in the user's browser / fetched by the client). `endsAt` must be after `startsAt`.
  `startsAt`/`endsAt` accept an ISO datetime, or `""`/`null` to clear; **an absent key is left untouched** so a partial `updateAdSchema` edit cannot silently wipe a schedule.
- `serveAdsSchema.query`: `{ placement?(def 'app_banner') }`; `adEventSchema`: `params:{ id }`, `body:{ type: impression|click }`

---

## 5. Models (fields)

- **User**: numeric `id`, `name`, `email`(unique,lowercase,index), `passwordHash`, `role`['user','admin','root' default 'user' — 'root' is settable only by the `create-root` CLI], `emailVerified`(bool def false), `banned`(bool def false), `refreshTokenHash`(String def null), `adminRefreshTokenHash`(`admin_refresh_token_hash` VARCHAR(64) null — admin SPA cookie hash), `rootRefreshTokenHash`(`root_refresh_token_hash` VARCHAR(64) null — creator console cookie hash), `trialUsed`(`trial_used` TINYINT(1) def 0 — the no-card trial is one-shot), timestamps (`createdAt`/`updatedAt`).
- **UserSession** (`user_sessions`, `models/UserSession.js`) *(ADDED)*: `id`, `user_id`(FK, cascade), `family` CHAR(32), `token_hash` CHAR(64) unique, `prev_token_hash` CHAR(64) null, `user_agent`, `ip`, `created_at`, `last_used_at`, `rotated_at` null, `expires_at`, `revoked_at` null. `create`, `findLive(hash)`, `findReplaced(hash)` → `{ session, withinGrace }`, `rotate(id, fromHash, toHash, ttlMs)`, `revokeFamily`, `revokeById`, `revokeAllForUser`, `listForUser`, `pruneDead`. `User.refreshTokenHash` is no longer used for customers.
- **SecurityEvent** (`security_events`, `utils/securityEvents.js`) *(ADDED)*: `id`, `kind` (`login.failed`, `login.locked`, `login.success`, `session.reuse_detected`, `session.revoked`, `2fa.failed|replayed|recovery_used|enabled|disabled|recovery_codes_regenerated`, `google.nonce_rejected|token_rejected|token_replayed`, `admin.login.failed|success`, `root.login.failed|success`, `account.deleted`, `password.changed`, `password.reset`, `password.reset_requested`), `severity` info|warning|critical, `user_id`, `email`, `ip`, `user_agent`, `detail`, `created_at`. `record(kind, { req, user?, email?, severity?, detail? })` writes the row, prints one `[security] {json}` line to stdout (for log shipping) and, for the kinds in `RULES`, emails `SECURITY_ALERT_EMAIL` (≥ one alert per kind per cooldown). Pruned after 90 days by `utils/housekeeping.js`, which also drops dead sessions, spent `used_id_tokens` (`jti` PK, `expires_at`) and expired `rate_limits`.
- **Subscription**: **one row per account** (`uq_subscriptions_user (user_id)`; every reader takes the account's newest row, so a second one would be invisible on the site and still validate its own licence key — AUDIT.md M-07). numeric `id`, `userId`(FK users.id), `plan`['free','pro','team'], `status`['active','expired','cancelled' def 'active'], `licenseKey`(unique), legacy `deviceFingerprint`, `seats`, dates, `trialEndsAt`(`trial_ends_at` DATETIME null — set only for the 7-day Pro trial; cleared by paid activation), Stripe ids, timestamps. Device assignments are in `license_activations` and are transactionally capped by `seats`.
  Helpers: `Subscription.expireTrialIfNeeded(sub)` (lazy downgrade to `plan='free', status='active', trial_ends_at=NULL, expiry_date=planExpiry('free')` when `trial_ends_at` is past and there is no `stripe_subscription_id`; returns the fresh row) and `Subscription.startTrial(userId)` (single transaction → `{ ok, subscription } | { ok:false, reason }`).
- **Payment**: `userId`, `amount`, `currency`(def 'usd'), `plan`, `billingCycle`['monthly','yearly'], `stripePaymentId`, `status`['paid','failed','refunded' def 'paid'], timestamps.
- **Review**: `userId`, `userName`, `rating`(1..5), `comment`, `status`['pending','approved','rejected' def 'pending'], timestamps.
- **Ad**: numeric `id`, `title`, `body`, `imageUrl`(`image_url` null), `targetUrl`(`target_url`), `ctaLabel`(`cta_label` def 'Learn more'), `placement`['app_banner','app_sidebar','app_complete' def 'app_banner'], `active`(bool def true), `weight`(1..100 def 1), `startsAt`/`endsAt`(`starts_at`/`ends_at` TIMESTAMP null — open-ended when null), `impressions`/`clicks`(INT UNSIGNED def 0, bumped only by `Ad.recordImpression/recordClick`, never writable through the admin API), `createdBy`(FK users.id, `ON DELETE SET NULL`), timestamps.
  `Ad.listServable(placement, limit)` returns only rows that are `active` and inside their window, heaviest first.
- **Release**: `version`, `windowsUrl`, `linuxUrl`, `windowsSha256`(`windows_sha256` VARCHAR(64) null), `linuxSha256`(`linux_sha256` VARCHAR(64) null), `downloadCount`(`download_count` INT UNSIGNED def 0 — bumped by `Release.incrementDownloadCount(id)`; `Release.sumDownloadCount()` feeds `GET /api/stats`), `changelog`, `isLatest`(bool def false), `publishedAt`(def now), timestamps.

---

## 6. Endpoint list (what each route file must implement)

All paths below are **relative to the mount** shown in the header, e.g. in
`routes/auth.js` define `router.post('/register', ...)` → served at `/api/auth/register`.

### `routes/auth.js` → `/api/auth`
| Method | Path | Middleware | Notes |
|--------|------|-----------|-------|
| POST | `/register` | `authLimiter`, `requireTurnstile`, `validate(registerSchema)` | create user (bcrypt cost 12), free Subscription + license, send verify email. **Non-enumerable:** an address that already has an account gets the SAME `201 {ok:true}` and no second account — the existing owner is told by email instead. The password is hashed before the lookup so the two branches take the same time |
| POST | `/login` | `authIpLimiter`, `loginLimiter`, `validate(loginSchema)` | check `EMAIL_VERIFICATION_REQUIRED`; return access token + set `ndm_refresh` cookie. **Refuses a control-panel account with the ordinary `401 INVALID_CREDENTIALS`** — identical body to a wrong password, to a right password on a staff row, and to an address with no account at all. Every branch runs a real cost-12 bcrypt, including the unknown-address one, so neither the code nor the clock answers "does this address have an account?" or "is this one the administrator?". The owner is told in their own inbox (`sendControlPanelSignInAttemptEmail`), never on the wire *(ADDED)* |
| POST | `/verify-email` | `validate(verifyEmailSchema)` | `verifyEmailToken(token)` → set `emailVerified=true` |
| POST | `/forgot-password` | `authLimiter`, `requireTurnstile`, `validate(forgotPasswordSchema)` | always 200 (no user enumeration); send reset email. **Never mints a link for a control-panel account** — see below |
| POST | `/reset-password` | `authLimiter`, `validate(resetPasswordSchema)` | `verifyResetToken` → set new passwordHash; **clears a sign-in lockout** (proof of the inbox is the way out of it) *(ADDED)* |
| POST | `/refresh` | — | read `ndm_refresh` cookie, find the live `user_sessions` row, **rotate** it (§3), return a new 15-minute access token. A hash matching only `prev_token_hash` is a replay: re-sent within the 30-s grace, otherwise the family is revoked and `401 INVALID_REFRESH_TOKEN`. Applies the same ban / verification / **control-panel** gates as `/login`; a control-panel row has its session revoked and both cookies cleared, and answers the same `401 INVALID_REFRESH_TOKEN` as a cookie nobody ever issued *(CHANGED)* |
| POST | `/logout` | — | revoke this browser's session family + clear `ndm_refresh` / `ndm_session` *(CHANGED)* |
| POST | `/login/2fa` | `twoFactorLimiter`, `validate(twoFactorLoginSchema)` | `{ challenge, code }` → the normal `{ token, user }` + cookie, for an account whose `/login` (or `/google`) answered `{ requiresTwoFactor:true, challenge }`. Challenge is a 5-min JWT `typ:"2fa-user"` under `JWT_SECRET` (`routes/twoFactor.js`, realm `user`) *(ADDED)* |
| GET | `/2fa` | `requireAuth` | `{ enabled, pending, recoveryCodesLeft, recoveryCodesLegacy }` *(ADDED)* |
| POST | `/2fa/setup` | `requireAuth` | `{ secret, otpauthUrl }` — stored encrypted, not yet enabled *(ADDED)* |
| POST | `/2fa/enable` | `requireAuth`, `twoFactorLimiter`, `validate(twoFactorEnableSchema)` | `{ code }` → `{ enabled:true, recoveryCodes[8] }` shown once *(ADDED)* |
| POST | `/2fa/recovery-codes` | `requireAuth`, `twoFactorLimiter`, `validate(twoFactorDisableSchema)` | `{ password?, code }` → `{ recoveryCodes[8] }` — a fresh set, shown once; same proof rules as `/2fa/disable` *(ADDED)* |
| POST | `/2fa/disable` | `requireAuth`, `twoFactorLimiter`, `validate(twoFactorDisableSchema)` | `{ password?, code }` — the password is mandatory for every account that has one (`400 INVALID_PASSWORD`); a Google-created account (no `password_hash`) turns it off with the code alone, the same allowance `DELETE /user/account` makes *(ADDED)* |
| GET | `/google/nonce` | — | `{ nonce, expiresInSeconds }` — the OIDC nonce for "Continue with Google", also kept in the httpOnly cookie `ndm_gnonce` (path `/api/auth/google`, 30 min, Strict). Signed (`random.exp.hmac`), so nothing is stored *(ADDED)* |
| POST | `/google` | `authLimiter`, `validate(googleSchema)` | `{ credential, nonce? }`. The ID token must carry the nonce this server issued to **this browser** (cookie), else `401 GOOGLE_NONCE_INVALID` — the page fetches a fresh nonce and re-initialises Google. One token opens one session: its `jti` goes in `used_id_tokens` until the token's own `exp`; a second presentation is `401 GOOGLE_AUTH_FAILED` + a `google.token_replayed` critical event. A 2FA account gets `{ requiresTwoFactor, challenge, created }` instead of a session *(CHANGED)* |

`POST /reset-password` also nulls `adminRefreshTokenHash`.

**Sign-in lockout** (`utils/loginLockout.js`) *(ADDED)*: the login limiter is
keyed per (IP, email) and cannot see many addresses guessing at one account,
so the account keeps its own score. `LOGIN_LOCKOUT_THRESHOLD` (10) consecutive
wrong passwords set `users.locked_until` for `LOGIN_LOCKOUT_MINUTES` (15),
doubling per repeat lock (`users.lock_level`) and capped at four times the
base, so the same mechanism cannot be used to lock a victim out for a day. While
locked, `/login` answers the ordinary `401 INVALID_CREDENTIALS` after the same
dummy bcrypt — the lock is **not observable on the wire**; the owner is told by
`sendAccountLockedEmail` (at most once per 24 h). A correct password after the
lock expires, a password reset, or `POST /api/admin/users/:id/unlock` zero the
counters. Only the password gate is affected: "Continue with Google" is not a
guess. Wrong passwords against a control-panel row are not counted (it is
refused whatever the password, and must not be lockable from the customer form).
The lock columns never appear in `/api/user/me` (`sanitizeUser` drops them);
the admin user detail shows them.

**Password value rules** (`utils/passwordPolicy.js`) *(ADDED)*: on every path
that sets a password (`/register`, `/reset-password`, `PUT /user/profile`,
`POST /admin/users/:id/reset-password`, `POST /root/admins`,
`POST /root/admins/:id/reset-password`) a password that contains the account's
email local-part, or that appears in a known breach, is refused with
`400 WEAK_PASSWORD` and a message safe to show verbatim. The breach check asks
Have I Been Pwned's range API with k-anonymity (five hex characters of the
SHA-1 leave the server, never the password), fails **open** on error or after
`PASSWORD_BREACH_TIMEOUT_MS`, and is off with `PASSWORD_BREACH_CHECK=false`
(the test bootstrap sets that). Registration runs the check before the hash
and before the lookup, so the refusal is identical for a new and an existing
address.

**Hash upgrade on sign-in** *(ADDED)*: a stored hash with fewer bcrypt rounds
than `BCRYPT_COST` (12) is re-hashed with the plaintext in hand on the next
successful login, so raising the cost later needs no migration.

### `routes/user.js` → `/api/user` (all `requireAuth`)
| Method | Path | Middleware |
|--------|------|-----------|
| GET | `/me` | `requireAuth` — profile + subscription. `subscription` is the plan the account **has** (`utils/accountPlan.js#effectivePlanFor`): a Team member gets the team's row, with `viaTeam:true` and `teamOwner`. Also `trial`, `trialEndsAt` (after `expireTrialIfNeeded`), and `cancelAtPeriodEnd` — the last three are forced off for a member, whose own row is Free and whose owner's cancellation is not theirs to read or act on *(CHANGED)* |
| PUT | `/profile` | `requireAuth`, `validate(updateProfileSchema)` |
| GET | `/license` | `requireAuth` — license key (+ `trial`, `trialEndsAt`). `403 EMAIL_NOT_VERIFIED` with `{canResend:true}` for an unverified address |
| POST | `/license/rotate` | `requireAuth`, `licenseRotateLimiter` (5/day, durable) — issue a NEW licence key and stamp `revoked_at` on every activation. Paid + `active` only (`400 NOT_ROTATABLE`), audit `license.rotated`, best-effort licence email. → `{ licenseKey, plan, devicesRevoked }`. **This is the only way to take a leaked key back**: a Team member is handed the owner's real key and no activation row records who created it, so removing them from the roster revokes nothing *(ADDED)* |
| GET | `/billing` | `requireAuth` — payment history |
| GET | `/sessions` | `requireAuth` — `{ sessions:[{ id, current, userAgent, ip, createdAt, lastUsedAt, expiresAt }] }`, this account's live browser sessions; `current` is the one whose refresh cookie came with the request *(ADDED)* |
| DELETE | `/sessions/:id` | `requireAuth`, `validate(deviceParamsSchema)` — revoke that session's family (`404` if not this user's or already revoked); `session.revoked` event *(ADDED)* |
| POST | `/sessions/revoke-others` | `requireAuth` — revoke every family but the current one → `{ revoked }` *(ADDED)* |
| GET | `/devices` | `requireAuth` — this account's machines, merging seat leases and signed-in devices by fingerprint: `{ seats, activeSeats, seatsEnforced, devices:[{ id, tokenId, shortId, name, signedIn, appVersion, active, leaseExpiresAt, lastSeenAt, firstSeenAt }] }`. `seatsEnforced` is false on Free (no seat limit), so the dashboard shows no seat badge *(ADDED)* |
| DELETE | `/devices/:id` | `requireAuth` — free that seat lease; the machine keeps its credential |
| DELETE | `/devices/tokens/:id` | `requireAuth` — sign that machine out: revoke its device token (reason `dashboard`) and release its seat on whichever subscription it used. The app drops to Free at its next check and forgets the account (`signed_out`); event `device.signed_out` *(ADDED)* |

### `routes/subscription.js` → `/api/subscription`
| Method | Path | Middleware |
|--------|------|-----------|
| GET | `/plans` | PUBLIC — return `PLANS` |
| POST | `/checkout` | `requireAuth`, `validate(checkoutSchema)` — `stripe.createCheckoutSession` |
| POST | `/cancel` | `requireAuth` — cancels **at period end**: `stripe.cancelSubscription(id, { atPeriodEnd: true })` and `cancel_at_period_end = 1`. The row stays `active` with its expiry intact, so the customer keeps what they paid for; `customer.subscription.deleted` (or the lazy lapse, for a plan with no Stripe subscription) is what finally returns them to Free. `400 ALREADY_CANCELLING` if one is already pending |
| POST | `/resume` | `requireAuth` — undo a pending cancellation while the period is still running. `400 NOT_CANCELLING` *(ADDED)* |
| POST | `/trial/cancel` | `requireAuth` — end a running trial **now**. `400 NO_TRIAL` when none is running. `Subscription.endTrial` writes exactly what the lazy expiry writes: `plan='free', status='active', trial_ends_at=NULL, expiry_date=planExpiry('free'), seats=1, cancel_at_period_end=0`, licence key untouched. `users.trial_used` stays 1 — a trial is one per account, whether it ran out or was stopped. Audit `subscription.trial_cancelled`. **Never `cancelled`/`expired`**: the desktop client deletes a key it is told is cancelled, and ending a trial is not a stopped licence. `POST /cancel` refuses a trial with `400 TRIAL_NOT_CANCELLABLE` — there is no renewal to call off, and scheduling one left the billing page announcing "Ending" for something that changed nothing *(ADDED)* |
| GET | `/status` | `requireAuth` — `{ plan, status, expiryDate, seats, trial, trialEndsAt, cancelAtPeriodEnd, viaTeam, teamOwner }`, resolved through `effectivePlanFor` so a Team member sees the team's plan rather than their own Free row. Billing hides cancel/portal on `viaTeam` *(CHANGED)* |
| POST | `/start-trial` | `requireAuth` — 7-day no-card Pro trial. `400 TRIAL_UNAVAILABLE` if `users.trial_used=1`, if the account is on somebody's **Team** plan (it already has everything the trial grants, and starting one would spend the account's single trial on nothing), or if the current subscription is an active paid pro/team plan; `403 SUBSCRIPTION_STOPPED` if its status is `cancelled`/`expired`, which only ever means a person stopped it — the trial used to overwrite that row in place and hand back seven days of Pro on the very key that had been stopped. Otherwise ONE transaction: `plan='pro', status='active', seats=planSeats('pro'), start_date=now, expiry_date=trial_ends_at=now+7d, stripe_subscription_id=NULL`, `users.trial_used=1`; audit `subscription.trial_started`. → `{ plan:'pro', trial:true, trialEndsAt }` *(ADDED)* |

### `routes/license.js` → `/api/license`
| Method | Path | Middleware | Notes |
|--------|------|-----------|-------|
| POST | `/validate` | `licenseLimiter`, `validate(validateLicenseSchema)` | **LITERAL response** (see §2). `expireTrialIfNeeded` first; bind device on first activation; check expiry/status; `signLicenseToken`; always includes `trial` |

### `routes/device.js` → `/api/device` — account sign-in for the desktop app *(ADDED)*

OAuth's device-authorization flow, so the app never sees a password **and never
needs a licence key**. The plan follows the account: a trial, an upgrade or a
team invitation reaches every signed-in machine on its next validation.

| Method | Path | Middleware | Notes |
|--------|------|-----------|-------|
| POST | `/code` | `deviceCodeLimiter` (durable, 10/h per IP), `validate(deviceCodeRequestSchema)` | → `{ deviceCode, userCode:"ABCD-1234", verificationUrl, verificationUrlComplete, expiresIn:600, interval:5 }`. Only the **hash** of `deviceCode` is stored |
| POST | `/token` | `devicePollLimiter` (memory, 60/min per IP), `validate(devicePollSchema)` | The app polls this. → `{ status }` (`pending`, `slow_down`, `denied`, `expired`) or `{ status:'approved', deviceToken, account }`. approved→consumed is atomic, so one code hands out **one** token; a poll from a fingerprint other than the one that asked reads as `expired`. Event `device.signed_in` |
| GET | `/code/:userCode` | `requireAuth`, `validate(deviceUserCodeParamsSchema)` | What is asking: `{ userCode, deviceName, appVersion, requestedAt, expiresAt }`; `404 CODE_NOT_FOUND` |
| POST | `/approve` | `requireAuth`, `deviceApproveLimiter` (durable, 10/15min per IP+user), `validate(deviceDecisionSchema)` | `403 EMAIL_NOT_VERIFIED` (`{canResend:true}`) and `403 FORBIDDEN` for a control-panel account — the same bar a licence key has. Event `device.approved`, plus a "new device signed in" email: the way a stolen website session gets noticed |
| POST | `/deny` | `requireAuth`, `deviceApproveLimiter`, `validate(deviceDecisionSchema)` | Kills the code. Event `device.denied` (warning) |
| POST | `/signout` | `devicePollLimiter`, `validate(deviceSignOutSchema)` | The app signing itself out: revoke the token, release its seat. Always `{ signedOut:true, wasSignedIn }` — a machine already revoked gets the same answer and forgets its token either way |

The flow states (`pending`, `denied`, `expired`) are `ok:true` **data**, not
errors: they are the answer, not a failure to answer.

- **`models/DeviceAuth.js`** owns `device_codes` (10-minute TTL, `user_code`
  unique while pending) and `device_tokens` (`ndt_` + 43 base64url chars, stored
  hashed, one live token per user+device — a new one retires the old with reason
  `replaced`). `prune()` runs from `utils/housekeeping.js`.
- **A device token is bound to its machine.** Presented from a different
  fingerprint it is revoked on the spot (`device_mismatch`) with a **critical**
  `device.token_misuse` event, and answers `signed_out` — a copied token is dead
  everywhere, and the rightful machine simply signs in again.
- **A banned account, or one promoted to staff/root since it signed in, is
  signed out at its next validation** — the same line `/api/auth` draws.
- **The Free plan has unlimited seats** (`Subscription.acquireSeat`): there is no
  seat limit to sell on it, and a household running Free on three machines is not
  sharing anything. The sharing assessment skips it for the same reason.
- Security event kinds: `device.signed_in`, `device.approved`, `device.denied`,
  `device.signed_out`, `device.token_misuse`.

### `routes/ads.js` → `/api/ads`
Consumed by the C++ desktop app. Ads are a **Free-plan** surface: the routes read the
licence token from `Authorization: Bearer <token>` (the same token `POST /api/license/validate`
returns) and serve **nothing** when it names a paid plan. `utils/ads.js#planFromAuthHeader`
treats any missing / malformed / unverifiable token as `free`, so the fallback is "sees ads",
never "silently entitled to ad-free".

| Method | Path | Middleware | Notes |
|--------|------|-----------|-------|
| GET | `/` | PUBLIC, `adsLimiter`, `validate(serveAdsSchema)` | `?placement=app_banner`. → `{ adFree, ads:[{ id, title, body, imageUrl, targetUrl, ctaLabel, placement, weight }] }`. Paid licence ⇒ `{ adFree:true, ads:[] }`. Counters, schedule and authorship are never sent |
| POST | `/:id/event` | PUBLIC, `adsLimiter`, `validate(adEventSchema)` | `{ type: impression\|click, token }` → `{ counted }`. An unknown or paused id counts nothing and is **not** an error; a paid licence counts nothing |

`token` is `expires.nonce.hmac` (`utils/ads.js#signAdEventToken`, keyed by
`config.adEventSecret`, 45-minute TTL) issued with each ad by `GET /api/ads` and
echoed back by the client. Without a valid one the event counts nothing: the
route is otherwise open, so anybody could inflate the counters — and the CTR the
admin panel computes from them — with a loop of curl calls. An older desktop
build simply sends no token and its events are ignored rather than rejected.

The signature alone was not enough, because the same valid token could be
replayed for the whole of its life. `ad_event_nonces` gives each token a
**budget** per event type (`models/Ad.js#claimEventNonce`: at most one event per
30 s, ≤80 impressions and ≤5 clicks), so a replay buys no more than the client
it was stolen from would have reported. It is a rate and not single-use on
purpose: the desktop app holds one token for a whole 30-minute refresh cycle,
reports an impression on every 45-second rotation and reuses the same token for
the click. Over budget answers `{ counted:false, reason:'rate_limited' }`.

Two-part (pre-nonce) tokens are refused rather than grandfathered — accepting
them would leave the replay open to anyone who sent the old shape.

### `routes/reviews.js` → `/api/reviews`
| Method | Path | Middleware |
|--------|------|-----------|
| GET | `/` | PUBLIC, `validate(listReviewsQuerySchema)` — approved only, paginated, avg rating |
| POST | `/` | `requireAuth`, `validate(createReviewSchema)` — status `pending` |

### Release artifacts

A release carries **either** an uploaded installer (`windows_file` / `linux_file`
+ `*_filename`, `*_size`, `*_sha256`) **or** a legacy external URL. Uploads win;
the `*_url` columns stay so releases published before uploads keep resolving.
`GET /api/releases/download/:os` streams an uploaded file with `Accept-Ranges`
(206/416 handled — NDM's own users resume downloads). `download_count` records
that a download **started** — completion is not observable — and only when one
did (`utils/downloadCounter.js`, asked once per request on both the uploaded
and the legacy-redirect path): not for a resume (a `Range` from anywhere but
byte 0), not for the app's one-byte `bytes=0-0` size probe, not for a `HEAD`
(Express routes it to the GET handler), not for the same address starting the
same release + platform again inside a 10-minute window (a cancel-and-restart,
a retry, a scanner), and not for a release whose file is missing from disk —
the 404 is decided before the count. The dedupe is in-process; several API
instances could over-count by at most one each per window. `buildFeed` uses
`hasArtifact()`, so a file-only release still appears in the update feed with the
checksum computed at upload time.

### `routes/releases.js` → `/api/releases`
| Method | Path | Middleware |
|--------|------|-----------|
| GET | `/latest` | PUBLIC — the `isLatest` release: `{ version, windowsUrl, linuxUrl, changelog, windowsSha256, linuxSha256, downloadCount, publishedAt }` (sha fields `null` when unset) |
| GET | `/download/:os` | PUBLIC, `downloadLimiter`, `validate(downloadOsSchema)` — `os ∈ windows\|linux`. Increments `releases.download_count` of the latest release then **302** to its URL for that OS; `404 NO_RELEASE` (envelope) when there is no latest release or no URL for that OS *(ADDED)* |
| GET | `/feed` | PUBLIC, `validate(feedQuerySchema)` — `?os=windows\|linux`. **LITERAL response** (see §2 exception 2), `Cache-Control: public, max-age=300` on 200 *(ADDED)* |

### `routes/admin.js` → `/api/admin`
| Method | Path | Middleware |
|--------|------|-----------|
| POST | `/login` | `adminLoginLimiter`, `ipWhitelist`, `validate(adminLoginSchema)` — **open** (no token); verify admin user (not banned), `signAdminToken`, set `ndm_admin_refresh` cookie (§3) → `{ token, admin:{ id, name, email, role } }`. The password compare runs for **every** address through `utils/passwordCheck.js` — a customer's, an unknown one, an admin with no `password_hash` — so the clock does not answer "is this address the administrator?" any more than the body does *(ADDED, open)* |
| POST | `/refresh` | `adminLoginLimiter`, `ipWhitelist` — **open**; reads `ndm_admin_refresh`, verifies hash + `role==='admin'` + not banned, rotates cookie → `{ token }`. `401 NO_REFRESH_TOKEN` / `401 INVALID_REFRESH_TOKEN` / `403 FORBIDDEN` (banned; hash nulled) *(ADDED)* |
| POST | `/logout` | `ipWhitelist` — **open**; clears `ndm_admin_refresh` + nulls `adminRefreshTokenHash` → `{ loggedOut: true }` *(ADDED)* |
| GET | `/me` | `requireAdmin` → `{ id, name, email, role, twoFactorEnabled, twoFactorRequired }` (`id` is a string, as in `/login`). `twoFactorRequired` mirrors `ADMIN_2FA_REQUIRED`; when it is on and `twoFactorEnabled` is off, every other panel route answers `403 TWO_FACTOR_REQUIRED` (`{ setupPath:'/2fa/setup' }`) and the SPA parks the account on the Security screen *(CHANGED)* |
| GET | `/security/events` | `requireAdmin`, `validate(securityEventsQuerySchema)` — `?hours=24&kind=&limit=200` → `{ hours, events[], counts:[{ kind, severity, n }] }` from `security_events`, newest first *(ADDED)* |
| GET | `/stats` | `requireAdmin` — also returns `ads:{ total, active, impressions, clicks }` |
| GET | `/users` | `requireAdmin`, `validate(listQuerySchema)` |
| PUT | `/users/:id` | `requireAdmin`, `validate(updateUserSchema)` — a `plan` change also sets `trial_ends_at=NULL`. `403` if the target is an `admin`/`root` and the caller is not the creator; **no `role` field** |
| POST | `/users/:id/revoke-sessions` | `requireAdmin` — revokes every `user_sessions` row, bumps `token_version`, nulls `adminRefreshTokenHash`/`rootRefreshTokenHash`; `403` on a control-panel target unless the caller is the creator |
| POST | `/users/:id/unlock` | `requireAdmin`, `validate(idParamSchema)` — lifts a sign-in lockout and zeroes its counters; `{ unlocked: true, wasLocked }`; audited as `user.unlocked`; same control-panel-target rule *(ADDED)* |
| DELETE | `/users/:id` | `requireAdmin`, `validate(deleteUserSchema)` — **irreversible**. Body must carry the target's exact `confirmEmail` (`400 CONFIRM_MISMATCH`). Refuses the caller's own account (`400 SELF_LOCKOUT`), any creator (`403`), and — for a staff caller — any control-panel account (`blockedStaffTarget`). The audit row is written *before* the delete because `audit_logs.admin_user_id` is `ON DELETE SET NULL`. Data removal is the schema's cascade, not the route's: subscriptions, payments, reviews and (through subscriptions) `license_activations` + `team_members` are `ON DELETE CASCADE`; audit logs, ads and contact messages are `ON DELETE SET NULL`, so what was done outlives who did it. The creator's `/api/root/users/:id` is the same rule with a wider reach *(ADDED)* |
| GET | `/subscriptions` | `requireAdmin`, `validate(listQuerySchema)` |
| POST | `/subscriptions` | `requireAdmin`, `validate(createSubscriptionSchema)` — for an account that has **no** subscription; registration gives every account a free one, so anything else is an edit. `409 SUBSCRIPTION_EXISTS` `{ subscriptionId, plan, status }` when one exists, `409 DUPLICATE` if two creates race past that check into the unique index. `403` on a control-panel target unless the caller is the creator *(ADDED)* |
| PUT | `/subscriptions/:id` | `requireAdmin`, `validate(updateSubscriptionSchema)` — a `plan` change also sets `trial_ends_at=NULL` and moves the expiry with the plan unless the body sets one. `403` when the **owner** is a control-panel account and the caller is not the creator *(ADDED)* |
| GET | `/reviews/pending` | `requireAdmin` |
| PUT | `/reviews/:id` | `requireAdmin`, `validate(updateReviewSchema)` |
| PUT | `/releases/:id/artifact/:os` | `requireAdmin`, `validate(releaseArtifactParamsSchema)` — body is the **raw installer** (`application/octet-stream`, name in `X-Filename`), streamed to `RELEASE_UPLOAD_DIR`. SHA-256 + size computed in flight and stored; the previous file is deleted only after the new one lands. `400 BAD_FILE_TYPE` / `413 FILE_TOO_LARGE` / `400 EMPTY_UPLOAD`. **The installer must be the release's version** (`utils/artifactVersion.js` reads the PE `VS_FIXEDFILEINFO` of an `.exe`, the `control` file of a `.deb`): a definite mismatch removes the file and answers `409 VERSION_MISMATCH` `{ artifactVersion, releaseVersion }` before the row is touched; the reply carries `artifactVersion` + `versionWarning:null` on a match, and `versionWarning` (string) when no version could be read — accepted, but flagged, and the audit summary ends "— version unchecked" |
| DELETE | `/releases/:id/artifact/:os` | `requireAdmin` — clears the columns and removes the file from disk |
| GET | `/releases` | `requireAdmin` — list ALL releases *(ADDED)* |
| POST | `/releases` | `requireAdmin`, `validate(createReleaseSchema)` — accepts `windowsSha256`, `linuxSha256` |
| PUT | `/releases/:id` | `requireAdmin`, `validate(updateReleaseSchema)` — set latest; `windowsSha256`/`linuxSha256` (`null` clears) |
| GET | `/ads` | `requireAdmin` — list ALL ads, each with a computed `ctr` *(ADDED)* |
| GET | `/ads/stats` | `requireAdmin` — `{ total, active, impressions, clicks }` *(ADDED)* |
| POST | `/ads` | `requireAdmin`, `validate(createAdSchema)` — stamps `created_by`, audits `ad.created` *(ADDED)* |
| PUT | `/ads/:id` | `requireAdmin`, `validate(updateAdSchema)` — audits `ad.updated`; `404 NOT_FOUND` *(ADDED)* |
| DELETE | `/ads/:id` | `requireAdmin`, `validate(adIdParamSchema)` — audits `ad.deleted`; `404 NOT_FOUND` *(ADDED)* |

### Seats are concurrent, not permanent

`subscriptions.seats` is a "how many machines at a time" limit. A device holds a
seat only while `license_activations.lease_expires_at` is in the future
(`SEAT_LEASE_SECONDS`, 15 min); the desktop app heartbeats every 5 minutes and
releases on a clean exit. A crashed client frees its seat when the lease lapses,
so nothing needs admin intervention.

| Endpoint | Effect |
|---|---|
| `POST /api/license/validate` | takes or renews a seat, mints the token |
| `POST /api/license/heartbeat` | renews the lease of a device that **already has an activation row**, and re-issues the token (cheap, `apiLimiter`). It may never create one: `acquireSeat({renewOnly:true})` answers `seat_unknown_device` (sent on the wire as `seat_limit`) for a machine that never called `/validate`. Registering here would take a seat and mint a signed token while skipping the key-sharing assessment, which runs **only** in `/validate` |
| `POST /api/license/release` | drops the lease now; always 200 |

`Subscription.acquireSeat` does the whole check in one transaction with the
subscription row locked `FOR UPDATE`, and excludes the calling device from the
busy count so a renewal is always free. Refusal returns
`{valid:false, reason:'seat_limit', seats, activeSeats}` — **not** `device_mismatch`:
the licence is fine, the user just has to close the app elsewhere. The desktop
client keeps the key on `seat_limit` instead of deleting it.

Users free their own seats at `GET/DELETE /api/user/devices`; an admin drops all
of them with `POST /api/admin/subscriptions/:id/revoke-device`.

### AI helpers are server-side so the entitlement is real

```
POST /api/ai/rename    { filename, url?, contentType? }  -> { name }
POST /api/ai/command   { text }                          -> { downloads, schedule }
```

Both require `Authorization: Bearer <licence token>` for a plan whose
`entitlementsFor(plan).aiRename` is true; anything else is `AI_NOT_ENTITLED`
(403). With no `ANTHROPIC_API_KEY` configured they answer `AI_UNAVAILABLE`
(503) and the app simply leaves filenames alone.

**The prompts live in `utils/aiProxy.js`, never in the request.** These are two
narrow endpoints rather than one prompt-forwarding proxy for a specific reason:
a proxy that relayed a client-supplied prompt would be a free Claude gateway to
anyone who extracted a token, so the entitlement would gate *who* pays nothing
rather than *what* they can ask. Inputs are length-capped and `max_tokens` is
small, and `aiLimiter` counts in MySQL because these calls cost real money.

### Seat limits cap concurrency; sharing detection catches distribution

A leaked key does not trip the seat limit — five hundred people sharing one key
still show N concurrent seats, because they take turns. What gives it away is
that every distinct machine leaves a permanent `license_activations` row
(`releaseSeat` clears the lease, not the row), so the **all-time** device count
diverges from the seat count even though the live count never does.

`utils/licenseAbuse.js#assessSharing({seats, distinctDevices, newDevicesInWindow})`
grades that into `ok` / `watch` / `suspected`, evaluated on `/license/validate`
only when a **new** device takes a seat, and stored on the subscription
(`sharing_level`, `sharing_devices`, `sharing_reason`, `sharing_checked_at`).

```
GET /api/admin/subscriptions/flagged      → { subscriptions: [...], thresholds }
GET /api/admin/security/token-rejections  → { totals, attackTotal, buckets, ... }
```

The second is the other half of the picture: licence tokens that arrived but did
not verify. A genuine client never produces one — it holds a token this server
signed and replaces it every five minutes — so `bad_signature` and
`bad_algorithm` counts are people building tokens by hand, i.e. the visible
trace of somebody testing a crack. `expired` is tracked separately and is *not*
treated as an attack: a skewed clock or a long sleep produces those honestly.
Counts live in hourly buckets (`license_token_rejections`) rather than a row per
rejection, so flooding the endpoint cannot grow the table.

Above a **much** higher bar — `30x seats + 3` distinct devices, or `20x seats + 3`
inside the window — `autoSuspendReason()` suspends the licence outright
(`LICENSE_AUTO_SUSPEND=false` turns just that off). The two bars are deliberately
far apart: flagging asks "worth a look?" and should stay sensitive, while
suspending cuts off paid software with no human in the loop and should stay rare.

A suspension:
- sets `sharing_suspended_at`, and **never touches `status`** — `cancelled` or
  `expired` would make the desktop client delete the stored key;
- answers `{valid:false, reason:'seat_limit'}`, which the client already handles
  by keeping the key and saying "close Nexa elsewhere" — and which tells whoever
  is sharing the key nothing about what was detected;
- releases the seat it just granted, so the rightful owner is not locked out for
  a further lease period once it is lifted;
- is reversible: `POST /api/admin/subscriptions/:id/sharing/clear` lifts it and
  sets `sharing_exempt`, because the device history that triggered it does not go
  away and the next activation would otherwise re-suspend within minutes.
  `.../sharing/resume` puts the licence back under automatic enforcement.

Flagging still **records a verdict and nothing else**. Fingerprints
change for innocent reasons (a reinstall, a replaced NIC, a reimaged laptop), so
acting on the flag is a human decision made with the existing "Free seats" or
cancel controls. Thresholds are `4×seats+3` to watch and `10×seats+3` to suspect,
plus a 7-day burst rule so a key published this week is caught before its
all-time count catches up.

### Plan changes move the expiry with the plan

`utils/license.js#expiryForPlanChange(fromPlan, toPlan, currentExpiry)` decides
the date whenever an admin moves a subscription between plans
(`PUT /api/admin/users/:id`, `PUT /api/admin/subscriptions/:id`). The free
plan's expiry is deliberately ~100 years out, so carrying a date across a change
is wrong in **both** directions: free → pro kept the far-future date and quietly
granted a permanent Pro licence, while pro → free kept the paid date, so the
customer's FREE licence expired a month later and the desktop app deleted their
key. A lateral paid move (pro ⇄ team) keeps its date — that period is paid for.

### Feature entitlements

`config/plans.js` `entitlementsFor(plan)` is the single source of truth for what
a plan may do, and is returned by `/api/license/validate` **both** beside the
token and inside it, so a client that edits its local copy still cannot make a
plan-gated endpoint agree. Unknown/absent/forged plans resolve to `free`.

| Key | free | pro / team |
|---|---|---|
| `maxConcurrentDownloads` | 3 | 0 (unlimited) |
| `maxConnectionsPerFile` | 16 | 32 |
| `themes` | `'basic'` (`freeThemes`: system, dark, light) | `'all'` |
| `authSiteDownloads` (Udemy, Coursera…) | false | true |
| `aiRename` | false | true |
| `adFree` | false | true (derived from `utils/ads.js`) |
| `seats` | 1 | 1 / 5 |

### `routes/root.js` → `/api/root` (creator only)
Every route below rejects a staff-admin token. Session routes mirror `/api/admin`
but use `rootIpWhitelist`, the `ndm_root_refresh` cookie and `signRootToken`.

| Method | Path | Middleware |
|--------|------|-----------|
| POST | `/login` | `adminLoginLimiter`, `rootIpWhitelist`, `validate(rootLoginSchema)` — **open**; requires `isRootUser` (role **and** `ROOT_ADMIN_EMAIL`) → `{ token, admin }`. Same timing rule as the staff panel (`utils/passwordCheck.js`): the address this form belongs to is the creator's, so the comparison happens before eligibility is decided and a row with no password takes the dummy branch rather than throwing |
| POST | `/refresh` | `adminLoginLimiter`, `rootIpWhitelist` — **open**; reads `ndm_root_refresh`, re-checks `isRootUser`, rotates → `{ token }` |
| POST | `/logout` | `rootIpWhitelist` — **open**; clears cookie + nulls `rootRefreshTokenHash` |
| GET | `/me` | `requireRoot` → `{ id, name, email, role }` |
| GET | `/overview` | `requireRoot` → `{ totalUsers, admins, roots, banned, downloads, rootEmailPinned }` |
| GET | `/admins` | `requireRoot` → `{ admins }` — every `role IN ('admin','root')` account |
| POST | `/admins` | `requireRoot`, `validate(createAdminSchema)` — creates a **staff admin** (password ≥12); `role` is not accepted |
| PUT | `/admins/:id` | `requireRoot`, `validate(updateAdminSchema)` — `{ name?, banned?, role? }`, `role` limited to `user\|admin`; banning/demoting also revokes sessions |
| POST | `/admins/:id/reset-password` | `requireRoot`, `validate(resetAdminPasswordSchema)` — revokes sessions |
| POST | `/admins/:id/revoke-sessions` | `requireRoot`, `validate(idParamSchema)` |
| DELETE | `/admins/:id` | `requireRoot`, `validate(idParamSchema)` — demote to `user`, keeps the account |
| GET | `/audit` | `requireRoot`, `validate(auditQuerySchema)` — full trail, up to 200 rows |
| DELETE | `/users/:id` | `requireRoot`, `validate(deleteUserSchema)` — **irreversible**; body must carry the target's exact `confirmEmail`; audit row is written *before* the delete because `audit_logs.admin_user_id` is `ON DELETE SET NULL` |

Guards shared by every `/admins/:id` route: `404` if absent, `400 SELF_LOCKOUT`
if it is the caller, `403 FORBIDDEN` if the target is a `root`. A creator account
is therefore only ever changed by the `create-root` CLI.

### `routes/webhooks.js` → `/api/webhooks`
| Method | Path | Middleware | Notes |
|--------|------|-----------|-------|
| POST | `/stripe` | — | body is a **raw Buffer** (mounted with `express.raw` in app.js). Use `stripe.constructEvent(req.body, req.headers['stripe-signature'])`. Respond `200 { received: true }` (plain, not envelope, for Stripe). |

Events handled, and what each one writes:

| Event | Effect |
|---|---|
| `checkout.session.completed` | create Payment + activate Subscription (**clears `trial_ends_at`**) + email licence and receipt — but ONLY when `payment_status` is `paid`/`no_payment_required`/absent. A delayed method (ACH, SEPA) completes the session with the debit still in flight |
| `checkout.session.async_payment_succeeded` | the settlement of the above; same handler, so the grant happens once, when the money actually arrives |
| `checkout.session.async_payment_failed` | logged; nothing was granted, so nothing to undo |
| `invoice.payment_succeeded` / `invoice.paid` | **renewal** — push `expiry_date` to the period end Stripe just billed, record the Payment, email a receipt (only when `billing_reason === 'subscription_cycle'`, so the first invoice is not thanked twice) |
| `invoice.payment_failed` | record a `failed` Payment. The subscription is untouched: Stripe retries for days, and `customer.subscription.deleted` is what actually ends access |
| `customer.subscription.created` / `customer.subscription.updated` | sync from Stripe's own billing portal: period end, `cancel_at_period_end`, and the plan when the price matches one of ours (an unrecognised price leaves the stored plan alone). `past_due`/`unpaid` change nothing — Stripe is still retrying. `created` takes the same path: a subscription started in the Stripe dashboard announces itself only that way, and the handler writes only what differs, so both events are idempotent |
| `customer.subscription.deleted` | the subscription ended: downgrade to **`plan='free', status='active'`**, NOT `cancelled`. `reason:"cancelled"` makes the desktop client delete the key, so ending a subscription used to destroy the free licence underneath it. The churn event is kept as an audit row (`subscription.ended`) |
| `charge.refunded` | mark the `payments` row `refunded` (nothing ever wrote that status, so refunded months kept counting toward MRR). A FULL refund also cancels the Stripe subscription and returns the account to Free |

**Invoices carry none of the Checkout Session's metadata.** `plan` and
`billingCycle` were set on the session, so the invoice handlers read the plan
from OUR subscription row and the cycle/period/amount from the invoice's own
line item — `utils/stripeInvoice.js` holds those pure readers and accepts every
field position Stripe has used across API versions. Reading them from
`invoice.metadata` throws on every real invoice.

**Without the renewal handler `expiry_date` is never extended**: a monthly
subscriber's licence validates as `expired` on day 31 while Stripe keeps
charging, and the desktop client *deletes* a key it is told is expired.

**Public endpoints already in `app.js` (do NOT redefine):** `GET /api/health`,
`GET /api/stats` → `{ users, downloads }` where `users = COUNT(users)` and
`downloads = SUM(releases.download_count)`. Real numbers only — nothing is fabricated.

---

### routes/contact.js — mounted at `/api/contact`

| Method | Path | Auth | Body | Response |
|--------|------|------|------|----------|
| POST | `/` | `optionalAuth`, `contactLimiter` (5/hour/IP), `requireTurnstile` | `{ name?, email, topic?, message, website? }` — `website` is a honeypot and must be empty | `{ sent: true }` |

Delivers to `SUPPORT_EMAIL` (falls back to `FROM_EMAIL`) with `Reply-To` set to the
visitor. Mock email mode logs it like every other message.

`contact_messages.user_id` is set **only** when the sender is signed in as that
address. It used to be set on a bare email match, so anyone could type a
customer's address into the public form and have the message reach the admin
inbox labelled as coming from that customer's account — a good pretext for
talking an admin into a refund or a reset. `optionalAuth` (middleware/auth.js)
identifies a caller who happens to be signed in and leaves `req.user` unset
otherwise; it never rejects, so the form stays open to anonymous visitors.

### routes/faq.js — mounted at `/api/faq`

| Method | Path | Auth | Body | Response |
|--------|------|------|------|----------|
| POST | `/vote` | `faqVoteLimiter` (60/hour/IP) | `{ question, helpful }` — the question's own TEXT, max 300 chars | `{ recorded: true }` *(ADDED)* |

The "Was this helpful?" control under each FAQ answer. `faq_votes` holds **two
counters per question and nothing else** — no IP, no account, no per-visitor
timestamp — because a vote carries nothing about the voter worth keeping and a
per-vote table would grow without bound while answering the same single
question: which answers are failing their readers.

Keyed on `SHA1(question text)`, not on an index. An index would be smaller, and
inserting one entry into the FAQ would then silently reassign every stored count
to the wrong question with nothing to notice it by.

The endpoint is public and takes attacker-chosen text, so `FaqVote.record`
refuses to create a **new** key once the table holds `MAX_DISTINCT_QUESTIONS`
(500; the FAQ has 55). Votes for keys that already exist are never refused. The
reply is `{ recorded: true }` either way: the reader is being told their click
arrived, which it did, and an error about an internal table limit means nothing
to them and only invites a retry.

The frontend still writes localStorage, but **only after the POST succeeds**, and
only to remember that this browser already answered. A browser that recorded the
vote locally on a failed request would never offer to send it again.

Read back at `GET /api/admin/faq/votes` (`requireAdmin`), worst first.

### Public release history — `GET /api/releases/history`

`{ releases: [{ version, changelog, publishedAt, downloadCount, isLatest, hasWindows, hasLinux }] }`,
newest first. No download URLs — those always go through `/api/releases/download/:os`.

### Session hint cookie

Login and refresh also set `ndm_session=1` (NOT httpOnly, path `/`, same lifetime as
the refresh cookie); logout clears it. It carries nothing — the frontend only uses it
to decide whether to call `/api/user/me` on load, so anonymous visitors no longer
trigger a 401 + failed refresh on every page.

### Team invites — `routes/team.js` → `/api/team`
A Team subscription (5 seats, one key) can invite people by email instead of
sharing the key by hand. Table `team_members (subscription_id, email, user_id,
token_hash, status invited|active, invited_by, invited_at, accepted_at)`,
UNIQUE (subscription_id, email), cascades with the subscription and the
member's account. Roster cap = `subscriptions.seats` including the owner.

| Route | Auth | Notes |
|---|---|---|
| `GET /invites/:token` | none (`apiLimiter`) | `{ ownerName, email, plan }` for the join page, 404 `INVITE_NOT_FOUND` |
| `GET /` | user | `{ role:'owner', seats, used, canInvite, usable, members[] }` · `{ role:'member', owner, licenseKey, plan, status, usable }` · `{ role:'none' }` |
| `POST /invites` `{email}` | owner, `teamInviteLimiter` 20/h | 403 `NOT_TEAM_OWNER`, 400 `TEAM_INACTIVE`/`SELF_INVITE`/`TEAM_FULL`, 409 `ALREADY_INVITED`; sends `sendTeamInviteEmail` (link `/team/join?token=`, 32 random bytes base64url, only the SHA-256 stored). The **subject is fixed** — the inviter's display name is attacker-chosen text going out from our domain to an address they pick, so it appears only in the escaped body, beside their email address |
| `POST /invites/:id/resend` | owner | rotates the token |
| `DELETE /members/:id` | owner | removes an invite or a member. Returns `{removed:true, keyStillValid:true, rotateHint}`: the roster edit revokes **nothing**, because the member holds the owner's real licence key and no activation row records who created it. `POST /api/user/license/rotate` is the actual remedy |
| `POST /join` `{token}` | user | the signed-in email MUST equal the invited one (403 `EMAIL_MISMATCH`); 409 `ALREADY_ON_TEAM` |
| `POST /leave` | member | |

`GET /api/user/me` gains `team: { role:'member', ownerName, plan } | null`;
`GET /api/user/license` returns the owner's key with `viaTeam: true,
teamOwner` for a member whose own plan is free. Seats are still counted per
device by `/api/license/*` — membership only decides who sees the key.

### Account export + deletion — `routes/user.js`
- `GET /api/user/export` → the whole account as JSON (`account, subscriptions[].devices, payments, review, team`), `Content-Disposition: attachment`.
- `DELETE /api/user/account` `{ password, confirm:'DELETE' }` (`deleteAccountSchema`) → cancels an active Stripe subscription first, writes audit `user.self_deleted`, `User.remove` (cascades), clears `ndm_refresh` + `ndm_session`. 403 for admin/root accounts, 400 `INVALID_PASSWORD`.

### Two-factor authentication (admin, root **and customers**) — `routes/twoFactor.js`
Mounted by `routes/admin.js` (`realm:'admin'`, `JWT_ADMIN_SECRET`),
`routes/root.js` (`realm:'root'`, `JWT_ROOT_SECRET`) and `routes/auth.js`
(`realm:'user'`, `JWT_SECRET`, gate `requireAuth`, subject `req.user`,
`finishLogin` → `issueSession`) *(CHANGED)*. Columns on `users`:
`totp_secret` (AES-256-GCM via `utils/totp.js`, key = `TOTP_ENCRYPTION_KEY` or
`JWT_ADMIN_SECRET`), `totp_enabled`, `totp_recovery` (JSON array of **bcrypt**
hashes, cost 10; a code is removed when used — by a conditional swap of the
set, so two requests carrying the same code cannot both spend it). Codes are
ten uniform picks from `[a-z0-9]` (≈51.7 bits). Rows enrolled before the
bcrypt change hold unsalted SHA-256 hex; those still verify, and are
**retired on the account's next authenticator sign-in** (audit
`<realm>.recovery_codes_retired`) — the moment that proves the phone still
exists — so `GET <realm>/2fa` reports `recoveryCodesLegacy:true` until then and
the panel should offer a fresh set. Optional for customers (account page);
**mandatory for the panels** when `ADMIN_2FA_REQUIRED` is on (the default on a
public deployment): `requireTwoFactorEnrolled` in `middleware/adminAuth.js`
answers `403 TWO_FACTOR_REQUIRED` to everything but `/me`, `/logout`, `/2fa`,
`/2fa/setup`, `/2fa/enable` until `totp_enabled` is set.

- `POST <realm>/login` with 2FA on → `{ requiresTwoFactor:true, challenge }` (5-min JWT `typ:"2fa-<realm>"`), NO session/cookie.
- `POST <realm>/login/2fa` `{ challenge, code }` (`twoFactorLimiter` 10/15min) → the normal `{ token, admin }`; accepts a TOTP (±1 step) or a recovery code. A staff challenge never verifies under the root secret and vice versa.
- Behind the realm gate: `GET <realm>/2fa` → `{ enabled, pending, recoveryCodesLeft, recoveryCodesLegacy }`; `POST <realm>/2fa/setup` → `{ secret, otpauthUrl }` (stored, not yet enabled); `POST <realm>/2fa/enable {code}` → `{ enabled:true, recoveryCodes[8] }` shown once; `POST <realm>/2fa/recovery-codes { password, code }` → `{ recoveryCodes[8] }` — a fresh set behind the same proof as disabling (the offered code is spent first, so it cannot go on to complete a login), audit `<realm>.recovery_codes_regenerated`; `POST <realm>/2fa/disable { password, code }`.
- `GET <realm>/me` adds `twoFactorEnabled`; `User.listStaff` includes `totp_enabled`; root `POST /api/root/admins/:id/reset-2fa` clears a staff admin's second factor and revokes sessions.
- **A code is spent once.** `users.totp_last_step` is a monotonic high-water mark
  and `checkCode` refuses `step <= totp_last_step` with `401 CODE_ALREADY_USED`.
  The spend itself is a **conditional UPDATE** (`User.spendTotpStep`: raise the
  column only from a lower value or NULL; `User.swapRecoveryCodes` for the
  recovery set), because a phishing relay submits its login *beside* the
  victim's and both requests read the row before either writes — the request
  that loses the race is refused as the replay it is.
  Without it a code stayed usable for its own step plus the drift step either
  side — up to 90 seconds, which is exactly the window a real-time phishing
  proxy works in. Enrolment burns its step too, so the code that switched 2FA on
  cannot be turned round on `/2fa/disable`; setup and disable clear the mark.

### Reserved identities — `utils/reservedEmail.js`

The creator's address identifies the creator, and nothing else. Two rules,
closing two different gaps:

- **`isReservedEmail(email)`** — matches `ROOT_ADMIN_EMAIL`, and works when no
  row exists. The unique index on `users.email` is what stops a second account
  today, so registration on that address fails only because the creator's row is
  sitting there; delete it (an accident, an older restore) and the address
  becomes claimable by whoever registers first. Enforced in `POST /auth/register`
  (**silently** — same `201 {ok:true,data:{}}` as any other sign-up, because a
  distinct error would point a stranger at the administrator's address),
  `POST /auth/google`, and `POST /admin/users` (a plain `400 RESERVED_ADDRESS`;
  the caller is already authenticated there).
- **`isControlPanelAccount(user)`** — `role` is `admin` or `root`. **A
  control-panel row is not a customer**, so the public auth surface may neither
  authenticate it nor write to it:
  - `POST /auth/login` refuses it, and so does `POST /auth/refresh`.
  - `requireAuth` (and `optionalAuth`) refuse it on **every** request, which is
    what kills a bearer token minted before the rule existed or before the
    account was promoted — access tokens live seven days and are stateless, so
    a check only at the mint point would have left the hole open that long.
  - **Every one of those refusals is indistinguishable from an ordinary one**:
    `401 INVALID_CREDENTIALS` at login (byte-identical to a wrong password),
    `401 INVALID_REFRESH_TOKEN` at refresh (identical to a cookie nobody
    issued), `401 SESSION_REVOKED` at `requireAuth`. Nothing on the public API
    ever says the words "control-panel", because a named refusal is worse than
    the hole it closes: credential-stuffing a leaked password would answer
    "wrong password" for thousands of ordinary addresses and "this one is the
    administrator" for exactly one — the single address on the site worth
    attacking, given away for free. Holding the password is not a reason to
    confirm anything; a reused password from an unrelated breach is exactly how
    somebody would be holding it. `/admin/login` and `/root/login` have always
    answered a *customer's* correct credentials with the same flat
    `INVALID_CREDENTIALS`; this is that rule pointed the other way.
  - The explanation is not withheld, only moved. `sendControlPanelSignInAttemptEmail`
    tells the mailbox that owns the account — which is both the answer its owner
    needs and, since the branch is only reached on a **correct** password, the
    alarm that somebody is holding a working panel password. The customer login
    page carries the standing hint ("Staff and creator accounts sign in from the
    admin console, not here") shown after *any* failed sign-in, beside the
    existing Google and no-password hints, so it guides without confirming.
  - `POST /auth/google` will not link a second credential to it, and
    `POST /auth/forgot-password` will not mint a reset link for it (answering
    `sent:true` as always, so the refusal itself reveals nothing).
    `POST /auth/reset-password` re-checks at redemption, so a link minted before
    the account was promoted still cannot be spent.
  - Any role change through `PUT /api/root/admins/:id`, and both
    `npm run create-admin` / `create-root`, call `User.revokeSessions` — a
    promotion has to end the customer session the account is holding, exactly as
    a demotion ends the panel one.

  `POST /auth/google` is the ONE public endpoint that names the reason
  (`403 RESERVED_ADDRESS`, `CONTROL_PANEL_MESSAGE`), and the difference is who
  is asking. A password proves only that somebody once typed it — it travels in
  breach dumps. Google has just proved the caller *reads that mailbox*, which is
  the same mailbox the password form's refusal is explained in, so there is
  nobody left to hide it from and a vague answer would only waste the creator's
  time.

Why these rules matter, and why login is the important one: there is **one**
`users` table and **one** `password_hash`, and `/admin/login` and `/root/login`
verify the very column the customer site reads and writes. The panels sit behind
an IP allowlist and a second factor; `/api/auth/login` has neither. While it did
not check the role, the creator's own credentials opened a customer session from
any address — and `PUT /api/user/profile` then rewrote that hash, so the customer
site was a way to *set* the panel password. The refusal is placed after the
password compare on purpose, and it is silent on purpose. Creator recovery is
`npm run create-root` on the server, which updates the existing row — something
you must already be on the box to do.

### What never leaves the server — `utils/sanitize.js`

`stripSensitive(row)` is the ONE filter every user row passes through
(`routes/admin.js`, `routes/root.js`, `routes/user.js` all alias it). There were
three hand-rolled copies and they had drifted: the admin one removed three
password/refresh hashes and nothing else, so `GET /api/admin/users/:id/details`
— which reads the row with `SELECT *` — handed a *staff* admin the creator's
`totp_secret`, the SHA-256 hashes of the creator's recovery codes and
`root_refresh_token_hash`. The recovery codes are plain SHA-256 of a ten-character
alphanumeric and crack offline, so that omission was a route from staff to
creator.

It strips an explicit list **and** anything matching
`/(password|secret|recovery|_hash$|token_version)/i`, so a credential column
added later is removed before anyone remembers this file exists. `license_key`
is deliberately not matched: it is the customer's own property and both panels
show it.

### Origin gate — `middleware/originGuard.js`
Mounted on `/api` for `POST/PUT/PATCH/DELETE`. A mutating request that **carries**
an `Origin` must carry one in `CORS_ORIGINS` or the request's own origin, else
`403 BAD_ORIGIN`. A **missing** Origin is allowed on purpose: that is every
non-browser client — the desktop app, Stripe webhooks, curl, the tests — and none
of them can be a CSRF vector, since CSRF is precisely an attack that borrows a
*browser's* ambient credentials. This is a second layer under `SameSite=Strict`
on the refresh cookies, not a replacement for it.

### Turnstile — `middleware/turnstile.js`
`requireTurnstile` runs BEFORE `validate()` on `POST /auth/register`,
`POST /auth/forgot-password`, `POST /reviews`, `POST /contact`: it reads and
deletes `body.turnstileToken` (the schemas are `.strict()`), verifies it at
Cloudflare when `TURNSTILE_SECRET_KEY` is set, and answers 400
`CAPTCHA_FAILED` on failure. No secret = gate off (dev, tests). The site sends
the token only when built with `VITE_TURNSTILE_SITE_KEY`.

A token Cloudflare *answers* about is always trusted — `success:false` fails
closed and always did. The only open branch is Cloudflare being **unreachable**,
which nobody outside Cloudflare can cause on demand, so by default sign-up, the
contact form and reviews stay up through their outage; the attempt is logged as
`[SECURITY]`. `TURNSTILE_FAIL_CLOSED=true` reverses that and answers
`503 CAPTCHA_UNAVAILABLE` instead.

### Statistics floor — `utils/stats.js`
`GET /api/stats` omits `users` / `downloads` below `STATS_MIN_USERS` (50) /
`STATS_MIN_DOWNLOADS` (100); the home strip hides the tile. Never rounds up.

### Releases: one row per version
`uq_releases_version` (schema dedupes first: keep latest → most downloads →
newest). `POST/PUT /api/admin/releases` answer 409 `VERSION_EXISTS` instead
of a 500. `Release.findByVersion(version)`.

## 7. Middleware — names + how to apply

`adminRefreshLimiter` (120/15 min) guards `/api/admin/refresh` and `/api/root/refresh`; the 5/15 min `adminLoginLimiter` stays on `/login` only — refresh runs on every full page load of the panel.


```js
const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin, requireRoot, ipWhitelist, rootIpWhitelist, isRootUser } = require('../middleware/adminAuth');
const { authLimiter, licenseLimiter, adminLoginLimiter, adsLimiter } = require('../middleware/rateLimiter');
```

- `requireAuth` — verifies user access token, rejects banned (403), attaches `req.user`.
- `requireAdmin` — **array** `[ipWhitelist, verifyAdminToken]`; pass it directly to a route
  (`router.get('/stats', requireAdmin, handler)` — Express flattens arrays).
- `requireRoot` — **array** `[rootIpWhitelist, verifyRootToken]`; accepts only the root
  token family. A staff token fails signature verification here (401), never 403.
- `ipWhitelist` — IP gate only (use standalone on `/admin/login`). Empty `ADMIN_ALLOWED_IPS` is development-only; production startup rejects it.
- `rootIpWhitelist` — IP gate for `/api/root`. Falls back to `ADMIN_ALLOWED_IPS` when
  `ROOT_ALLOWED_IPS` is empty, so the creator console is never *less* restricted.
- `isRootUser(user)` — the creator predicate: `role === 'root'` **and** the email matches
  `ROOT_ADMIN_EMAIL`. Use it instead of comparing `role` directly.
**Durable counters.** `authLimiter`, `loginLimiter`, `authIpLimiter`,
`licenseLimiter`, `adminLoginLimiter`, `contactLimiter`, `faqVoteLimiter`,
`twoFactorLimiter` and `teamInviteLimiter` count in MySQL (`rate_limits`, `middleware/rateLimitStore.js`)
so a restart — which the keepalive cron performs whenever the API looks hung — does
not hand an attacker a fresh budget. The high-volume ones (`apiLimiter` on all of
`/api`, `adsLimiter`, `downloadLimiter`) stay in memory: a database round-trip per
API request would cost far more than those counters are worth.

**Sign-in is keyed per (IP, email)**, not per IP: a single per-IP budget meant one
person mistyping their password locked out everybody behind the same office NAT.

**Every address-based key goes through `ipKey`** (`ipKeyGenerator` from
express-rate-limit), never `req.ip` directly. An IPv6 customer is handed a whole
/64 by their ISP, so a raw address as the key lets an attacker step to the next
one after every fifth guess while the counter reports nothing wrong. `ipKey`
collapses IPv6 to its prefix and leaves IPv4 byte-identical, so v4 clients are
unaffected. express-rate-limit v8 reports a raw-IP key generator as
`ERR_ERL_KEY_GEN_IPV6`.
`loginLimiter` (5/15min per account per address) is paired with `authIpLimiter`
(50/15min per address), so cycling through emails is not a way around it.

- `authLimiter` 5/15min · `loginLimiter` 5/15min per (IP,email) · `authIpLimiter` 50/15min · `licenseLimiter` 10/hour per source IP · `adminLoginLimiter` 5/15min (shared by `/admin/login` and `/admin/refresh`) · `downloadLimiter` 30/15min (`/releases/download/:os`) · `adsLimiter` 120/15min (`/api/ads` serve + event) · `apiLimiter` (global, already mounted on `/api` in app.js).
- Always wrap async handlers: `asyncHandler(async (req,res)=>{...})`.

---

## 8. Util signatures

`utils/respond.js` → `ok(res,data,status=200)`, `fail(res,code,message,status=400,details)`

`utils/accountPlan.js` — **the one answer to "which plan does this account have?"**:
```
effectivePlanFor(userId)     → { subscription, viaTeam, teamOwner }   // what the SITE shows
subscriptionForUser(userId)  → row                                    // what the APP validates against
teamSubscriptionForUser(userId) / ownSubscriptionForUser(userId) / teamPlanForUser(userId)
```
A Team member's own subscription row stays Free — the seats belong to the
owner's plan — so reading that row is not the same question as "what is this
account entitled to". Every page (`/user/me`, `/user/license`,
`/subscription/status`) and every licence path goes through here, which is why
a member no longer sees "Free" and a trial offer beside a card telling them
they are on somebody's team.

`utils/asyncHandler.js` → `asyncHandler(fn)`

`utils/jwt.js`:
```
signAccessToken(user) → 7d        verifyAccess(token)
signAdminToken(user)  → 8h        verifyAdmin(token)
  signEmailToken(user)  → 1h        verifyEmailToken(token)
signResetToken(user)  → 1h
signLicenseToken(payload) → 24h   verifyLicense(token)
generateRefreshToken() → { token, hash }   hashRefreshToken(token) → hex
```

`utils/email.js` (mock-aware): `sendVerificationEmail(user, token)`,
`sendPasswordResetEmail(user, token)`, `sendLicenseEmail(user, licenseKey, plan)`.
Links built from `FRONTEND_URL` (`/verify-email?token=`, `/reset-password?token=`).

`utils/license.js`: `generateLicenseKey() → 'NDM-XXXX-XXXX-XXXX'`,
`planSeats(plan) → number`, `planExpiry(plan, billingCycle) → Date`
(free ⇒ far future; pro/team monthly +1 month, yearly +1 year),
`TRIAL_DAYS = 7`, `TRIAL_PLAN = 'pro'`, `trialEndsAt(now = new Date()) → Date` (now + 7d),
`isTrialActive(sub, now) → boolean` (active row, `trial_ends_at` in the future, no `stripe_subscription_id`),
`isTrialExpired(sub, now) → boolean` (`trial_ends_at` past, no `stripe_subscription_id`).

`utils/releaseFeed.js` (pure, no config/DB): `buildFeed(release, os, baseUrl) → feed | null`,
`downloadRedirectUrl(baseUrl, os)`, `releaseUrlFor(release, os)`, `releaseSha256For(release, os)`.

- `utils/stripe.js` (same names in mock + real):
```
createCheckoutSession({ plan, billingCycle, user, successUrl, cancelUrl }) → { url, id }
constructEvent(rawBuffer, signature) → event object
cancelSubscription(id) → { status: 'canceled', ... }
```
-  In development mock mode `createCheckoutSession` returns a success URL with `mock_success`, `plan`, and `billingCycle`; the frontend completes it through the development-only `/api/subscription/mock-complete` route.
and `constructEvent` is `JSON.parse(raw)`.

---

## 9. PLANS catalog

`src/config/plans.js` exports `{ PLANS }`:
- `free`: `{ id, name, price:0, features:[...] }` — ad-supported
- `pro`:  `{ id, name, monthly:5, yearly:45, features:[...] }` — ad-free
- `team`: `{ id, name, monthly:15, yearly:135, seats:5, features:[...] }` — ad-free

Ad entitlement is **not** a feature-list string: `utils/ads.js#AD_FREE_PLANS` (`['pro','team']`)
is the single source of truth, read by `/api/ads` on every request.

---

## 10. Graceful degradation (boots with no external keys)

- No `STRIPE_SECRET_KEY` ⇒ `config.stripeMode` is `'mock'` on a local deployment (`utils/stripe.js` exports the mock) and `'disabled'` on production or any public `FRONTEND_URL` (checkout, portal and webhook answer `503 BILLING_UNAVAILABLE`; `GET /api/health` reports `billing`). `config.isStripeMock` / `config.isBillingDisabled` are the booleans.
- No `SMTP_HOST` ⇒ `config.isEmailMock = true`; `utils/email.js` logs emails to the console.
- `EMAIL_VERIFICATION_REQUIRED=false` lets users log in without verifying (dev default).
- `PUBLIC_API_URL` (optional) is the public origin fronting `/api`; defaults to `FRONTEND_URL`
  and must be HTTPS in production. Only used to build absolute URLs in the update feed.

- The server therefore starts locally with MySQL + development defaults. `app.js` and `env.js` **never** connect to anything
on `require`.

---

## 11. Route-file contract (rules for route agents)

1. Each `src/routes/X.js` must `module.exports = router` where `router = require('express').Router()`.
2. Define every endpoint listed for that file in §6, using the middleware + schemas named there.
3. A route agent may ONLY also add a **missing** export to **its own** domain schema file
   (e.g. the auth agent may extend `auth.schema.js`). It must **NOT** modify `app.js`,
   `package.json`, any model, any util, any other schema file, or any other route file.
4. Do **NOT** run `npm install` (deps are already installed). Do **NOT** change shared files.
5. Reuse the foundation: import `ok`/`fail`, `asyncHandler`, the jwt/email/license/stripe
   utils, and the middleware — do not reimplement them.
6. bcrypt cost is **12** for password hashing.
7. Respect the response-envelope rules (§2), including the license-validate exception.
