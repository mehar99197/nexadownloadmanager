#!/usr/bin/env bash
#
# A throwaway database for the integration tests, on Windows.
#
# The suites in test/*.integration.test.js drive the real Express app against a
# real database and SKIP themselves when none is reachable — which is how the
# whole HTTP + SQL layer went untested on every developer machine (AUDIT.md,
# O-03). This stands one up with no installer and no administrator rights: the
# portable MariaDB zip, unpacked under backend/.testdb (gitignored), listening
# on 127.0.0.1 only, with exactly the credentials test/helpers/testServer.js
# defaults to.
#
# MariaDB rather than MySQL because that is what production runs (Hostinger,
# 11.8.x); the version below is pinned to match it so a dialect difference
# shows up here and not on the live site.
#
#   bash test/tools/testdb.sh up        download if needed, unpack, init, start
#   bash test/tools/testdb.sh down      stop it (data is kept)
#   bash test/tools/testdb.sh status    version if it is answering
#   bash test/tools/testdb.sh wipe      stop and delete the data (the download is kept)
#   bash test/tools/testdb.sh purge     stop and delete everything under .testdb
#
# Linux/macOS: see test/README.md — any MySQL 8 / MariaDB 10.6+ on :3399 with
# the same user and database works; this script only knows the Windows zip.
set -euo pipefail

MARIADB_VERSION="${MARIADB_VERSION:-11.8.9}"
PORT="${TESTDB_PORT:-3399}"

BACKEND="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOME_DIR="$BACKEND/.testdb"
ZIP="$HOME_DIR/mariadb-$MARIADB_VERSION-winx64.zip"
URL="https://archive.mariadb.org/mariadb-$MARIADB_VERSION/winx64-packages/mariadb-$MARIADB_VERSION-winx64.zip"
BIN="$HOME_DIR/mariadb-$MARIADB_VERSION-winx64/bin"
DATA="$HOME_DIR/data"
LOG="$HOME_DIR/mariadbd.log"

# What testServer.js assumes when MYSQL_* are unset.
DB_NAME=ndm_test
DB_USER=ndm
DB_PASS=test_password_at_least_16_chars
ROOT_PASS=root

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *) echo "testdb.sh: this script only handles the Windows portable zip — see test/README.md for Linux/macOS" >&2; exit 2 ;;
esac

# cygpath turns /c/... into C:\... for the MariaDB executables.
win() { cygpath -w "$1"; }

sql_root() {
  "$BIN/mariadb.exe" -uroot -p"$ROOT_PASS" -h127.0.0.1 -P"$PORT" "$@"
}

answering() {
  [ -x "$BIN/mariadb.exe" ] && sql_root -e 'SELECT 1' >/dev/null 2>&1
}

# A complete zip on disk, or nothing. unzip -t is a few seconds on 95 MB and
# is what tells a finished download from one that was cut off — a partial file
# is "non-empty" too, and unpacking it fails with a message that does not say
# why.
zip_complete() {
  [ -s "$ZIP" ] && unzip -tq "$ZIP" >/dev/null 2>&1
}

fetch() {
  [ -x "$BIN/mariadbd.exe" ] && return 0
  zip_complete && return 0
  mkdir -p "$HOME_DIR"
  if [ -s "$ZIP" ]; then echo "resuming the MariaDB $MARIADB_VERSION download ($(du -h "$ZIP" | cut -f1) of ~95 MB) …"
  else echo "downloading MariaDB $MARIADB_VERSION (~95 MB) …"; fi
  # The archive host answers 503 now and then; --fail keeps an error page from
  # being saved as the zip, the retries resume the transfer, and -C - picks a
  # partial file up from where an earlier, interrupted run left it.
  curl -sS -L --fail --retry 6 --retry-delay 5 --retry-all-errors --max-time 1800 \
    -C - -o "$ZIP" "$URL"
  zip_complete || { echo "the download at $ZIP is not a complete archive — delete it and run 'up' again" >&2; exit 1; }
}

unpack() {
  [ -x "$BIN/mariadbd.exe" ] && return 0
  echo "unpacking …"
  (cd "$HOME_DIR" && unzip -q -o "$ZIP")
}

init() {
  [ -d "$DATA" ] && return 0
  echo "initialising data directory …"
  # Creates the system tables and a my.ini beside them.
  "$BIN/mariadb-install-db.exe" --datadir="$(win "$DATA")" --password="$ROOT_PASS" --port="$PORT" >/dev/null
}

start() {
  if answering; then return 0; fi
  echo "starting mariadbd on 127.0.0.1:$PORT …"
  # Loopback only, no binlog, small pool: this is a test fixture, not a server.
  "$BIN/mariadbd.exe" --datadir="$(win "$DATA")" --port="$PORT" \
    --bind-address=127.0.0.1 --skip-log-bin --skip-name-resolve \
    --innodb-buffer-pool-size=128M --max-connections=50 \
    >"$LOG" 2>&1 &
  for _ in $(seq 1 60); do
    answering && return 0
    sleep 0.5
  done
  echo "mariadbd did not come up — tail of $LOG:" >&2
  tail -20 "$LOG" >&2
  exit 1
}

provision() {
  sql_root -e "
    CREATE DATABASE IF NOT EXISTS $DB_NAME CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    CREATE USER IF NOT EXISTS '$DB_USER'@'%' IDENTIFIED BY '$DB_PASS';
    GRANT ALL ON $DB_NAME.* TO '$DB_USER'@'%';
    FLUSH PRIVILEGES;"
}

case "${1:-}" in
  up)
    fetch; unpack; init; start; provision
    echo "ready: $DB_USER@127.0.0.1:$PORT/$DB_NAME ($(sql_root -N -e 'SELECT VERSION()'))"
    echo "now: npm test"
    ;;
  down)
    if answering; then
      "$BIN/mariadb-admin.exe" -uroot -p"$ROOT_PASS" -h127.0.0.1 -P"$PORT" shutdown && echo "stopped"
    else
      echo "not running"
    fi
    ;;
  status)
    if answering; then sql_root -e 'SELECT VERSION() AS version, @@port AS port'; else echo "not running on :$PORT"; exit 1; fi
    ;;
  wipe|purge)
    "$0" down >/dev/null 2>&1 || true
    # mariadb-admin shutdown returns before the server has let go of its
    # files; on Windows that made the rm below fail with "Device or resource
    # busy" and leave a half-deleted tree. Wait for the port to stop answering
    # and for the process to be gone before touching the directory.
    for _ in $(seq 1 30); do
      answering || break
      sleep 1
    done
    for _ in $(seq 1 30); do
      tasklist 2>/dev/null | grep -qi 'mariadbd.exe' || break
      sleep 1
    done
    sleep 1
    if [ "$1" = purge ]; then
      rm -rf "$HOME_DIR" && echo "removed $HOME_DIR"
    else
      # The 95 MB download and the unpacked server stay; only the state goes.
      rm -rf "$DATA" "$LOG" && echo "removed $DATA — 'up' starts from an empty database"
    fi
    ;;
  *)
    sed -n '17,21p' "$0"; exit 2
    ;;
esac
