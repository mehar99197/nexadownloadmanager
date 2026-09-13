#!/bin/bash
# ============================================================================
# run-api.sh — keepalive for the NexaDownloadManager API on Hostinger shared
# hosting (CloudLinux, no root, no systemd).
#
# Runs from cron every minute:
#   * * * * * /bin/bash /home/u941499432/domains/nexadownloadmanager.com/nexa-api/run-api.sh >/dev/null 2>&1
#
# Behavior:
#   - flock guarantees a single instance of this script at a time. The server
#     process is started with fd 9 CLOSED (9>&-) so it does not inherit and
#     hold the lock for its whole lifetime.
#   - If the API answers /api/health on loopback, rotates the log if oversized
#     (copytruncate, safe against the live O_APPEND writer) and exits.
#   - Otherwise, if the recorded PID is alive and is our server.js and was
#     started less than BOOT_GRACE_SECS ago, assumes it is still booting
#     (first boot runs schema init) and exits. Past the grace window a
#     non-answering process is considered hung and is killed and restarted.
#   - Otherwise rotates the log if it is >= 50MB (mv — the writer is dead),
#     then starts the server with the pinned CloudLinux alt-node binary.
# Logs: ~/domains/nexadownloadmanager.com/logs/api.log (outside the webroot).
# ============================================================================
set -u

BASE="$HOME/domains/nexadownloadmanager.com"
APP_DIR="$BASE/nexa-api"
LOG_DIR="$BASE/logs"
LOG="$LOG_DIR/api.log"
PIDFILE="$APP_DIR/.api.pid"
LOCKFILE="$APP_DIR/.run-api.lock"
NODE="/opt/alt/alt-nodejs22/root/usr/bin/node"
HEALTH_URL="http://127.0.0.1:3001/api/health"
MAX_LOG_BYTES=$((50 * 1024 * 1024))   # 50MB
BOOT_GRACE_SECS=600                   # 10 min: first boot runs schema init

# These must never reach the API process:
#  - RATE_LIMIT_DISABLED=1 turns off every rate limiter outside production.
#  - BIND_HOST could re-bind the dev server off loopback.
#  - NODE_ENV must come from .env only (a stray shell export of 'production'
#    would crash-loop the boot against env.js's production gates).
unset RATE_LIMIT_DISABLED BIND_HOST NODE_ENV

mkdir -p "$LOG_DIR" || exit 1

# --- single-instance guard ---------------------------------------------------
exec 9>"$LOCKFILE" || exit 1
if ! flock -n 9; then
  exit 0   # another run of this script is already working
fi

log() {
  echo "[run-api] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"
}

# Keep secrets and mock-mode email output (tokens, license keys) private.
[ -f "$APP_DIR/.env" ] && chmod 600 "$APP_DIR/.env" 2>/dev/null
[ -f "$LOG" ] && chmod 600 "$LOG" 2>/dev/null

# --- fast path: healthy? -------------------------------------------------------
if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
  # Rotate a runaway log without touching the live writer: the server holds an
  # O_APPEND fd, so mv would just follow the inode — copy then truncate instead
  # (a few lines can be lost in the race; acceptable for this log).
  size=$(stat -c%s "$LOG" 2>/dev/null || echo 0)
  if [ "$size" -ge "$MAX_LOG_BYTES" ]; then
    cp -f "$LOG" "$LOG.1" 2>/dev/null && : > "$LOG"
    chmod 600 "$LOG.1" 2>/dev/null
    log "rotated log at $size bytes (copytruncate, server left running)"
  fi
  exit 0
fi

# --- not healthy: is our process alive (e.g. still booting / schema init)? -----
if [ -f "$PIDFILE" ]; then
  pid="$(cat "$PIDFILE" 2>/dev/null)"
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'server\.js'; then
      started=$(stat -c %Y "$PIDFILE" 2>/dev/null || echo 0)
      now=$(date +%s)
      if [ $((now - started)) -lt "$BOOT_GRACE_SECS" ]; then
        # Alive but not answering yet — give it until the next cron tick.
        exit 0
      fi
      # Alive, ours, past the boot grace, and not answering: hung. Replace it.
      log "WARNING: pid $pid alive but unhealthy for >${BOOT_GRACE_SECS}s — restarting"
      kill "$pid" 2>/dev/null
      for _ in 1 2 3 4 5; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
      done
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
    fi
  fi
fi

# --- sanity checks before starting ---------------------------------------------
if [ ! -x "$NODE" ]; then
  log "FATAL: node binary not found/executable: $NODE"
  exit 1
fi
if [ ! -f "$APP_DIR/src/server.js" ]; then
  log "FATAL: $APP_DIR/src/server.js missing — is the backend uploaded?"
  exit 1
fi
if [ ! -f "$APP_DIR/.env" ]; then
  log "FATAL: $APP_DIR/.env missing — refusing to start with fallback dev secrets"
  exit 1
fi

# --- log rotation at restart (writer is dead, so mv is safe) --------------------
size=$(stat -c%s "$LOG" 2>/dev/null || echo 0)
if [ "$size" -ge "$MAX_LOG_BYTES" ]; then
  mv -f "$LOG" "$LOG.1" 2>/dev/null
fi
touch "$LOG" && chmod 600 "$LOG" 2>/dev/null

# --- start -----------------------------------------------------------------------
# fd 9 (the flock) is explicitly closed for the child: otherwise the server
# inherits it and holds the lock for its whole lifetime, and every later cron
# tick would exit at flock without ever running the health/rotation logic.
cd "$APP_DIR" || { log "FATAL: cannot cd to $APP_DIR"; exit 1; }
log "starting API with $NODE ($($NODE -v 2>/dev/null))"
nohup "$NODE" src/server.js >> "$LOG" 2>&1 9>&- &
pid=$!
echo "$pid" > "$PIDFILE"

# --- report the outcome (first boot runs schema init, so a slow start is OK) -----
sleep 3
if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
  log "started ok (pid $pid)"
elif kill -0 "$pid" 2>/dev/null; then
  log "started (pid $pid) — health not up yet, will re-check next minute"
else
  log "ERROR: process exited immediately — see log above for the boot error"
fi
exit 0
