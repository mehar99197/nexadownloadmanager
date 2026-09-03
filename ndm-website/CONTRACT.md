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
// invalid
{ "valid": false, "reason": "expired", "trial": false }   // reason ∈ not_found | expired | cancelled | device_mismatch | seat_limit | invalid
```
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
| user access | 7d | `JWT_SECRET` | `signAccessToken(user)` | `verifyAccess` / `requireAuth` |
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

**Refresh token:** opaque random string in an **httpOnly cookie named `ndm_refresh`**.
Only the SHA-256 hash is stored on `User.refreshTokenHash`. Generate with
`generateRefreshToken()` → `{ token, hash }`; store `hash`, set `token` in the cookie.
On `/api/auth/refresh`, read the cookie, `hashRefreshToken(cookie)` and compare to the
stored hash (rotate on every refresh). Recommended cookie options:
```js
res.cookie('ndm_refresh', token, {
  httpOnly: true, sameSite: 'lax', secure: config.isProd,
  maxAge: 30 * 24 * 60 * 60 * 1000, path: '/api/auth',
});
```

**Admin refresh token:** same scheme for the admin SPA, cookie **`ndm_admin_refresh`**,
hash stored on `User.adminRefreshTokenHash` (`users.admin_refresh_token_hash`, 64-char hex).
Set by `POST /api/admin/login`, rotated by `POST /api/admin/refresh`, cleared by
`POST /api/admin/logout` and by `POST /api/admin/users/:id/revoke-sessions`:
```js
res.cookie('ndm_admin_refresh', token, {
  httpOnly: true, sameSite: 'lax', secure: config.isProd,
  maxAge: 8 * 60 * 60 * 1000, path: '/api/admin',
});
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
keys are rejected (injection defense). On `ZodError`: `400 VALIDATION_ERROR` with
`details = err.flatten()`.

### Exact export names per domain schema file

| File | Exports |
|------|---------|
| `auth.schema.js` | `registerSchema`, `loginSchema`, `verifyEmailSchema`, `forgotPasswordSchema`, `resetPasswordSchema` |
| `user.schema.js` | `updateProfileSchema` |
| `subscription.schema.js` | `checkoutSchema` |
| `license.schema.js` | `validateLicenseSchema` |
| `review.schema.js` | `createReviewSchema`, `listReviewsQuerySchema` |
| `admin.schema.js` | `adminLoginSchema`, `updateUserSchema`, `updateReviewSchema`, `createReleaseSchema`, `updateReleaseSchema`, `listQuerySchema`, `idParamSchema`, `sha256` |
| `root.schema.js` | `rootLoginSchema`, `createAdminSchema`, `updateAdminSchema`, `resetAdminPasswordSchema`, `idParamSchema`, `auditQuerySchema`, `deleteUserSchema` |
| `release.schema.js` | `downloadOsSchema` (`params:{ os }`), `feedQuerySchema` (`query:{ os }`) — `os ∈ windows | linux` |
| `ad.schema.js` | `createAdSchema`, `updateAdSchema`, `adIdParamSchema`, `serveAdsSchema`, `adEventSchema` |

Schema field notes:
- `registerSchema.body`: `{ name, email, password(min 8) }`
- `updateProfileSchema.body`: `{ name?, currentPassword?, newPassword?(min 8) }` (newPassword requires currentPassword)
- `checkoutSchema.body`: `{ plan: pro|team, billingCycle: monthly|yearly }`
- `validateLicenseSchema.body`: `{ license_key: /^NDM(-[A-Z0-9]{4}){3}$/, device_fingerprint: /^[a-f0-9]{16,64}$/i }`
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
- **Subscription**: numeric `id`, `userId`(FK users.id), `plan`['free','pro','team'], `status`['active','expired','cancelled' def 'active'], `licenseKey`(unique), legacy `deviceFingerprint`, `seats`, dates, `trialEndsAt`(`trial_ends_at` DATETIME null — set only for the 7-day Pro trial; cleared by paid activation), Stripe ids, timestamps. Device assignments are in `license_activations` and are transactionally capped by `seats`.
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
| POST | `/login` | `authLimiter`, `validate(loginSchema)` | check `EMAIL_VERIFICATION_REQUIRED`; return access token + set `ndm_refresh` cookie |
| POST | `/verify-email` | `validate(verifyEmailSchema)` | `verifyEmailToken(token)` → set `emailVerified=true` |
| POST | `/forgot-password` | `authLimiter`, `validate(forgotPasswordSchema)` | always 200 (no user enumeration); send reset email |
| POST | `/reset-password` | `authLimiter`, `validate(resetPasswordSchema)` | `verifyResetToken` → set new passwordHash |
| POST | `/refresh` | — | read `ndm_refresh` cookie, rotate, return new access token *(ADDED)* |
| POST | `/logout` | — | clear `ndm_refresh` cookie + null out `refreshTokenHash` *(ADDED)* |

`POST /reset-password` also nulls `adminRefreshTokenHash`.

### `routes/user.js` → `/api/user` (all `requireAuth`)
| Method | Path | Middleware |
|--------|------|-----------|
| GET | `/me` | `requireAuth` — profile + subscription; `subscription` includes `trial: boolean`, `trialEndsAt: ISO\|null` (after `expireTrialIfNeeded`) |
| PUT | `/profile` | `requireAuth`, `validate(updateProfileSchema)` |
| GET | `/license` | `requireAuth` — license key (+ `trial`, `trialEndsAt`). `403 EMAIL_NOT_VERIFIED` with `{canResend:true}` for an unverified address |
| POST | `/license/rotate` | `requireAuth`, `licenseRotateLimiter` (5/day, durable) — issue a NEW licence key and stamp `revoked_at` on every activation. Paid + `active` only (`400 NOT_ROTATABLE`), audit `license.rotated`, best-effort licence email. → `{ licenseKey, plan, devicesRevoked }`. **This is the only way to take a leaked key back**: a Team member is handed the owner's real key and no activation row records who created it, so removing them from the roster revokes nothing *(ADDED)* |
| GET | `/billing` | `requireAuth` — payment history |

### `routes/subscription.js` → `/api/subscription`
| Method | Path | Middleware |
|--------|------|-----------|
| GET | `/plans` | PUBLIC — return `PLANS` |
| POST | `/checkout` | `requireAuth`, `validate(checkoutSchema)` — `stripe.createCheckoutSession` |
| POST | `/cancel` | `requireAuth` — cancels **at period end**: `stripe.cancelSubscription(id, { atPeriodEnd: true })` and `cancel_at_period_end = 1`. The row stays `active` with its expiry intact, so the customer keeps what they paid for; `customer.subscription.deleted` (or the lazy lapse, for a plan with no Stripe subscription) is what finally returns them to Free. `400 ALREADY_CANCELLING` if one is already pending |
| POST | `/resume` | `requireAuth` — undo a pending cancellation while the period is still running. `400 NOT_CANCELLING` *(ADDED)* |
| GET | `/status` | `requireAuth` — `{ plan, status, expiryDate, seats, trial, trialEndsAt, cancelAtPeriodEnd }` (after `Subscription.current`) |
| POST | `/start-trial` | `requireAuth` — 7-day no-card Pro trial. `400 TRIAL_UNAVAILABLE` if `users.trial_used=1` or the current subscription is an active paid pro/team plan (no trial); `403 SUBSCRIPTION_STOPPED` if its status is `cancelled`/`expired`, which only ever means a person stopped it — the trial used to overwrite that row in place and hand back seven days of Pro on the very key that had been stopped. Otherwise ONE transaction: `plan='pro', status='active', seats=planSeats('pro'), start_date=now, expiry_date=trial_ends_at=now+7d, stripe_subscription_id=NULL`, `users.trial_used=1`; audit `subscription.trial_started`. → `{ plan:'pro', trial:true, trialEndsAt }` *(ADDED)* |

### `routes/license.js` → `/api/license`
| Method | Path | Middleware | Notes |
|--------|------|-----------|-------|
| POST | `/validate` | `licenseLimiter`, `validate(validateLicenseSchema)` | **LITERAL response** (see §2). `expireTrialIfNeeded` first; bind device on first activation; check expiry/status; `signLicenseToken`; always includes `trial` |

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
(206/416 handled — NDM's own users resume downloads) and only bumps
`download_count` for a fresh start, never for a resumed chunk. `buildFeed` uses
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
| POST | `/login` | `adminLoginLimiter`, `ipWhitelist`, `validate(adminLoginSchema)` — **open** (no token); verify admin user (not banned), `signAdminToken`, set `ndm_admin_refresh` cookie (§3) → `{ token, admin:{ id, name, email, role } }` *(ADDED, open)* |
| POST | `/refresh` | `adminLoginLimiter`, `ipWhitelist` — **open**; reads `ndm_admin_refresh`, verifies hash + `role==='admin'` + not banned, rotates cookie → `{ token }`. `401 NO_REFRESH_TOKEN` / `401 INVALID_REFRESH_TOKEN` / `403 FORBIDDEN` (banned; hash nulled) *(ADDED)* |
| POST | `/logout` | `ipWhitelist` — **open**; clears `ndm_admin_refresh` + nulls `adminRefreshTokenHash` → `{ loggedOut: true }` *(ADDED)* |
| GET | `/me` | `requireAdmin` → `{ id, name, email, role }` (`id` is a string, as in `/login`) *(ADDED)* |
| GET | `/stats` | `requireAdmin` — also returns `ads:{ total, active, impressions, clicks }` |
| GET | `/users` | `requireAdmin`, `validate(listQuerySchema)` |
| PUT | `/users/:id` | `requireAdmin`, `validate(updateUserSchema)` — a `plan` change also sets `trial_ends_at=NULL`. `403` if the target is an `admin`/`root` and the caller is not the creator; **no `role` field** |
| POST | `/users/:id/revoke-sessions` | `requireAdmin` — nulls `refreshTokenHash` **and** `adminRefreshTokenHash`; `403` on a control-panel target unless the caller is the creator |
| DELETE | `/users/:id` | `requireAdmin`, `validate(deleteUserSchema)` — **irreversible**. Body must carry the target's exact `confirmEmail` (`400 CONFIRM_MISMATCH`). Refuses the caller's own account (`400 SELF_LOCKOUT`), any creator (`403`), and — for a staff caller — any control-panel account (`blockedStaffTarget`). The audit row is written *before* the delete because `audit_logs.admin_user_id` is `ON DELETE SET NULL`. Data removal is the schema's cascade, not the route's: subscriptions, payments, reviews and (through subscriptions) `license_activations` + `team_members` are `ON DELETE CASCADE`; audit logs, ads and contact messages are `ON DELETE SET NULL`, so what was done outlives who did it. The creator's `/api/root/users/:id` is the same rule with a wider reach *(ADDED)* |
| GET | `/subscriptions` | `requireAdmin`, `validate(listQuerySchema)` |
| GET | `/reviews/pending` | `requireAdmin` |
| PUT | `/reviews/:id` | `requireAdmin`, `validate(updateReviewSchema)` |
| PUT | `/releases/:id/artifact/:os` | `requireAdmin`, `validate(releaseArtifactParamsSchema)` — body is the **raw installer** (`application/octet-stream`, name in `X-Filename`), streamed to `RELEASE_UPLOAD_DIR`. SHA-256 + size computed in flight and stored; the previous file is deleted only after the new one lands. `400 BAD_FILE_TYPE` / `413 FILE_TOO_LARGE` / `400 EMPTY_UPLOAD` |
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
| POST | `/login` | `adminLoginLimiter`, `rootIpWhitelist`, `validate(rootLoginSchema)` — **open**; requires `isRootUser` (role **and** `ROOT_ADMIN_EMAIL`) → `{ token, admin }` |
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
| `customer.subscription.updated` | sync from Stripe's own billing portal: period end, `cancel_at_period_end`, and the plan when the price matches one of ours (an unrecognised price leaves the stored plan alone). `past_due`/`unpaid` change nothing — Stripe is still retrying |
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

### Two-factor authentication (admin + root) — `routes/twoFactor.js`
Mounted by `routes/admin.js` (`realm:'admin'`, `JWT_ADMIN_SECRET`) and
`routes/root.js` (`realm:'root'`, `JWT_ROOT_SECRET`). Columns on `users`:
`totp_secret` (AES-256-GCM via `utils/totp.js`, key = `TOTP_ENCRYPTION_KEY` or
`JWT_ADMIN_SECRET`), `totp_enabled`, `totp_recovery` (JSON array of SHA-256
hashes; a code is removed when used).

- `POST <realm>/login` with 2FA on → `{ requiresTwoFactor:true, challenge }` (5-min JWT `typ:"2fa-<realm>"`), NO session/cookie.
- `POST <realm>/login/2fa` `{ challenge, code }` (`twoFactorLimiter` 10/15min) → the normal `{ token, admin }`; accepts a TOTP (±1 step) or a recovery code. A staff challenge never verifies under the root secret and vice versa.
- Behind the realm gate: `GET <realm>/2fa` → `{ enabled, pending, recoveryCodesLeft }`; `POST <realm>/2fa/setup` → `{ secret, otpauthUrl }` (stored, not yet enabled); `POST <realm>/2fa/enable {code}` → `{ enabled:true, recoveryCodes[8] }` shown once; `POST <realm>/2fa/disable { password, code }`.
- `GET <realm>/me` adds `twoFactorEnabled`; `User.listStaff` includes `totp_enabled`; root `POST /api/root/admins/:id/reset-2fa` clears a staff admin's second factor and revokes sessions.
- **A code is spent once.** `users.totp_last_step` is a monotonic high-water mark
  and `checkCode` refuses `step <= totp_last_step` with `401 CODE_ALREADY_USED`.
  Without it a code stayed usable for its own step plus the drift step either
  side — up to 90 seconds, which is exactly the window a real-time phishing
  proxy works in. Enrolment burns its step too, so the code that switched 2FA on
  cannot be turned round on `/2fa/disable`; setup and disable clear the mark.

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
*browser's* ambient credentials. This is a second layer under `SameSite=Lax`, not
a replacement for it.

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
`licenseLimiter`, `adminLoginLimiter`, `contactLimiter`, `twoFactorLimiter` and
`teamInviteLimiter` count in MySQL (`rate_limits`, `middleware/rateLimitStore.js`)
so a restart — which the keepalive cron performs whenever the API looks hung — does
not hand an attacker a fresh budget. The high-volume ones (`apiLimiter` on all of
`/api`, `adsLimiter`, `downloadLimiter`) stay in memory: a database round-trip per
API request would cost far more than those counters are worth.

**Sign-in is keyed per (IP, email)**, not per IP: a single per-IP budget meant one
person mistyping their password locked out everybody behind the same office NAT.
`loginLimiter` (5/15min per account per address) is paired with `authIpLimiter`
(50/15min per address), so cycling through emails is not a way around it.

- `authLimiter` 5/15min · `loginLimiter` 5/15min per (IP,email) · `authIpLimiter` 50/15min · `licenseLimiter` 10/hour per source IP · `adminLoginLimiter` 5/15min (shared by `/admin/login` and `/admin/refresh`) · `downloadLimiter` 30/15min (`/releases/download/:os`) · `adsLimiter` 120/15min (`/api/ads` serve + event) · `apiLimiter` (global, already mounted on `/api` in app.js).
- Always wrap async handlers: `asyncHandler(async (req,res)=>{...})`.

---

## 8. Util signatures

`utils/respond.js` → `ok(res,data,status=200)`, `fail(res,code,message,status=400,details)`

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
