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

## Going to production (cutover from development mode)

A live billing box **must** run `NODE_ENV=production`. In development mode the
fail-closed checks in `config/env.js` are off (dev secrets and HTTP origins are
tolerated) **and Stripe runs in MOCK mode** — `config.isStripeMock` is true
whenever `STRIPE_SECRET_KEY` is blank, so `constructEvent` is `JSON.parse` and
**no real payment is ever processed or verified**. `[server] Stripe: MOCK mode`
in `logs/api.log` is the tell.

Do the cutover as one deliberate change, because production is fail-closed: a
missing or weak value makes the API refuse to boot (loudly, in the log) rather
than serve insecurely. `env.js` is the checklist — it enforces every item below.

1. **Gather first (never paste secrets into chat, tickets or commits):**
   - Stripe **live** secret `sk_live_…` and the webhook signing secret `whsec_…`
     (Stripe Dashboard → Developers).
   - The admin IP(s) for `ADMIN_ALLOWED_IPS` (empty is refused in production).
   - Real SMTP credentials (mock email is disabled in production).

2. **Generate four strong, distinct secrets** — rotating these logs everyone out
   once, which is expected at a cutover:
   ```bash
   for k in JWT_SECRET JWT_ADMIN_SECRET JWT_ROOT_SECRET LICENSE_JWT_SECRET; do
     echo "$k=$(openssl rand -base64 48 | tr -d '\n')"
   done
   ```
   `LICENSE_JWT_PRIVATE_KEY` is **separate** and already set — it signs the
   Ed25519 licence tokens and its public half is compiled into the desktop app.
   Do **not** regenerate it here, or every installed client rejects every token.

3. **Edit `nexa-api/.env` on the server** (over SSH or hPanel — the deploy never
   touches it). Back it up first (`cp .env .env.bak-$(date +%F)`), then set:
   `NODE_ENV=production`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, the four
   secrets from step 2, `ADMIN_ALLOWED_IPS` (+`ROOT_ALLOWED_IPS` if used),
   HTTPS-only `CORS_ORIGINS`/`FRONTEND_URL`/`PUBLIC_API_URL`, and `SMTP_*`.
   Confirm `TRUST_PROXY` matches Hostinger's proxy and `MYSQL_PASS` is a real
   16+ char password.

4. **Wire the Stripe webhook** as in the next section — and confirm
   `invoice.payment_succeeded` is ticked, or renewals will not extend access.

5. **Restart and verify:**
   ```bash
   bash ~/domains/nexadownloadmanager.com/run-api.sh
   tail -n 40 ~/domains/nexadownloadmanager.com/logs/api.log
   # want: "listening on 127.0.0.1:3001 (production)" and NO "Stripe: MOCK mode"
   curl -fsS https://nexadownloadmanager.com/api/health
   ```
   Then run one real end-to-end test payment in Stripe live mode.

**Rollback:** if the API refuses to boot, the log names the exact failed check —
fix that one variable and the keepalive restarts within a minute. To revert
entirely, restore the `.env.bak-…` you made in step 3.

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
