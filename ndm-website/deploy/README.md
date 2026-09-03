# Deploying the Nexa website

Hostinger shared hosting (CloudLinux, no root, no systemd, no Docker). The
site is built **locally** and shipped up with `deploy/build-and-upload.sh`
(rsync/ssh) — see that script's header comment for exactly what gets synced
where and what it deliberately never touches on the server.

## First deploy

```bash
# On the server, once: create nexa-api/.env by hand (never overwritten by
# the deploy script) — copy backend/.env.example and fill in real values,
# see "Secrets" below.

# From your machine, from the repo root:
./deploy/build-and-upload.sh
```

Then set up the two hPanel Cron Jobs described in "Keepalive" and "Backups"
below — Hostinger shared hosting only exposes cron via hPanel → Advanced →
Cron Jobs, there's no `crontab -e` on this account.

## Secrets

Production refuses to boot on defaults; `backend/src/config/env.js` enforces:

- `JWT_SECRET`, `JWT_ADMIN_SECRET`, `JWT_ROOT_SECRET`, `LICENSE_JWT_SECRET` — 32+ chars, all different.
  Generate with `openssl rand -base64 48`.
- `LICENSE_JWT_PRIVATE_KEY` — the Ed25519 key that signs licence tokens, from
  `npm run license:keygen`. Its public half lives in `packaging/license-public-key.txt`
  and is compiled into the desktop app, which verifies every token itself. Rotating this
  requires shipping the desktop update with the new public key **first**.
- `STRIPE_SECRET_KEY` (`sk_live_…`) and `STRIPE_WEBHOOK_SECRET` (`whsec_…`).
- `SMTP_HOST` (+ `SMTP_USER`/`SMTP_PASS`) — mock email is disabled in production.
- `CORS_ORIGINS` and `FRONTEND_URL` — HTTPS only.
- `ADMIN_ALLOWED_IPS` — must actually restrict; empty is refused.
- `ROOT_ADMIN_EMAIL` — the creator account's address.
- `TRUST_PROXY` — set to match Hostinger's reverse proxy so rate limiting and
  the admin IP allowlist see the real client IP instead of 127.0.0.1. A plain
  number is a hop count (`TRUST_PROXY=1` trusts one proxy); anything else is
  read as an address, subnet or `loopback`.
- `MYSQL_PASS` — 16+ chars, not a default.
- `AD_EVENT_SECRET` — optional; blank reuses `LICENSE_JWT_SECRET`. Keys the
  short-lived tokens that make an ad impression or click countable.

## Stripe webhook

Point it at `https://<domain>/api/webhooks/stripe` for
`checkout.session.completed`, `invoice.payment_succeeded` (or `invoice.paid` on
a newer API version — either is accepted), `invoice.payment_failed`,
`customer.subscription.updated`, `customer.subscription.deleted` and
`charge.refunded`. Events are recorded in
`stripe_webhook_events`, so Stripe's retries cannot double-charge or
double-email.

`invoice.payment_succeeded` is what extends `expiry_date` on every renewal.
**Without it subscribed customers lose access after one billing period while
still being charged**, so check it is ticked in the Stripe dashboard for any
endpoint created before this was added.

## Updating

```bash
git pull
./deploy/build-and-upload.sh
```

`build-and-upload.sh` restarts the API for you (via `nexa-api/.api.pid`) once
the new backend files land. `SKIP_FRONTEND=1` / `SKIP_ADMIN=1` /
`SKIP_BACKEND=1` deploy a subset — see the script's header for every override.

## Keepalive

`run-api.sh` health-checks the API on loopback and (re)starts it if it's
down or hung. It lives at the top level of the domain (a sibling of
`nexa-api/`, not inside it — `build-and-upload.sh` deliberately doesn't
manage it or `supervisor.sh`/`daily-maintenance.sh`, see its header comment).
Add an hPanel Cron Job:

```
* * * * * /bin/bash /home/u941499432/domains/nexadownloadmanager.com/run-api.sh >/dev/null 2>&1
```

`supervisor.sh` is a same-directory fallback loop for a shell that can't
register cron jobs — it coexists safely with the hPanel job (`run-api.sh` has
its own lock either way). Logs: `~/domains/nexadownloadmanager.com/logs/api.log`.

## Backups

`daily-maintenance.sh` (same top-level location as `run-api.sh`) runs a verified DB dump
(`backend/src/scripts/backup.sh`) and then the trial-ending reminder emails
(`backend/src/scripts/sendTrialReminders.js`) — the same two jobs the old
Docker Compose `cron` service used to run in its own container. Add a second
hPanel Cron Job:

```
15 3 * * * /bin/bash /home/u941499432/domains/nexadownloadmanager.com/daily-maintenance.sh >/dev/null 2>&1
```

Dumps land in `nexa-api/backups/`, gzipped and `gunzip -t`-verified, pruned
after `BACKUP_KEEP_DAYS` (default 14). Logs:
`~/domains/nexadownloadmanager.com/logs/daily-maintenance.log`.

```bash
# On demand, over SSH:
bash ~/domains/nexadownloadmanager.com/nexa-api/src/scripts/backup.sh \
  ~/domains/nexadownloadmanager.com/nexa-api/backups
```

Restore:

```bash
gunzip -c nexa-YYYYmmdd-HHMM.sql.gz | mysql -h HOST -u USER -p DBNAME
```

**Copy dumps off this machine.** A backup on the same disk as the database is
not a backup — sync `nexa-api/backups/` to object storage or another host on
a schedule of its own.

## Publishing a release

The desktop app's updater polls `/api/releases/feed?os=…`, which stays 404 until
a release row exists. In the admin panel → Releases, add the version, the
Windows/Linux URLs and their SHA-256, and mark it latest.

## Health

```bash
curl -fsS https://<domain>/api/health     # {"ok":true,"data":{"status":"up"}}
```
