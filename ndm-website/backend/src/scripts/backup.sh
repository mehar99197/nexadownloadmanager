#!/usr/bin/env bash
# Nightly logical backup of the Nexa database.
#
#   bash src/scripts/backup.sh [output-dir]
#
# Reads connection details from the same .env the app uses, writes a
# timestamped gzip dump, verifies it is non-empty and gunzips cleanly, then
# prunes dumps older than BACKUP_KEEP_DAYS (default 14).
#
# Restore with:
#   gunzip -c nexa-YYYYmmdd-HHMM.sql.gz | mysql -h HOST -u USER -p DBNAME
set -euo pipefail

here="$(cd "$(dirname "$0")/../.." && pwd)"
out_dir="${1:-${BACKUP_DIR:-$here/backups}}"
keep_days="${BACKUP_KEEP_DAYS:-14}"

# Pull MYSQL_* out of .env without executing it (values may contain spaces).
# A temp file, not process substitution: some shared-hosting shells (e.g.
# Hostinger's CloudLinux) don't mount /dev/fd, which silently breaks `< <(...)`.
if [ -f "$here/.env" ]; then
  env_tmp="$(mktemp)"
  trap 'rm -f "$env_tmp"' EXIT
  grep -E '^MYSQL_(HOST|PORT|USER|PASS|DB)=' "$here/.env" > "$env_tmp" || true
  while IFS='=' read -r key value; do
    case "$key" in
      MYSQL_HOST|MYSQL_PORT|MYSQL_USER|MYSQL_PASS|MYSQL_DB)
        value="${value%\"}"; value="${value#\"}"
        export "$key=$value" ;;
    esac
  done < "$env_tmp"
  rm -f "$env_tmp"
  trap - EXIT
fi

: "${MYSQL_HOST:=127.0.0.1}"
: "${MYSQL_PORT:=3306}"
: "${MYSQL_USER:?MYSQL_USER is not set (check .env)}"
: "${MYSQL_DB:?MYSQL_DB is not set (check .env)}"

mkdir -p "$out_dir"
stamp="$(date +%Y%m%d-%H%M)"
file="$out_dir/nexa-$stamp.sql.gz"

echo "[backup] dumping $MYSQL_DB -> $file"
# --single-transaction keeps InnoDB consistent without locking writers out.
MYSQL_PWD="${MYSQL_PASS:-}" mysqldump \
  --host="$MYSQL_HOST" --port="$MYSQL_PORT" --user="$MYSQL_USER" \
  --single-transaction --quick --routines --triggers --events \
  --default-character-set=utf8mb4 \
  "$MYSQL_DB" | gzip -9 > "$file"

# A backup nobody verified is not a backup.
if [ ! -s "$file" ]; then
  echo "[backup] FAILED: dump is empty" >&2
  rm -f "$file"
  exit 1
fi
gunzip -t "$file"
size="$(du -h "$file" | cut -f1)"
echo "[backup] ok ($size)"

echo "[backup] pruning dumps older than $keep_days day(s)"
find "$out_dir" -name 'nexa-*.sql.gz' -type f -mtime "+$keep_days" -print -delete
