# Deploying the Nexa website

One VPS, Docker Compose: MySQL, the API, nginx with TLS, the two static builds,
and a nightly job for backups + trial reminders.

## First deploy

```bash
git clone <repo> && cd ndm-website

cp backend/.env.example backend/.env
$EDITOR backend/.env            # see "Secrets" below — production fails fast without them

# Root/app DB passwords are read by compose itself:
cat >> .env <<'ENV'
MYSQL_PASS=<same as backend/.env MYSQL_PASS>
MYSQL_ROOT_PASS=<a different long random password>
PUBLIC_URL=https://nexadownloadmanager.com
ENV

# 1. Certificate first — nginx will not start without one.
docker compose up -d db
docker run --rm -p 80:80 \
  -v ndm-website_certbot-conf:/etc/letsencrypt \
  -v ndm-website_certbot-www:/var/www/certbot \
  certbot/certbot certonly --standalone \
  -d nexadownloadmanager.com -d www.nexadownloadmanager.com \
  --agree-tos -m you@example.com --no-eff-email

# 2. Everything else.
docker compose up -d --build
docker compose logs -f api
```

`frontend-build` and `admin-build` run once, drop their `dist/` into the shared
volumes nginx serves, and exit — seeing them "Exited (0)" is correct.

## Secrets

Production refuses to boot on defaults; `backend/src/config/env.js` enforces:

- `JWT_SECRET`, `JWT_ADMIN_SECRET`, `LICENSE_JWT_SECRET` — 32+ chars, all different.
  Generate with `openssl rand -base64 48`.
- `STRIPE_SECRET_KEY` (`sk_live_…`) and `STRIPE_WEBHOOK_SECRET` (`whsec_…`).
- `SMTP_HOST` (+ `SMTP_USER`/`SMTP_PASS`) — mock email is disabled in production.
- `CORS_ORIGINS` and `FRONTEND_URL` — HTTPS only.
- `ADMIN_ALLOWED_IPS` — must actually restrict; empty is refused.
- `TRUST_PROXY` — set to `1` for the single nginx in front. Getting this wrong
  breaks rate limiting and the admin IP allowlist, which both read the client IP.
- `MYSQL_PASS` — 16+ chars, not a default.

## Stripe webhook

Point it at `https://<domain>/api/webhooks/stripe` for
`checkout.session.completed`, **`invoice.paid`** (renewals — without it every
monthly licence reads `expired` from month two while Stripe keeps charging),
`customer.subscription.updated` (portal reactivation / cancel-at-period-end),
`customer.subscription.deleted` and `invoice.payment_failed`. Events are
recorded in `stripe_webhook_events`, so Stripe's retries cannot double-charge
or double-email.

## Updating

```bash
git pull
docker compose up -d --build      # migrate runs before api serves traffic
```

## Backups

The `cron` service runs `backup.sh` nightly into the `backups` volume: a
`--single-transaction` dump, gzipped, verified non-empty and `gunzip -t`-clean,
keeping 14 days (`BACKUP_KEEP_DAYS`).

```bash
docker compose exec api bash src/scripts/backup.sh /app/backups   # on demand
docker compose exec api ls -la /app/backups
docker run --rm -v ndm-website_backups:/b -v "$PWD":/out alpine \
  cp /b/nexa-YYYYmmdd-HHMM.sql.gz /out/                            # copy one out
```

Restore:

```bash
gunzip -c nexa-YYYYmmdd-HHMM.sql.gz | \
  docker compose exec -T db mysql -u root -p"$MYSQL_ROOT_PASS" ndm_prod
```

**Copy dumps off this machine.** A backup on the same disk as the database is
not a backup — sync the volume to object storage or another host.

## Publishing a release

The desktop app's updater polls `/api/releases/feed?os=…`, which stays 404 until
a release row exists. In the admin panel → Releases, add the version, the
Windows/Linux URLs and their SHA-256, and mark it latest.

## Health

```bash
curl -fsS https://<domain>/api/health     # {"ok":true,"data":{"status":"up"}}
docker compose ps                          # api should be "healthy"
```
