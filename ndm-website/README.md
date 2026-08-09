# NexaDownloadManager — Website

Full-stack website for NexaDownloadManager (NDM): public landing page, user
subscription portal, and a separate IP-restricted admin panel. Three apps live
under this directory.

| App | Path | Stack | Purpose |
|-----|------|-------|---------|
| **backend** | `backend/` | Node.js + Express + MySQL2 + raw SQL + Zod | REST API: auth, subscriptions, Stripe billing, license validation (called by the NDM C++ app), reviews, releases, admin |
| **frontend** | `frontend/` | React (Vite) | Public site + logged-in user portal (dashboard, billing, profile) |
| **admin** | `admin/` | React (Vite) | Separate admin panel build (users, subscriptions, reviews, releases) |

The single source of truth for the backend API contract is
[`CONTRACT.md`](./CONTRACT.md) — read it before touching any route file.

## Running locally

### Backend
```bash
cd backend
npm install
cp .env.example .env          # then edit secrets (or leave Stripe/SMTP blank for mock mode)
npm run seed                  # optional: seed a release + sample reviews
npm run create-admin          # optional: create an admin account
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

### Admin
```bash
cd admin
npm install
npm run dev                   # http://localhost:5174
```

## Health check
```bash
curl http://localhost:3001/api/health     # → {"ok":true,"data":{"status":"up"}}
```
