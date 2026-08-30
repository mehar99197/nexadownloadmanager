#!/bin/bash
# Keepalive supervisor: runs run-api.sh every 60s. flock = single instance.
# Interim replacement for cron (crontab unavailable in this shell); an hPanel
# cron job calling run-api.sh can coexist safely — run-api.sh has its own lock.
exec 8>"$HOME/domains/nexadownloadmanager.com/.supervisor.lock"
flock -n 8 || exit 0
while true; do
  /bin/bash "$HOME/domains/nexadownloadmanager.com/run-api.sh" >/dev/null 2>&1
  sleep 60
done
