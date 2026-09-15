#!/usr/bin/env bash
#
# deploy/build-and-upload.sh
#
# Build the Nexa website on the LOCAL machine and upload it to Hostinger
# shared hosting over rsync/ssh. Safe to re-run at any time (idempotent):
# every phase rebuilds from a clean state and rsync only ships differences.
#
#   frontend  ndm-website/frontend  -> ~/domains/nexadownloadmanager.com/public_html/
#   admin     ndm-website/admin     -> ~/domains/nexadownloadmanager.com/public_html/admin/
#   backend   ndm-website/backend   -> ~/domains/nexadownloadmanager.com/nexa-api/   (outside webroot)
#
# What is deliberately NEVER touched on the server:
#   public_html/.htaccess       (routing: SPA fallback + /api proxy + /root mount)
#   public_html/.user.ini       (PHP overrides for api-proxy.php; shipped with DEPLOY_HTACCESS=1)
#   public_html/api-proxy.php   (streams /api/* to 127.0.0.1:3001)
#   public_html/admin/          (protected during the frontend sync; admin has its own sync)
#   public_html/.well-known/    (host-managed, e.g. ACME/verification files)
#   nexa-api/.env               (server secrets; written once on the server, never clobbered)
#   nexa-api/.env.bak-*         (pre-cutover copies of .env)
#   nexa-api/.api.pid           (written by the keepalive run-api.sh; deleting it double-starts the API)
#   nexa-api/.run-api.lock      (the keepalive's flock file; deleting it breaks single-instance)
#   nexa-api/logs/              (runtime logs)
#   nexa-api/uploads/           (admin-uploaded release installers; RELEASE_UPLOAD_DIR default)
#   nexa-api/backups/           (nightly DB dumps written by daily-maintenance.sh)
#   nexa-api/.daily-maintenance.lock  (that script's flock file; deleting it breaks single-instance)
#
# Process model on the server (owned by the keepalive deploy step, not here):
#   ~/domains/nexadownloadmanager.com/run-api.sh runs every minute (cron or the
#   supervisor.sh loop), health-checks http://127.0.0.1:3001/api/health, and
#   (re)starts `node src/server.js` with cwd nexa-api/. It records the pid in
#   nexa-api/.api.pid — that pidfile is how THIS script restarts the API after
#   an upload. (The process cmdline is just "node src/server.js", and other
#   sites on this account run their own node processes, so a broad pkill would
#   either miss it or kill the wrong site.)
#
#   ~/domains/nexadownloadmanager.com/daily-maintenance.sh (top level, a
#   sibling of run-api.sh/supervisor.sh, deployed by hand like they are) runs
#   once a day from an hPanel Cron Job — a nightly DB backup + trial-reminder
#   emails, replacing the two jobs the old docker-compose.yml "cron" service
#   used to run.
#
# Usage (from the repo root):
#   ./deploy/build-and-upload.sh
#
# Optional environment overrides:
#   VITE_SITE_URL            canonical/OG origin baked into the frontend (default the live domain)
#   VITE_TURNSTILE_SITE_KEY  Cloudflare Turnstile site key (blank = widget off; pair with
#                            TURNSTILE_SECRET_KEY in the server's nexa-api/.env)
#   VITE_PLAUSIBLE_DOMAIN    Plausible analytics domain (blank = no analytics script)
#   VITE_PLAUSIBLE_SRC       self-hosted Plausible script URL (optional)
#   VITE_GOOGLE_CLIENT_ID    Google Sign-In client ID baked into the frontend. Default:
#                            the GOOGLE_CLIENT_ID in the server's nexa-api/.env, read over
#                            SSH at preflight — the two MUST match (it is the audience
#                            every ID token is checked against), so the server's copy is
#                            the source of truth. An override that differs is refused.
#   RESTART_BACKEND=0        skip restarting the remote node process after upload
#   SKIP_FRONTEND=1 / SKIP_ADMIN=1 / SKIP_BACKEND=1   deploy a subset
#   DEPLOY_HTACCESS=1        also upload deploy/hostinger/public_html.htaccess (the
#                            server copy is backed up OUTSIDE public_html first)
#                            and public_html.user.ini beside it.
#                            Off by default: routing + CSP live in that file and
#                            a bad one takes the whole site down.
#
# The frontend phase also packages the browser extension (extension-chromium/
# package.sh, extension-firefox/build.sh) into dist/downloads/, because the
# download page links nexa-chrome.zip / nexa-edge.zip / nexa-firefox.zip there
# until the store listings are live. `zip` and `unzip` must be on PATH.

set -euo pipefail

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
SSH_USER="u941499432"
SSH_HOST="145.79.30.42"
SSH_PORT="65002"
REMOTE="${SSH_USER}@${SSH_HOST}"
RSH="ssh -p ${SSH_PORT}"

# Paths relative to the remote $HOME.
REMOTE_SITE="domains/nexadownloadmanager.com"
WEBROOT="${REMOTE_SITE}/public_html"
API_DIR="${REMOTE_SITE}/nexa-api"

# Repo layout (script lives in deploy/, one level under the repo root).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE="${REPO_ROOT}/ndm-website"
FRONTEND="${SITE}/frontend"
ADMIN="${SITE}/admin"
BACKEND="${SITE}/backend"

# Build-time frontend environment.
#
# Exported (not written to a .env file) on purpose: Vite gives real environment
# variables precedence over .env files, and scripts/prerender.mjs reads
# process.env directly and never loads .env files at all. Exporting is the only
# way that guarantees the hydrated bundle (usePageMeta.js) and the prerendered
# shells agree on the canonical origin.
export VITE_API_URL="${VITE_API_URL:-/api}"                       # same-origin via api-proxy.php
# Running from MSYS2/Git Bash on Windows: the runtime rewrites POSIX-looking
# environment values for native programs, and "/api" reaches Vite as
# "C:/msys64/api" — the bundle then calls that as its API base. Exclude it.
export MSYS2_ENV_CONV_EXCL="${MSYS2_ENV_CONV_EXCL:+${MSYS2_ENV_CONV_EXCL};}VITE_API_URL"
export VITE_SITE_URL="${VITE_SITE_URL:-https://nexadownloadmanager.com}"
export VITE_TURNSTILE_SITE_KEY="${VITE_TURNSTILE_SITE_KEY:-}"     # blank = widget off
export VITE_PLAUSIBLE_DOMAIN="${VITE_PLAUSIBLE_DOMAIN:-}"         # blank = no analytics
export VITE_PLAUSIBLE_SRC="${VITE_PLAUSIBLE_SRC:-}"

# @playwright/test is a frontend devDependency; never download browser
# binaries during a deploy install (e2e uses the system Chrome anyway).
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RESTART_BACKEND="${RESTART_BACKEND:-1}"
DEPLOY_HTACCESS="${DEPLOY_HTACCESS:-0}"
SKIP_FRONTEND="${SKIP_FRONTEND:-0}"
SKIP_ADMIN="${SKIP_ADMIN:-0}"
SKIP_BACKEND="${SKIP_BACKEND:-0}"

phase() { printf '\n==> %s\n' "$*"; }
die()   { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

STAGE=""
cleanup() {
  if [[ -n "${STAGE}" && -d "${STAGE}" ]]; then rm -rf "${STAGE}"; fi
  return 0
}
trap cleanup EXIT

# --------------------------------------------------------------------------
# Phase 0 — preflight
# --------------------------------------------------------------------------
phase "Phase 0: preflight checks"

for cmd in node npm rsync ssh zip unzip; do
  command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' is required on this machine"
done
[[ -f "${FRONTEND}/package.json" ]] || die "not a nexadownloadmanager repo root: ${FRONTEND}/package.json missing"
[[ -f "${ADMIN}/package.json"    ]] || die "missing ${ADMIN}/package.json"
[[ -f "${BACKEND}/package.json"  ]] || die "missing ${BACKEND}/package.json"
[[ -f "${BACKEND}/package-lock.json" ]] || die "backend needs package-lock.json for npm ci"

# Local .env files are fine (exported vars above outrank them in Vite), but
# say so out loud so a stray value is never a silent surprise.
for envfile in "${FRONTEND}/.env" "${ADMIN}/.env"; do
  if [[ -f "$envfile" ]]; then
    echo "NOTE: $envfile exists; exported VITE_* values above take precedence over it."
  fi
done

echo "Checking SSH connectivity to ${REMOTE}:${SSH_PORT} ..."
ssh -p "${SSH_PORT}" -o BatchMode=yes -o ConnectTimeout=15 "${REMOTE}" \
  "command -v rsync >/dev/null" \
  || die "cannot reach ${REMOTE}:${SSH_PORT} with key auth (or rsync missing on the host)"
echo "SSH OK. Site origin: ${VITE_SITE_URL}"

# "Continue with Google": the button renders only when the frontend is built
# with a client ID, and the backend accepts only tokens minted for ITS client
# ID (GOOGLE_CLIENT_ID in nexa-api/.env). Read the server's value so the bundle
# is always built with the same one — the ID is public (it ships in the page),
# nothing else in .env is read. A blank on the server means the feature is off
# on both sides, which is consistent.
SERVER_GOOGLE_CLIENT_ID="$(ssh -p "${SSH_PORT}" -o BatchMode=yes "${REMOTE}" \
  "grep -E '^GOOGLE_CLIENT_ID=' '${API_DIR}/.env' 2>/dev/null | tail -1 | cut -d= -f2-" || true)"
SERVER_GOOGLE_CLIENT_ID="$(printf '%s' "${SERVER_GOOGLE_CLIENT_ID}" | tr -d "\"' \r")"   # unquote, drop CR
if [[ -n "${VITE_GOOGLE_CLIENT_ID:-}" && -n "${SERVER_GOOGLE_CLIENT_ID}" \
      && "${VITE_GOOGLE_CLIENT_ID}" != "${SERVER_GOOGLE_CLIENT_ID}" ]]; then
  die "VITE_GOOGLE_CLIENT_ID differs from the server's GOOGLE_CLIENT_ID — every Google sign-in would fail (audience mismatch)"
fi
export VITE_GOOGLE_CLIENT_ID="${VITE_GOOGLE_CLIENT_ID:-${SERVER_GOOGLE_CLIENT_ID}}"
if [[ -n "${VITE_GOOGLE_CLIENT_ID}" ]]; then
  echo "Google Sign-In: ON (client …${VITE_GOOGLE_CLIENT_ID: -30})"
else
  echo "Google Sign-In: OFF (no GOOGLE_CLIENT_ID on the server, none given)"
fi

# --------------------------------------------------------------------------
# Phase 1 — build frontend (vite build + prerender)
# --------------------------------------------------------------------------
if [[ "${SKIP_FRONTEND}" != "1" ]]; then
  phase "Phase 1: building frontend (npm ci + vite build + prerender)"
  (
    cd "${FRONTEND}"
    npm ci --no-audit --no-fund
    npm run build          # = vite build && node scripts/prerender.mjs
  )

  [[ -f "${FRONTEND}/dist/index.html" ]] || die "frontend build produced no dist/index.html"
  # The prerendered shells must carry the live origin in canonical + og:url.
  grep -q "rel=\"canonical\" href=\"${VITE_SITE_URL}/pricing\"" "${FRONTEND}/dist/pricing/index.html" \
    || die "prerendered /pricing shell lacks canonical ${VITE_SITE_URL}/pricing"
  grep -q "property=\"og:url\" content=\"${VITE_SITE_URL}/download\"" "${FRONTEND}/dist/download/index.html" \
    || die "prerendered /download shell lacks og:url ${VITE_SITE_URL}/download"

  # The browser extension, as the download page links it. Both packagers
  # validate the manifests and refuse an inline <script>, so a broken package
  # never ships; the unzip -t is the same check CI runs on its artifacts.
  phase "Phase 1b: packaging the browser extension into dist/downloads/"
  "${REPO_ROOT}/extension-chromium/package.sh"
  "${REPO_ROOT}/extension-firefox/build.sh"
  mkdir -p "${FRONTEND}/dist/downloads"
  for z in nexa-chrome.zip nexa-edge.zip nexa-firefox.zip; do
    [[ -f "${REPO_ROOT}/dist/${z}" ]] || die "extension packager produced no dist/${z}"
    unzip -tq "${REPO_ROOT}/dist/${z}" >/dev/null || die "dist/${z} is not a valid zip"
    cp "${REPO_ROOT}/dist/${z}" "${FRONTEND}/dist/downloads/${z}"
  done

  # Content-Security-Policy guard. The shells carry ONE inline script (the boot
  # screen + theme stamp in index.html) and the .htaccess allows it by SHA-256
  # hash. If the block was edited, the hash below changes and every browser
  # silently drops the script — no boot screen, a flash of the wrong theme —
  # while curl still sees a healthy 200. Refuse to deploy until the .htaccess
  # in the repo names the new hash (and remember: that file is uploaded
  # separately, see DEPLOY_HTACCESS).
  HTACCESS_SRC="${SITE}/deploy/hostinger/public_html.htaccess"
  INLINE_HASHES="$(node "${SITE}/frontend/scripts/inline-script-hashes.mjs" "${FRONTEND}/dist/index.html")"
  for h in ${INLINE_HASHES}; do
    grep -q -- "'${h}'" "${HTACCESS_SRC}" \
      || die "dist/index.html carries an inline script the CSP does not allow. Add '${h}' to script-src in ${HTACCESS_SRC} and deploy it (DEPLOY_HTACCESS=1)."
  done
  echo "CSP: inline script hash(es) allowed by .htaccess: ${INLINE_HASHES:-none}"
  grep -q "${VITE_SITE_URL}/sitemap.xml" "${FRONTEND}/dist/robots.txt" \
    || die "dist/robots.txt does not point at ${VITE_SITE_URL}/sitemap.xml"
  # A build-machine path in the bundle means an environment value was
  # rewritten on the way into Vite (see MSYS2_ENV_CONV_EXCL above); the site
  # would then request its API from a Windows drive letter.
  if grep -lE '[A-Za-z]:/(msys64|Users|Program)' "${FRONTEND}"/dist/assets/*.js >/dev/null 2>&1; then
    die "frontend bundle contains a local filesystem path — VITE_API_URL is '${VITE_API_URL}', check the build environment"
  fi
  echo "Frontend dist verified (per-route canonical/og:url baked for ${VITE_SITE_URL})."
else
  phase "Phase 1: SKIPPED (frontend)"
fi

# --------------------------------------------------------------------------
# Phase 2 — build admin (base /admin/, dual-mounted at /admin and /root)
# --------------------------------------------------------------------------
if [[ "${SKIP_ADMIN}" != "1" ]]; then
  phase "Phase 2: building admin panel (npm ci + vite build, base=/admin/)"
  (
    cd "${ADMIN}"
    npm ci --no-audit --no-fund
    npm run build
  )

  [[ -f "${ADMIN}/dist/index.html" ]] || die "admin build produced no dist/index.html"
  # Every asset URL must be absolute under /admin/ so the SAME dist serves
  # both the /admin and /root mounts (realm.js decides which panel renders).
  grep -Eq 'src="/admin/assets/[^"]+"' "${ADMIN}/dist/index.html" \
    || die "admin dist/index.html does not reference /admin/assets/ — check vite base"
  if grep -Eq '(src|href)="/(assets|src)/' "${ADMIN}/dist/index.html"; then
    die "admin dist/index.html references root-relative assets; /root mount would 404"
  fi
  if grep -lE '[A-Za-z]:/(msys64|Users|Program)' "${ADMIN}"/dist/assets/*.js >/dev/null 2>&1; then
    die "admin bundle contains a local filesystem path — VITE_API_URL is '${VITE_API_URL}', check the build environment"
  fi
  echo "Admin dist verified (all assets absolute under /admin/; safe for the /root mount)."
else
  phase "Phase 2: SKIPPED (admin)"
fi

# --------------------------------------------------------------------------
# Phase 3 — stage backend in a clean temp copy
# --------------------------------------------------------------------------
if [[ "${SKIP_BACKEND}" != "1" ]]; then
  phase "Phase 3: staging backend (clean copy + npm ci --omit=dev)"
  STAGE="$(mktemp -d)"
  echo "Staging in ${STAGE}"

  # Copy ONLY what the server needs: manifest, lockfile, source. This
  # inherently excludes test/, Dockerfile, node_modules/, uploads/ and the
  # local development .env.
  cp "${BACKEND}/package.json" "${BACKEND}/package-lock.json" "${STAGE}/"
  cp -R "${BACKEND}/src" "${STAGE}/src"

  (
    cd "${STAGE}"
    npm ci --omit=dev --no-audit --no-fund
  )

  [[ -d "${STAGE}/node_modules/express" ]] || die "staged backend is missing express — npm ci failed?"
  [[ ! -e "${STAGE}/.env" ]] || die "staged backend unexpectedly contains a .env"
  # All backend deps are pure JS (bcryptjs, mysql2, ...): no native builds to
  # worry about across node versions. Fail loudly if that ever changes.
  NATIVE="$(find "${STAGE}/node_modules" \( -name '*.node' -o -name 'binding.gyp' \) -print -quit 2>/dev/null || true)"
  if [[ -n "${NATIVE}" ]]; then
    die "backend now has native modules (${NATIVE}); install node_modules ON the host with alt-node npm instead"
  fi
  echo "Backend staged: $(du -sh "${STAGE}" | cut -f1) (production deps only, no tests, no .env)"
else
  phase "Phase 3: SKIPPED (backend)"
fi

# --------------------------------------------------------------------------
# Phase 4 — ensure remote directory layout
# --------------------------------------------------------------------------
phase "Phase 4: ensuring remote directories"
ssh -p "${SSH_PORT}" "${REMOTE}" \
  "mkdir -p '${WEBROOT}/admin' '${API_DIR}/logs' '${API_DIR}/uploads/releases'"
echo "Remote layout OK: ${WEBROOT}/, ${WEBROOT}/admin/, ${API_DIR}/{logs,uploads/releases}/"

# --------------------------------------------------------------------------
# Phase 4a — .htaccess (opt-in). Routing, the /api proxy and the CSP all live
# here, so it is never synced blindly: the live copy is backed up outside
# public_html (the frontend sync would delete a .bak beside it), then replaced.
# --------------------------------------------------------------------------
if [[ "${DEPLOY_HTACCESS}" == "1" ]]; then
  phase "Phase 4a: uploading public_html/.htaccess (server copy backed up first)"
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  ssh -p "${SSH_PORT}" "${REMOTE}" \
    "mkdir -p ~/${REMOTE_SITE}/htaccess-backups && cp ~/${WEBROOT}/.htaccess ~/${REMOTE_SITE}/htaccess-backups/htaccess.${STAMP} 2>/dev/null || true"
  rsync -az --chmod=Fu=rw,Fgo=r -e "${RSH}" \
    "${SITE}/deploy/hostinger/public_html.htaccess" "${REMOTE}:${WEBROOT}/.htaccess"
  echo ".htaccess uploaded (previous copy: ~/${REMOTE_SITE}/htaccess-backups/htaccess.${STAMP})"
  # The PHP overrides for api-proxy.php travel with it. lsphp reads .user.ini
  # per directory (php_value in .htaccess is a 500 on this host); the frontend
  # sync below excludes it, otherwise --delete-after removed it on every deploy.
  rsync -az --chmod=Fu=rw,Fgo=r -e "${RSH}" "${SITE}/deploy/hostinger/public_html.user.ini" "${REMOTE}:${WEBROOT}/.user.ini"
  echo ".user.ini uploaded"
fi

# --------------------------------------------------------------------------
# Phase 5 — upload frontend -> public_html/
# --------------------------------------------------------------------------
if [[ "${SKIP_FRONTEND}" != "1" ]]; then
  phase "Phase 5: uploading frontend dist -> ${WEBROOT}/"
  # --delete-after removes stale hashed assets (and Hostinger's default.php),
  # but the excludes below are delete-protected: .htaccess, .user.ini,
  # api-proxy.php, admin/ and .well-known/ live in public_html yet are owned
  # elsewhere (.well-known by the hosting platform itself).
  rsync -az --delete-after \
    --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r \
    --exclude='.htaccess' \
    --exclude='.user.ini' \
    --exclude='api-proxy.php' \
    --exclude='admin/' \
    --exclude='.well-known/' \
    -e "${RSH}" \
    "${FRONTEND}/dist/" "${REMOTE}:${WEBROOT}/"
  echo "Frontend uploaded."
else
  phase "Phase 5: SKIPPED (frontend upload)"
fi

# --------------------------------------------------------------------------
# Phase 6 — upload admin -> public_html/admin/
# --------------------------------------------------------------------------
if [[ "${SKIP_ADMIN}" != "1" ]]; then
  phase "Phase 6: uploading admin dist -> ${WEBROOT}/admin/"
  rsync -az --delete-after \
    --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r \
    -e "${RSH}" \
    "${ADMIN}/dist/" "${REMOTE}:${WEBROOT}/admin/"
  echo "Admin uploaded (serves both /admin and /root via .htaccess)."
else
  phase "Phase 6: SKIPPED (admin upload)"
fi

# --------------------------------------------------------------------------
# Phase 7 — upload backend -> nexa-api/ (outside webroot)
# --------------------------------------------------------------------------
if [[ "${SKIP_BACKEND}" != "1" ]]; then
  phase "Phase 7: uploading backend -> ${API_DIR}/"
  # Server-only state is excluded, which protects it from both transfer and
  # --delete: .env (secrets), .api.pid and .run-api.lock (owned by the
  # run-api.sh keepalive — deleting the pidfile double-starts the API and
  # deleting the lock file breaks its single-instance flock), logs/ and
  # uploads/ (admin-uploaded installers). node_modules IS shipped (pure-JS
  # deps; the host has no usable system npm workflow for this).
  #
  # backups/, .env.bak-* and .daily-maintenance.lock were named in this
  # script's header as "never touched" but were NOT in this list, so
  # --delete-after removed them on every single deploy. That silently destroyed
  # the nightly database dumps daily-maintenance.sh had just verified: the
  # backups appeared to be working (a good log line every night) while no dump
  # ever survived to the next deploy. Anything server-only MUST be listed here,
  # not merely described above.
  rsync -az --delete-after \
    --exclude='.env' \
    --exclude='.env.bak-*' \
    --exclude='.api.pid' \
    --exclude='.run-api.lock' \
    --exclude='.daily-maintenance.lock' \
    --exclude='logs/' \
    --exclude='uploads/' \
    --exclude='backups/' \
    -e "${RSH}" \
    "${STAGE}/" "${REMOTE}:${API_DIR}/"
  echo "Backend uploaded."

  if [[ "${RESTART_BACKEND}" == "1" ]]; then
    phase "Phase 7b: restarting backend process"
    # Restart via the keepalive's pidfile, NOT pkill: the server's cmdline is
    # just "node src/server.js" (run-api.sh starts it with cwd nexa-api/), so
    # a pattern like 'nexa-api/src/server.js' matches nothing, and a broad
    # 'src/server.js' pattern could kill node processes belonging to OTHER
    # sites on this shared account. The cmdline check below mirrors
    # run-api.sh's own guard against pid reuse. After the kill, the keepalive
    # (cron/supervisor.sh, <=60s tick) starts the new code.
    ssh -p "${SSH_PORT}" "${REMOTE}" "sh -s" <<REMOTE_EOF
pid=\$(cat "${API_DIR}/.api.pid" 2>/dev/null)
if [ -n "\$pid" ] && kill -0 "\$pid" 2>/dev/null \
   && tr '\0' ' ' < "/proc/\$pid/cmdline" 2>/dev/null | grep -q "src/server.js"; then
  kill "\$pid" && echo "old API process (pid \$pid) signalled; keepalive will start the new build"
else
  echo "no running API process found via ${API_DIR}/.api.pid; keepalive will start the new build"
fi
exit 0
REMOTE_EOF
  else
    echo "RESTART_BACKEND=0: remember the running process still serves the OLD code."
  fi
else
  phase "Phase 7: SKIPPED (backend upload)"
fi

# --------------------------------------------------------------------------
# Done
# --------------------------------------------------------------------------
phase "Deploy complete"
cat <<EOF
Uploaded:
  frontend -> ${REMOTE}:${WEBROOT}/            (kept: .htaccess, .user.ini, api-proxy.php, admin/, .well-known/)
  admin    -> ${REMOTE}:${WEBROOT}/admin/      (one dist, mounted at /admin and /root)
  backend  -> ${REMOTE}:${API_DIR}/            (kept: .env, .env.bak-*, .api.pid, .run-api.lock, logs/, uploads/, backups/)

Not handled here (separate deploy steps):
  - public_html/.htaccess, .user.ini (both: DEPLOY_HTACCESS=1) and api-proxy.php
  - nexa-api/.env secrets and the run-api.sh keepalive (cron/supervisor.sh)
Smoke test:
  curl -sI https://nexadownloadmanager.com/pricing | head -1
  curl -s  https://nexadownloadmanager.com/api/health
EOF


