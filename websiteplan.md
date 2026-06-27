# NexaDownloadManager — Website Plan

## Overview

Full-stack website for NDM with public landing page, user subscription portal, and separate admin panel.

**Stack:** React (frontend) + Node.js/Express (backend) + MongoDB (database)  
**Domain:** Single domain, Nginx reverse proxy  
**Auth:** JWT (users) + separate JWT secret (admin)

---

## Site Structure

```
nexadownloadmanager.com
│
├── PUBLIC (no login required)
│   ├── /                    Landing page
│   ├── /download            Download NDM page
│   ├── /pricing             Subscription plans
│   └── /reviews             User reviews
│
├── USER PORTAL (login required)
│   ├── /login
│   ├── /register
│   ├── /dashboard           License key + subscription status
│   ├── /billing             Buy / upgrade / cancel plan
│   └── /profile             Account settings
│
└── ADMIN PANEL (separate, IP-restricted)
    ├── /admin/login
    ├── /admin/dashboard     Stats overview
    ├── /admin/users         User management
    ├── /admin/subscriptions Revenue + active plans
    ├── /admin/reviews       Approve / reject reviews
    └── /admin/releases      NDM version management
```

---

## Pages Detail

### 1. Landing Page ( / )

- Hero section: NDM name, tagline, download button
- Feature highlights (speed, segmented download, browser extension, torrent, yt-dlp)
- Download count / user count (live from DB)
- Pricing section (3 tiers: Free, Pro, Team)
- Reviews carousel (approved reviews from DB)
- FAQ section
- Footer: links, social, contact

### 2. Download Page ( /download )

- Detect OS (Windows / Linux / Mac)
- Show correct download button based on OS
- Version number pulled from DB (admin updates it)
- Changelog section
- Browser extension links (Chrome Web Store, Firefox Add-ons)
- Installation guide steps

### 3. Pricing Page ( /pricing )

| Plan | Price | Features |
|------|-------|----------|
| Free | $0 | 3 concurrent downloads, basic speed |
| Pro | $5/mo or $45/yr | Unlimited concurrent, max speed, AI rename, priority support |
| Team | $15/mo | 5 seats, all Pro features, shared dashboard |

- Payment via Stripe (international) + manual option for PK users
- After payment: license key auto-generated, emailed

### 4. Reviews Page ( /reviews )

- Show approved reviews (star rating + comment + username + date)
- Submit review form (requires login)
- Filter by rating
- Average rating display

### 5. User Dashboard ( /dashboard )

- Welcome message with name
- Subscription status (plan, expiry date)
- License key display + copy button
- Download NDM shortcut
- Billing history table
- Change password

### 6. Admin Dashboard ( /admin/dashboard )

- Total users, active subscriptions, MRR (monthly recurring revenue)
- New signups chart (last 30 days)
- Recent payments
- Pending reviews count
- NDM version management (upload new release, set download URL)

---

## Database Schema (MongoDB)

### Collection: users
```json
{
  "_id": "ObjectId",
  "name": "string",
  "email": "string (unique)",
  "passwordHash": "string (bcrypt)",
  "role": "user | admin",
  "createdAt": "Date",
  "emailVerified": "boolean"
}
```

### Collection: subscriptions
```json
{
  "_id": "ObjectId",
  "userId": "ObjectId (ref: users)",
  "plan": "free | pro | team",
  "status": "active | expired | cancelled",
  "licenseKey": "string (unique, NDM-XXXX-XXXX-XXXX)",
  "deviceFingerprint": "string (set on first NDM activation)",
  "seats": "number (1 for pro, 5 for team)",
  "startDate": "Date",
  "expiryDate": "Date",
  "stripeSubscriptionId": "string"
}
```

### Collection: payments
```json
{
  "_id": "ObjectId",
  "userId": "ObjectId",
  "amount": "number",
  "currency": "usd",
  "plan": "pro | team",
  "billingCycle": "monthly | yearly",
  "stripePaymentId": "string",
  "status": "paid | failed | refunded",
  "createdAt": "Date"
}
```

### Collection: reviews
```json
{
  "_id": "ObjectId",
  "userId": "ObjectId",
  "userName": "string",
  "rating": "number (1-5)",
  "comment": "string",
  "status": "pending | approved | rejected",
  "createdAt": "Date"
}
```

### Collection: releases
```json
{
  "_id": "ObjectId",
  "version": "string (e.g. 2.1.0)",
  "windowsUrl": "string",
  "linuxUrl": "string",
  "changelog": "string",
  "isLatest": "boolean",
  "publishedAt": "Date"
}
```

---

## Backend API (Express)

### Auth Routes
```
POST /api/auth/register         Create account + send verify email
POST /api/auth/login            Returns JWT
POST /api/auth/verify-email     Email verification
POST /api/auth/forgot-password
POST /api/auth/reset-password
```

### User Routes (JWT required)
```
GET  /api/user/me               Profile + subscription info
PUT  /api/user/profile          Update name/password
GET  /api/user/license          Get license key
GET  /api/user/billing          Payment history
```

### Subscription Routes (JWT required)
```
GET  /api/subscription/plans    Public: list plans + prices
POST /api/subscription/checkout Create Stripe checkout session
POST /api/subscription/cancel   Cancel subscription
GET  /api/subscription/status   Current plan status
```

### NDM License Validation (called by C++ app)
```
POST /api/license/validate
Body: { "license_key": "NDM-...", "device_fingerprint": "sha256_hash" }
Response: { "valid": true, "plan": "pro", "expires": "2027-01-01", "token": "jwt" }
```

### Public Routes
```
GET  /api/reviews               Approved reviews (paginated)
POST /api/reviews               Submit review (JWT required)
GET  /api/releases/latest       Latest NDM version + download URLs
GET  /api/stats                 Public stats (users count, downloads)
```

### Admin Routes (Admin JWT required + IP check)
```
GET  /api/admin/stats
GET  /api/admin/users
PUT  /api/admin/users/:id       Ban / change plan
GET  /api/admin/subscriptions
GET  /api/admin/reviews/pending
PUT  /api/admin/reviews/:id     Approve / reject
POST /api/admin/releases        Add new NDM release
PUT  /api/admin/releases/:id    Set as latest
```

### Stripe Webhook
```
POST /api/webhooks/stripe       Handle payment success / failure / cancellation
```

---

## NDM C++ Integration

License validation flow in NDM app:

```
App launch
  ↓
Load saved license key (encrypted local storage)
  ↓
POST https://nexadownloadmanager.com/api/license/validate
  { license_key, device_fingerprint }
  ↓
Server response:
  valid=true  → unlock premium features, cache token 24hr
  valid=false → show "Enter license key" dialog
  unreachable → grace period 72hr (offline mode)
```

Device fingerprint = SHA-256 of (MAC address + CPU model string)  
Token cached locally, re-validated every 24 hours.

---

## Security Plan

### User Auth
- bcrypt password hashing (cost 12)
- JWT expiry: 7 days (user), 8 hours (admin)
- Refresh token rotation
- Email verification required before login

### Admin Panel
- Separate JWT secret (env variable)
- Nginx IP whitelist (only your IP can reach /admin/*)
- Rate limiting: 5 login attempts per 15 min
- Admin accounts only creatable via CLI script (no public register)

### License API (called by NDM)
- Rate limited: 10 requests per device per hour
- Device fingerprint binding (first activation locks key to device)
- Token expires every 24 hours (prevents sharing)

### General
- HTTPS only (Let's Encrypt)
- Helmet.js (security headers)
- CORS: whitelist only your domain
- Input validation: express-validator on all endpoints
- MongoDB injection prevention: mongoose strict schemas

---

## Project Folder Structure

```
ndm-website/
├── frontend/                   React app (public site + user portal)
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Home.jsx
│   │   │   ├── Download.jsx
│   │   │   ├── Pricing.jsx
│   │   │   ├── Reviews.jsx
│   │   │   ├── Login.jsx
│   │   │   ├── Register.jsx
│   │   │   └── Dashboard.jsx
│   │   ├── components/
│   │   └── App.jsx
│   └── package.json
│
├── admin/                      Separate React app (admin panel)
│   ├── src/
│   │   ├── pages/
│   │   │   ├── AdminLogin.jsx
│   │   │   ├── AdminDashboard.jsx
│   │   │   ├── Users.jsx
│   │   │   ├── Subscriptions.jsx
│   │   │   ├── Reviews.jsx
│   │   │   └── Releases.jsx
│   │   └── App.jsx
│   └── package.json
│
└── backend/                    Node.js + Express
    ├── src/
    │   ├── routes/
    │   │   ├── auth.js
    │   │   ├── user.js
    │   │   ├── subscription.js
    │   │   ├── license.js
    │   │   ├── reviews.js
    │   │   ├── releases.js
    │   │   ├── admin.js
    │   │   └── webhooks.js
    │   ├── models/
    │   │   ├── User.js
    │   │   ├── Subscription.js
    │   │   ├── Payment.js
    │   │   ├── Review.js
    │   │   └── Release.js
    │   ├── middleware/
    │   │   ├── auth.js         JWT verify
    │   │   ├── adminAuth.js    Admin JWT + IP check
    │   │   └── rateLimiter.js
    │   └── app.js
    ├── .env
    └── package.json
```

---

## Environment Variables (.env)

```
# Server
PORT=3001
NODE_ENV=production

# Database
MONGO_URI=mongodb+srv://...

# JWT
JWT_SECRET=long_random_string_user
JWT_ADMIN_SECRET=different_long_random_string_admin

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Email (for verification + license keys)
SMTP_HOST=smtp.hostinger.com
SMTP_USER=noreply@nexadownloadmanager.com
SMTP_PASS=...

# Admin IP whitelist (comma separated)
ADMIN_ALLOWED_IPS=your.ip.here

# License
LICENSE_JWT_SECRET=another_random_string
```

---

## Build & Deploy Order

1. MongoDB Atlas setup (free tier to start)
2. Backend Express app → test all API endpoints
3. Stripe integration → test with test keys
4. NDM C++ license validation code
5. Frontend React (public site + user portal)
6. Admin React (separate build)
7. Server setup (VPS preferred, or Railway for backend)
8. Nginx config (reverse proxy + SSL)
9. Domain DNS point
10. Go live

---

## Phase Roadmap

| Phase | What | Timeline |
|-------|------|----------|
| 1 | Backend API + MongoDB + Auth | Week 1 |
| 2 | License validation + NDM C++ integration | Week 1-2 |
| 3 | Frontend public pages (Landing, Download, Pricing) | Week 2 |
| 4 | User portal (Dashboard, Billing) | Week 2-3 |
| 5 | Stripe payment integration | Week 3 |
| 6 | Reviews system | Week 3 |
| 7 | Admin panel | Week 4 |
| 8 | Deployment + DNS + SSL | Week 4 |
