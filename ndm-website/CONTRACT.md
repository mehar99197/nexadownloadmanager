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
                 license.schema.js  review.schema.js  admin.schema.js
    middleware/  validate.js  auth.js  adminAuth.js  rateLimiter.js  errorHandler.js
    utils/       asyncHandler.js  respond.js  jwt.js  email.js  license.js  stripe.js
    routes/      auth.js  user.js  subscription.js  license.js
                 reviews.js  releases.js  admin.js  webhooks.js
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

### THE ONE EXCEPTION — `POST /api/license/validate`

This endpoint is consumed by the NDM **C++ app**, so it returns a LITERAL shape,
**NOT** the envelope:

```json
// valid
{ "valid": true, "plan": "pro", "expires": "2027-01-01T00:00:00.000Z", "token": "<24h jwt>" }
// invalid
{ "valid": false, "reason": "expired" }   // reason ∈ not_found | expired | cancelled | device_mismatch | invalid
```
Always HTTP 200 with this body (even when `valid:false`) so the C++ client parses it cleanly.

---

## 3. Authentication

Header: `Authorization: Bearer <token>`.

| Token | TTL | Secret | Signed by | Verified by |
|-------|-----|--------|-----------|-------------|
| user access | 7d | `JWT_SECRET` | `signAccessToken(user)` | `verifyAccess` / `requireAuth` |
| admin | 8h | `JWT_ADMIN_SECRET` | `signAdminToken(user)` | `verifyAdmin` / `requireAdmin` |
| email verify | 1h | `JWT_SECRET` | `signEmailToken(user)` | `verifyEmailToken` |
| password reset | 1h | `JWT_SECRET` | `signResetToken(user)` | `verifyResetToken` |
| license | 24h | `LICENSE_JWT_SECRET` | `signLicenseToken(payload)` | `verifyLicense` |

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

### Request shapes after middleware
- `req.user` — MySQL user row (set by `requireAuth`). Use `req.user.id`, `.email`, `.role`.
- `req.admin` — MySQL user row with `role === 'admin'` (set by `requireAdmin`).

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
| `admin.schema.js` | `adminLoginSchema`, `updateUserSchema`, `updateReviewSchema`, `createReleaseSchema`, `updateReleaseSchema`, `listQuerySchema`, `idParamSchema` |

Schema field notes:
- `registerSchema.body`: `{ name, email, password(min 8) }`
- `updateProfileSchema.body`: `{ name?, currentPassword?, newPassword?(min 8) }` (newPassword requires currentPassword)
- `checkoutSchema.body`: `{ plan: pro|team, billingCycle: monthly|yearly }`
- `validateLicenseSchema.body`: `{ license_key: /^NDM(-[A-Z0-9]{4}){3}$/, device_fingerprint: /^[a-f0-9]{16,64}$/i }`
- `createReviewSchema.body`: `{ rating: 1..5, comment }`
- `listReviewsQuerySchema.query`: `{ page=1, limit=10, rating? }` (coerced)
- admin `updateUserSchema.body`: `{ banned?, role?, plan? }`; `updateReviewSchema.body`: `{ status }`
- admin `idParamSchema.params` / `*ReleaseSchema.params` / `updateUserSchema.params`: positive numeric MySQL id

---

## 5. Models (fields)

- **User**: numeric `id`, `name`, `email`(unique,lowercase,index), `passwordHash`, `role`['user','admin' default 'user'], `emailVerified`(bool def false), `banned`(bool def false), `refreshTokenHash`(String def null), timestamps (`createdAt`/`updatedAt`).
- **Subscription**: numeric `id`, `userId`(FK users.id), `plan`['free','pro','team'], `status`['active','expired','cancelled' def 'active'], `licenseKey`(unique), legacy `deviceFingerprint`, `seats`, dates, Stripe ids, timestamps. Device assignments are in `license_activations` and are transactionally capped by `seats`.
- **Payment**: `userId`, `amount`, `currency`(def 'usd'), `plan`, `billingCycle`['monthly','yearly'], `stripePaymentId`, `status`['paid','failed','refunded' def 'paid'], timestamps.
- **Review**: `userId`, `userName`, `rating`(1..5), `comment`, `status`['pending','approved','rejected' def 'pending'], timestamps.
- **Release**: `version`, `windowsUrl`, `linuxUrl`, `changelog`, `isLatest`(bool def false), `publishedAt`(def now), timestamps.

---

## 6. Endpoint list (what each route file must implement)

All paths below are **relative to the mount** shown in the header, e.g. in
`routes/auth.js` define `router.post('/register', ...)` → served at `/api/auth/register`.

### `routes/auth.js` → `/api/auth`
| Method | Path | Middleware | Notes |
|--------|------|-----------|-------|
| POST | `/register` | `authLimiter`, `validate(registerSchema)` | create user (bcrypt cost 12), free Subscription + license, send verify email |
| POST | `/login` | `authLimiter`, `validate(loginSchema)` | check `EMAIL_VERIFICATION_REQUIRED`; return access token + set `ndm_refresh` cookie |
| POST | `/verify-email` | `validate(verifyEmailSchema)` | `verifyEmailToken(token)` → set `emailVerified=true` |
| POST | `/forgot-password` | `authLimiter`, `validate(forgotPasswordSchema)` | always 200 (no user enumeration); send reset email |
| POST | `/reset-password` | `authLimiter`, `validate(resetPasswordSchema)` | `verifyResetToken` → set new passwordHash |
| POST | `/refresh` | — | read `ndm_refresh` cookie, rotate, return new access token *(ADDED)* |
| POST | `/logout` | — | clear `ndm_refresh` cookie + null out `refreshTokenHash` *(ADDED)* |

### `routes/user.js` → `/api/user` (all `requireAuth`)
| Method | Path | Middleware |
|--------|------|-----------|
| GET | `/me` | `requireAuth` — profile + subscription |
| PUT | `/profile` | `requireAuth`, `validate(updateProfileSchema)` |
| GET | `/license` | `requireAuth` — license key |
| GET | `/billing` | `requireAuth` — payment history |

### `routes/subscription.js` → `/api/subscription`
| Method | Path | Middleware |
|--------|------|-----------|
| GET | `/plans` | PUBLIC — return `PLANS` |
| POST | `/checkout` | `requireAuth`, `validate(checkoutSchema)` — `stripe.createCheckoutSession` |
| POST | `/cancel` | `requireAuth` — `stripe.cancelSubscription` + set status `cancelled` |
| GET | `/status` | `requireAuth` — current plan status |

### `routes/license.js` → `/api/license`
| Method | Path | Middleware | Notes |
|--------|------|-----------|-------|
| POST | `/validate` | `licenseLimiter`, `validate(validateLicenseSchema)` | **LITERAL response** (see §2). Bind device on first activation; check expiry/status; `signLicenseToken` |

### `routes/reviews.js` → `/api/reviews`
| Method | Path | Middleware |
|--------|------|-----------|
| GET | `/` | PUBLIC, `validate(listReviewsQuerySchema)` — approved only, paginated, avg rating |
| POST | `/` | `requireAuth`, `validate(createReviewSchema)` — status `pending` |

### `routes/releases.js` → `/api/releases`
| Method | Path | Middleware |
|--------|------|-----------|
| GET | `/latest` | PUBLIC — the `isLatest` release |

### `routes/admin.js` → `/api/admin`
| Method | Path | Middleware |
|--------|------|-----------|
| POST | `/login` | `adminLoginLimiter`, `ipWhitelist`, `validate(adminLoginSchema)` — **open** (no token); verify admin user, `signAdminToken` *(ADDED, open)* |
| GET | `/stats` | `requireAdmin` |
| GET | `/users` | `requireAdmin`, `validate(listQuerySchema)` |
| PUT | `/users/:id` | `requireAdmin`, `validate(updateUserSchema)` |
| GET | `/subscriptions` | `requireAdmin`, `validate(listQuerySchema)` |
| GET | `/reviews/pending` | `requireAdmin` |
| PUT | `/reviews/:id` | `requireAdmin`, `validate(updateReviewSchema)` |
| GET | `/releases` | `requireAdmin` — list ALL releases *(ADDED)* |
| POST | `/releases` | `requireAdmin`, `validate(createReleaseSchema)` |
| PUT | `/releases/:id` | `requireAdmin`, `validate(updateReleaseSchema)` — set latest |

### `routes/webhooks.js` → `/api/webhooks`
| Method | Path | Middleware | Notes |
|--------|------|-----------|-------|
| POST | `/stripe` | — | body is a **raw Buffer** (mounted with `express.raw` in app.js). Use `stripe.constructEvent(req.body, req.headers['stripe-signature'])`. Handle `checkout.session.completed` / payment success → create Payment + activate Subscription + email license; handle cancellation. Respond `200 { received: true }` (plain, not envelope, for Stripe). |

**Public endpoints already in `app.js` (do NOT redefine):** `GET /api/health`, `GET /api/stats`.

---

## 7. Middleware — names + how to apply

```js
const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin, ipWhitelist } = require('../middleware/adminAuth');
const { authLimiter, licenseLimiter, adminLoginLimiter } = require('../middleware/rateLimiter');
```

- `requireAuth` — verifies user access token, rejects banned (403), attaches `req.user`.
- `requireAdmin` — **array** `[ipWhitelist, verifyAdminToken]`; pass it directly to a route
  (`router.get('/stats', requireAdmin, handler)` — Express flattens arrays).
- `ipWhitelist` — IP gate only (use standalone on `/admin/login`). Empty `ADMIN_ALLOWED_IPS` is development-only; production startup rejects it.
- `authLimiter` 5/15min · `licenseLimiter` 10/hour per source IP · `adminLoginLimiter` 5/15min · `apiLimiter` (global, already mounted on `/api` in app.js).
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
(free ⇒ far future; pro/team monthly +1 month, yearly +1 year).

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
- `free`: `{ id, name, price:0, features:[...] }`
- `pro`:  `{ id, name, monthly:5, yearly:45, features:[...] }`
- `team`: `{ id, name, monthly:15, yearly:135, seats:5, features:[...] }`

---

## 10. Graceful degradation (boots with no external keys)

- No `STRIPE_SECRET_KEY` ⇒ `config.isStripeMock = true`; `utils/stripe.js` exports the mock.
- No `SMTP_HOST` ⇒ `config.isEmailMock = true`; `utils/email.js` logs emails to the console.
- `EMAIL_VERIFICATION_REQUIRED=false` lets users log in without verifying (dev default).

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
