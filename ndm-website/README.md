# NexaDownloadManager — Website

Full-stack website for NexaDownloadManager (NDM): public landing page, user
subscription portal, and two IP-restricted control panels. Three apps live
under this directory.

| App | Path | Stack | Purpose |
|-----|------|-------|---------|
| **backend** | `backend/` | Node.js + Express + MySQL2 + raw SQL + Zod | REST API: auth, subscriptions, Stripe billing, license validation (called by the NDM C++ app), reviews, releases, admin, root |
| **frontend** | `frontend/` | React (Vite) | Public site + logged-in user portal (dashboard, billing, profile) |
| **admin** | `admin/` | React (Vite) | One build serving **both** control panels (see below) |

### Two control panels

The `admin/` build is served at two mount points and renders a different panel
at each. It reads the URL to decide which (`admin/src/realm.js`); the server
gates each panel's API independently, so this is presentation, not security.

| | Staff admin | Root / creator |
|---|---|---|
| URL | `/admin` | `/root` |
| API | `/api/admin/*` | `/api/root/*` **and** `/api/admin/*` |
| Sign in | `/admin/login` | `/root/login` |
| Manage customers, reviews, releases, ads | yes | yes |
| Manage admin accounts and roles | **no** | yes |
| Full audit trail, delete accounts | **no** | yes |

The two tiers use separate JWT secrets and separate session cookies, so a staff
token is rejected on `/api/root` and the creator cannot sign in at `/admin/login`.
A creator account can only be created by `npm run create-root` — no HTTP route
can mint or promote one. See [`CONTRACT.md`](./CONTRACT.md) §3.

The single source of truth for the backend API contract is
[`CONTRACT.md`](./CONTRACT.md) — read it before touching any route file.

## Running locally

### Backend
```bash
cd backend
npm install
cp .env.example .env          # then edit secrets (or leave Stripe/SMTP blank for mock mode)
npm run create-root -- "Owner" owner@example.com 'a-long-password'   # the creator
npm run create-admin          # optional: a staff admin account
npm run dev                   # http://localhost:3001
```
The backend boots with **no** Stripe or SMTP keys — billing runs in mock mode and
emails are logged to the console (see CONTRACT.md "Graceful degradation").

Requires MySQL 8+ (or MariaDB with compatible InnoDB/SQL features). Configure
`MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASS`, and `MYSQL_DB` in `.env`.

### Frontend
```bash
cd frontend
npm install
npm run dev                   # http://localhost:5173
```

Set `ROOT_ADMIN_EMAIL` in `.env` to the creator's address before running
`create-root` — the script refuses to create an account the server would reject.

### Control panels
```bash
cd admin
npm install
npm run dev                   # http://localhost:5174/admin/  (staff)
                              # http://localhost:5174/root/   (creator)
```
Both mounts come from the one dev server; `vite.config.js` serves the same SPA
shell for `/root` navigations, matching what nginx does in production.

## Health check
```bash
curl http://localhost:3001/api/health     # → {"ok":true,"data":{"status":"up"}}
```
