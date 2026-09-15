# Deploying the website

The website is three apps on one Hostinger shared-hosting account
(CloudLinux: no root, no systemd, no Docker).

| App | Built from | Lands in |
|---|---|---|
| Public site | `ndm-website/frontend` | `~/domains/nexadownloadmanager.com/public_html/` |
| Control panels | `ndm-website/admin` | `~/domains/nexadownloadmanager.com/public_html/admin/` |
| API | `ndm-website/backend` | `~/domains/nexadownloadmanager.com/nexa-api/` (outside the webroot) |

One command does all three:

```bash
./deploy/build-and-upload.sh                      # everything
SKIP_FRONTEND=1 SKIP_BACKEND=1 ./deploy/build-and-upload.sh   # just the panels
```

**Read that script's header before deploying by hand.** It is the authority on
what must never be overwritten — `.htaccess`, `api-proxy.php`, `nexa-api/.env`,
`.api.pid`, `logs/`, `uploads/`, `backups/` — and on how it restarts the API
(via the pidfile, because the process cmdline is just `node src/server.js` and
other sites on the account run their own node processes, so a broad `pkill`
would miss it or kill the wrong site).

## How the API stays up

There is no service manager. `~/domains/nexadownloadmanager.com/run-api.sh`
(source of truth: `ndm-website/deploy/hostinger/run-api.sh`) runs every minute
from an hPanel cron job, health-checks `http://127.0.0.1:3001/api/health`, and
restarts `node src/server.js` if it is missing or hung. `flock` keeps it to one
instance; the pid is recorded in `nexa-api/.api.pid`.

Requests reach it through LiteSpeed: `public_html/.htaccess` routes `/api/*` to
`public_html/api-proxy.php`, which streams to `127.0.0.1:3001`. Those two files
are deployed by hand and are excluded from every sync.

`daily-maintenance.sh` (also top-level, also hand-deployed, also an hPanel cron
job) takes the nightly database dump into `nexa-api/backups/` and sends trial
reminder emails.

The API log is **`~/domains/nexadownloadmanager.com/logs/api.log`** — beside
`run-api.sh`, *not* inside `nexa-api/`. `nexa-api/logs/` also exists and is
empty (the deploy creates it), so grepping there returns a confident zero for
lines that are really in the other file. Everything the process writes to stdout
and stderr lands in the real one, `console.warn` included — that is where the
`[SECURITY] …` lines are.

**Successful `/api/health` requests are deliberately not logged**
(`backend/src/app.js`), so their absence from that log says nothing about
whether the keepalive is running. Nor does `.run-api.lock`'s mtime (truncating
an already-empty file does not update it).

The way to actually see it work is a deploy: `build-and-upload.sh` signals the
old process and does **not** start a new one, so `/api/health` answers
`502 UPSTREAM_DOWN` until the cron's next minute. Watch it come back —

```bash
until curl -sf https://nexadownloadmanager.com/api/health; do sleep 10; done
ssh hostinger 'cd ~/domains/nexadownloadmanager.com/nexa-api \
  && ps -o lstart=,cmd= -p "$(cat .api.pid)" && stat -c %y src/routes/auth.js'
```

— and confirm the process start time is *after* the uploaded files' mtime. That
also proves the running process loaded the build you just shipped, which a file
checksum alone does not. Measured 2026-09-08: down at 12:08, back at 12:09.

## Verifying a deploy

Hostinger's bot protection answers **403** to headless browsers on the live
domain, so "open the page and look" is not available. Verify in two halves:

1. Measure the local `dist/` in a browser (serve it over a static server).
2. Prove the live server is serving *those exact bytes*:

```bash
curl -s https://nexadownloadmanager.com/assets/index-<hash>.js | sha256sum
sha256sum ndm-website/frontend/dist/assets/index-<hash>.js
```

Then check the routes and the API gate:

```bash
for r in "" pricing download compare docs faq login register dashboard billing; do
  printf "%-12s %s\n" "/$r" "$(curl -s -o /dev/null -w '%{http_code}' https://nexadownloadmanager.com/$r)"
done
curl -s https://nexadownloadmanager.com/api/health          # {"ok":true,...,"status":"up"}
curl -s -o /dev/null -w '%{http_code}\n' https://nexadownloadmanager.com/api/user/me   # 401, never 500
```

The prerendered shells are metadata-only (`<div id="root"></div>`), so markup
assertions cannot come from the served HTML — which is why step 2 carries the
weight.

## Rolling back

Take a backup before every upload and keep it in `$HOME`, outside the webroot:

```bash
ssh hostinger 'cd ~/domains/nexadownloadmanager.com \
  && tar czf ~/nexa-frontend-pre-<change>-$(date +%Y%m%d-%H%M%S).tar.gz \
       --exclude="public_html/admin" -C . public_html'
```

Restoring is the same tar, extracted back over `~/domains/nexadownloadmanager.com`.
Backups live on the same disk as the site, so they survive a bad deploy but not
a lost account — copy anything you care about off the machine.

Old hashed bundles are not deleted by the sync. Remove a superseded one **by
name**, and only after confirming nothing references it:

```bash
ssh hostinger 'cd ~/domains/nexadownloadmanager.com/public_html \
  && grep -rl "index-<oldhash>" . || echo "unreferenced — safe to remove"'
```

## Email deliverability

Measured 2026-09-08: the control-panel sign-in alert reached the creator's
mailbox and Gmail filed it under **Spam** ("similar to messages that were
identified as spam in the past"). Every transactional mail this site sends has
the same problem — verification links, password resets, licence keys, receipts.

The cause is the From address, not the content:

| | Today | Why it matters |
|---|---|---|
| `FROM_EMAIL` | `nexadownloadmanager@gmail.com` | a free consumer account with no service sending reputation |
| Links in the mail | `nexadownloadmanager.com` | From-domain ≠ link-domain is the classic phishing fingerprint |
| Domain SPF | `v=spf1 include:_spf.mail.hostinger.com ~all` | authorises **Hostinger**, and does not apply to mail sent from gmail.com at all |
| Domain DKIM | none found on `default`/`google`/`hostinger`/`mail`/`selector1`/`selector2`/`dkim`/`k1`/`s1` | nothing signs mail as this domain |
| Domain DMARC | `v=DMARC1; p=none` | monitoring only, no policy |
| Domain MX | `mx1/mx2.hostinger.com` | a mailbox on the domain is already possible |

`config/env.js` warns about the From/site mismatch at every boot (a warning, not
a `problems` entry — filtered mail still leaves a working site, so it must not
refuse to start).

**The fix, in hPanel — none of it is code:**

1. Create a mailbox on the domain, e.g. `noreply@nexadownloadmanager.com`.
   The MX records already point at Hostinger.
2. Point the API at it in `nexa-api/.env`, then restart:
   `SMTP_HOST=smtp.hostinger.com`, `SMTP_PORT=465`,
   `SMTP_USER=noreply@nexadownloadmanager.com`, `SMTP_PASS=<its password>`,
   `FROM_EMAIL=noreply@nexadownloadmanager.com`.
   The boot warning above goes away on its own when this is right.
3. Turn **DKIM on for the domain** in hPanel's email settings. This is the one
   with the largest effect and it is currently absent entirely.
4. Only once 1–3 are live and mail is landing in the inbox, tighten DMARC from
   `p=none` to `p=quarantine`. Doing it before DKIM exists would quarantine the
   site's own mail.

Verify afterwards by sending one to a Gmail address and opening
**Show original**: SPF, DKIM and DMARC must all read `PASS`, and the signing
domain must be `nexadownloadmanager.com`.

## Still to configure

These are live-key decisions, not code:

- **Stripe** — no `STRIPE_SECRET_KEY`, so billing runs *disabled*: checkout, the
  portal and the webhook answer 503. Never mock mode on a public box.
  Needs `sk_live_` + `whsec_` in `nexa-api/.env`, the webhook pointed at
  `/api/webhooks/stripe`, and the temporary deny rule dropped from `.htaccess`.
- **Turnstile** — `TURNSTILE_SECRET_KEY` (server) and `VITE_TURNSTILE_SITE_KEY`
  (build time) must be set together; either alone leaves the widget off or the
  form unsubmittable.
- **Root 2FA** — only the creator can enrol their own account.
