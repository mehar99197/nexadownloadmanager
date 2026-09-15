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
- `STRIPE_SECRET_KEY` (`sk_live_…`) and `STRIPE_WEBHOOK_SECRET` (`whsec_…`) — optional:
  blank runs the site with billing disabled (see the next section); a key is
  refused without its webhook secret.
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
- `TURNSTILE_SECRET_KEY` — optional; blank turns the bot gate off. Pair it with
  the frontend's build-time `VITE_TURNSTILE_SITE_KEY`; both come from one
  Turnstile widget in the Cloudflare dashboard, and neither half works alone.
  `TURNSTILE_FAIL_CLOSED=true` refuses the gated endpoints while Cloudflare is
  unreachable instead of letting visitors through.

## Going to production (cutover from development mode)

**The production checks no longer depend on `NODE_ENV` alone.** Any deployment
whose `FRONTEND_URL` is a public address is treated as public by
`config/deployment.js`, and `config/env.js` then enforces the whole production
checklist regardless of `NODE_ENV`. The live box ran for weeks as
`NODE_ENV=development` on the real domain — dev secrets tolerated, Stripe in
mock mode accepting unsigned webhooks, cookies without `Secure`, stack traces in
500s — and nothing refused. Now it refuses, and the log lists **every** missing
item at once so the `.env` is fixed in one edit.

**Stripe is no longer required to go live.** With no `STRIPE_SECRET_KEY` a
public deployment runs with billing **disabled**: checkout, the billing portal
and the webhook answer `503 BILLING_UNAVAILABLE`, `/api/health` reports
`billing: "disabled"`, and everything else (accounts, trials, free licences,
admin-granted plans, the desktop app) works. Mock mode — `constructEvent` as
`JSON.parse`, the dev-only `/mock-complete` route — now exists **only** on a
local, non-production deployment. So the cutover has two independent halves:

### Half 1 — harden the box (do this now, no Stripe needed)

1. **Gather:** the admin IP(s) for `ADMIN_ALLOWED_IPS`, and SMTP credentials
   (Hostinger: `smtp.hostinger.com`, port 465, a real mailbox). Mock email is
   refused on a public box because it writes verification links, reset tokens
   and licence keys into a log file instead of sending them.

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

3. **Check what the server .env looks like right now** — this prints only key
   names, lengths and whether a value is a known dev default, never a value:
   ```bash
   ssh -p 65002 u941499432@145.79.30.42 'cd domains/nexadownloadmanager.com/nexa-api && \
     for k in NODE_ENV TRUST_PROXY ADMIN_ALLOWED_IPS ROOT_ADMIN_EMAIL FRONTEND_URL SMTP_HOST \
              STRIPE_SECRET_KEY JWT_SECRET JWT_ADMIN_SECRET JWT_ROOT_SECRET LICENSE_JWT_SECRET MYSQL_PASS; do \
       v=$(grep -E "^$k=" .env | tail -1 | cut -d= -f2- | tr -d "\""); \
       case "$v" in dev_*|change_me*|ndm_secret) f=" DEV-DEFAULT";; "") f=" BLANK";; *) f="";; esac; \
       echo "$k: len=${#v}$f"; done'
   ```

4. **Edit `nexa-api/.env` on the server** (over SSH or hPanel — the deploy never
   touches it). Back it up first (`cp .env .env.bak-$(date +%F)`), then set:
   `NODE_ENV=production`, the four secrets from step 2, `ADMIN_ALLOWED_IPS`
   (+`ROOT_ALLOWED_IPS` if used), `TRUST_PROXY=1` (the PHP shim is exactly one
   hop), HTTPS-only `CORS_ORIGINS`/`FRONTEND_URL`/`PUBLIC_API_URL`, `SMTP_*`,
   `ROOT_ADMIN_EMAIL`, and a real 16+ character `MYSQL_PASS`. Leave
   `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` blank until Half 2.

5. **Deploy this backend, restart and verify:**
   ```bash
   ./deploy/build-and-upload.sh            # from the repo root, on your machine
   ssh -p 65002 u941499432@145.79.30.42 'tail -n 40 ~/domains/nexadownloadmanager.com/logs/api.log'
   # want: "production checks ON" and "Stripe: DISABLED", no WARNING lines
   curl -fsS https://nexadownloadmanager.com/api/health
   # want: {"ok":true,"data":{"status":"up","billing":"disabled"}}
   ```
   If the API refuses to boot, the log lists every failing variable under
   `[config] Refusing to start`; fix them all and the keepalive restarts within
   a minute. To revert entirely, restore the `.env.bak-…` from step 4.

6. **Take the production signing key off your development machine.** The
   local `backend/.env` must not carry `LICENSE_JWT_PRIVATE_KEY` at all: with
   it unset a local server signs with the built-in dev seed, which development
   builds of the desktop app (`-DNEXA_DEV_BUILD=ON`) trust. `server.js` warns at
   boot while a local deployment still holds the shipped key. The server's
   `.env` is the one place that key belongs — and note the nightly backup is a
   **database** dump, it does not include `.env`. Before deleting the local
   copy, put the key in a password manager or another offline secure store:
   losing every copy would force a key rotation and a desktop release.

### Half 2 — turn payments on (when the Stripe account is ready)

1. Get the **live** secret `sk_live_…` and the webhook signing secret `whsec_…`
   (Stripe Dashboard → Developers). Never paste them into chat, tickets or commits.
2. Set both in `nexa-api/.env`. A key without its webhook secret is refused.
3. **Wire the Stripe webhook** as in the next section — and confirm
   `invoice.payment_succeeded` is ticked, or renewals will not extend access.
4. Remove the temporary `api/webhooks/stripe` deny rule from
   `public_html/.htaccess` (see the comment there) so Stripe can deliver.
5. Restart, check the log says `Stripe: LIVE`, and run one real end-to-end
   test payment in live mode.

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

## The .htaccess is a separate upload

`build-and-upload.sh` deliberately never touches `public_html/.htaccess` — it is
the routing file, and a half-finished sync of it takes the whole site down. When
`deploy/hostinger/public_html.htaccess` changes in the repo, ship it by hand and
keep a copy of what was there:

```bash
ssh -p 65002 u941499432@145.79.30.42 \
  'cd ~/domains/nexadownloadmanager.com && mkdir -p htaccess-backups &&
   cp -a public_html/.htaccess htaccess-backups/htaccess.bak-$(date +%F-%H%M)'

rsync -e 'ssh -p 65002' -av ndm-website/deploy/hostinger/public_html.htaccess \
  u941499432@145.79.30.42:domains/nexadownloadmanager.com/public_html/.htaccess
```

The backup lives OUTSIDE `public_html` on purpose: the frontend sync runs with
`--delete-after` and only protects the exact name `.htaccess`, so a
`.htaccess.bak-…` beside it is deleted by the next deploy.

That file now carries the **Content-Security-Policy** for the site and both
panels. Its `script-src` has no `'unsafe-inline'`, which is the whole value of
it — so after any change, `curl -sI` for the header and then open `/`, `/admin`
and `/root` in a browser and check the console for "Refused to load". A CSP that
blocks a bundle returns a perfectly good 200 to curl and a blank page to users.

`DEPLOY_HTACCESS=1 ./deploy/build-and-upload.sh` does the backup-and-upload
above for you (backups land in `~/domains/nexadownloadmanager.com/htaccess-backups/`).

### The one inline script and its hash

`frontend/index.html` has exactly one inline `<script>` — the first-visit boot
screen and the theme stamp that stops the flash of the wrong theme — and the
CSP allows it by SHA-256 hash (`'sha256-…'` in `script-src`). The hash covers
the script's exact bytes, so:

- editing that block changes the hash. `build-and-upload.sh` recomputes it from
  the built `dist/index.html` (`frontend/scripts/inline-script-hashes.mjs`) and
  refuses to deploy until `public_html.htaccess` in the repo carries the new
  value — it prints the value to paste. Then ship the `.htaccess` too.
- line endings count. `.gitattributes` pins `frontend/index.html` to LF so a
  Windows checkout builds the same bytes as a Linux one. (The site once shipped
  a CRLF shell whose hash was not in the CSP: browsers dropped the script
  silently — no boot screen, a light-theme flash for dark-mode readers on every
  load — while every curl check passed.)

### www.

`.htaccess` 301s `www.nexadownloadmanager.com` to the apex. Serving both as
separate origins split the session cookies and made "Continue with Google"
fail on www. ("origin is not allowed for the given client ID").

## The browser extension packages

Until the store listings are live, the download page and `/docs/extension` link
`/downloads/nexa-chrome.zip`, `nexa-edge.zip` and `nexa-firefox.zip`. They are
static files: Phase 1b of `build-and-upload.sh` runs `extension-chromium/package.sh`
and `extension-firefox/build.sh` and copies the results into `dist/downloads/`,
so every frontend deploy ships the extension that matches the checkout. `zip`
and `unzip` must be installed on the machine that deploys.

## Updating

```bash
git pull
./deploy/build-and-upload.sh
```

`build-and-upload.sh` restarts the API for you (via `nexa-api/.api.pid`) once
the new backend files land. `SKIP_FRONTEND=1` / `SKIP_ADMIN=1` /
`SKIP_BACKEND=1` deploy a subset — see the script's header for every override.

The restart is a `kill`; the keepalive (below) is what starts the new build.
If the hPanel cron job is not ticking — `stat nexa-api/.run-api.lock` on the
server tells you when `run-api.sh` last ran — start it yourself right after
the script finishes, or the site answers 5xx on `/api` until somebody does:

```bash
ssh -p 65002 u941499432@145.79.30.42 \
  '/bin/bash ~/domains/nexadownloadmanager.com/run-api.sh; curl -s http://127.0.0.1:3001/api/health'
```

### Deploying from Windows

The script needs `rsync`, `zip`, `unzip` and an `ssh` that can find the deploy
key. Git Bash ships none of the first three, so use MSYS2 (`pacman -S rsync
openssh zip unzip`), with two Windows-specific traps handled:

- MSYS2's `ssh` resolves `~` from its own passwd database, not `$HOME`, so the
  key and `known_hosts` must live in `C:\msys64\home\<user>\.ssh\` (copy them
  there once, `chmod 600`).
- The MSYS2 runtime rewrites POSIX-looking *environment values* for native
  programs: `VITE_API_URL=/api` reaches Vite as `C:/msys64/api`, and the bundle
  then calls that as its API base — every page that touches the API fails with
  a working curl. The script exports `MSYS2_ENV_CONV_EXCL=VITE_API_URL` and
  refuses to upload a bundle that contains a local drive path, but keep it in
  mind for any other path-like value you add.

```bash
MSYSTEM=MSYS C:/msys64/usr/bin/bash -lc \
  'export PATH="/c/Program Files/nodejs:$PATH"; cd /c/path/to/nexadownloadmanager && ./deploy/build-and-upload.sh'
```

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
Start it detached so it outlives the SSH session:

```bash
ssh -p 65002 u941499432@145.79.30.42 \
  'cd ~/domains/nexadownloadmanager.com && nohup setsid /bin/bash ./supervisor.sh >/dev/null 2>&1 </dev/null & disown'
```

It is a stopgap: the host reaps long-running shells eventually and nothing
restarts the loop itself. The hPanel cron job is the real keepalive — verify it
exists (hPanel → Advanced → Cron Jobs) whenever `.run-api.lock` is older than a
minute while the API is healthy.

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
