#!/usr/bin/env bash
# Registers nexa-host with installed browsers by writing the native-messaging
# host manifest into each browser's well-known location.
#
# Usage:
#   ./install.sh [path-to-nexa-host] [chrome-extension-id]
#
#   path-to-nexa-host   defaults to ../build/nexa-host
#   chrome-extension-id the unpacked extension id from chrome://extensions
#                       (needed for Chromium browsers; Firefox uses the gecko id)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
HOST_BIN="${1:-$here/../build/nexa-host}"
CHROME_EXT_ID="${2:-REPLACE_WITH_CHROME_EXTENSION_ID}"
FIREFOX_EXT_ID="nexa@nexa.local"
NAME="com.nexa.host"

HOST_BIN="$(realpath "$HOST_BIN" 2>/dev/null || echo "$HOST_BIN")"
if [ ! -x "$HOST_BIN" ]; then
  echo "warning: $HOST_BIN is not an executable yet — build the project first." >&2
fi

write_manifest() {
  local dir="$1" mode="$2"
  mkdir -p "$dir"
  if [ "$mode" = "firefox" ]; then
    cat > "$dir/$NAME.json" <<EOF
{
  "name": "$NAME",
  "description": "Nexa Download Manager native messaging host",
  "path": "$HOST_BIN",
  "type": "stdio",
  "allowed_extensions": ["$FIREFOX_EXT_ID"]
}
EOF
  else
    cat > "$dir/$NAME.json" <<EOF
{
  "name": "$NAME",
  "description": "Nexa Download Manager native messaging host",
  "path": "$HOST_BIN",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$CHROME_EXT_ID/"]
}
EOF
  fi
  echo "  wrote $dir/$NAME.json"
}

case "$(uname -s)" in
  Linux)
    echo "Registering for Chromium browsers (Linux)…"
    for d in \
      "$HOME/.config/google-chrome/NativeMessagingHosts" \
      "$HOME/.config/chromium/NativeMessagingHosts" \
      "$HOME/.config/microsoft-edge/NativeMessagingHosts" \
      "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"; do
      write_manifest "$d" chrome
    done
    echo "Registering for Firefox (Linux)…"
    write_manifest "$HOME/.mozilla/native-messaging-hosts" firefox
    ;;
  Darwin)
    base="$HOME/Library/Application Support"
    echo "Registering for Chromium browsers (macOS)…"
    write_manifest "$base/Google/Chrome/NativeMessagingHosts" chrome
    write_manifest "$base/Chromium/NativeMessagingHosts" chrome
    echo "Registering for Firefox (macOS)…"
    write_manifest "$base/Mozilla/NativeMessagingHosts" firefox
    ;;
  *)
    echo "On Windows, register via the registry instead — see native-host/README.md" >&2
    ;;
esac

echo "Done. Chrome ext id used: $CHROME_EXT_ID"
echo "If that says REPLACE_..., re-run: ./install.sh \"$HOST_BIN\" <your-extension-id>"
