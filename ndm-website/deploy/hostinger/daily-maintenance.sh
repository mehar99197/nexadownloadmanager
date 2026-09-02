#!/bin/bash
# ============================================================================
# daily-maintenance.sh — nightly database backup + trial-reminder emails for
# the Nexa website on Hostinger shared hosting (CloudLinux, no root, no
# systemd, no docker).
#
# Replaces docker-compose.yml's old "cron" service, which ran these same two
# jobs once a day inside its own container:
#   bash src/scripts/backup.sh /app/backups
#   node src/scripts/sendTrialReminders.js
#
# Runs from an hPanel Cron Job once a day, e.g. at 03:15 server time:
#   15 3 * * * /bin/bash /home/u941499432/domains/nexadownloadmanager.com/nexa-api/deploy/hostinger/daily-maintenance.sh >/dev/null 2>&1
#
# (Hostinger shared hosting only exposes cron via hPanel -> Advanced -> Cron
# Jobs; there is no crontab -e in this shell — same reason run-api.sh's
# keepalive is set up there instead of a real crontab.)
#
# The two jobs below are independent and non-fatal to each other, matching
# the original docker-compose "cron" service's `|| echo '...failed'`
# behavior: a failed backup must not skip trial reminders, and vice versa.
#
# Backups land in nexa-api/backups/ (outside the webroot, never touched by
# deploy/build-and-upload.sh — see its header comment).
# ============================================================================
set -u

BASE="$HOME/domains/nexadownloadmanager.com"
APP_DIR="$BASE/nexa-api"
LOG_DIR="$BASE/logs"
LOG="$LOG_DIR/daily-maintenance.log"
LOCKFILE="$APP_DIR/.daily-maintenance.lock"
BACKUP_DIR="$APP_DIR/backups"
NODE="/opt/alt/alt-nodejs22/root/usr/bin/node"

mkdir -p "$LOG_DIR" || exit 1

# --- single-instance guard ---------------------------------------------------
exec 9>"$LOCKFILE" || exit 1
if ! flock -n 9; then
  exit 0   # yesterday's run is still going (should never happen at 24h spacing)
fi

log() {
  echo "[daily-maintenance] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"
}

if [ ! -f "$APP_DIR/.env" ]; then
  log "FATAL: $APP_DIR/.env missing — refusing to run without DB credentials"
  exit 1
fi

# --- 1. Database backup ------------------------------------------------------
# CloudLinux shared hosting doesn't reliably put mysqldump on cron's minimal
# PATH — same reason run-api.sh pins node's alt-stack path instead of
# trusting PATH. Try common locations before giving up.
mysqldump_bin=""
for candidate in mysqldump /opt/alt/mysql*/bin/mysqldump /usr/bin/mysqldump; do
  found="$(command -v "$candidate" 2>/dev/null)" && { mysqldump_bin="$found"; break; }
done
if [ -z "$mysqldump_bin" ]; then
  log "backup FAILED: no mysqldump found on PATH or known alt-stack locations — add its path to the candidate list in this script"
else
  export PATH="$(dirname "$mysqldump_bin"):$PATH"
  log "starting backup -> $BACKUP_DIR"
  if bash "$APP_DIR/src/scripts/backup.sh" "$BACKUP_DIR" >> "$LOG" 2>&1; then
    log "backup ok"
  else
    log "backup FAILED — see the [backup] lines above for the reason"
  fi
fi

# --- 2. Trial-ending reminder emails ------------------------------------------
# dotenv (src/config/env.js) reads .env relative to cwd, not the script's
# location, so this must run from APP_DIR — same reason run-api.sh cd's
# before starting server.js.
if [ ! -x "$NODE" ]; then
  log "reminders FAILED: node binary not found/executable: $NODE"
elif ! cd "$APP_DIR"; then
  log "reminders FAILED: cannot cd to $APP_DIR"
else
  log "sending trial reminders"
  if "$NODE" src/scripts/sendTrialReminders.js >> "$LOG" 2>&1; then
    log "reminders ok"
  else
    log "reminders FAILED — see output above"
  fi
fi

exit 0
