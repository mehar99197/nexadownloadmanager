#!/usr/bin/env bash
# The Firefox and Chromium extensions share their JS/HTML. This copies the
# shared files from the chromium folder so extension-firefox/ is self-contained
# and loadable via about:debugging.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/../extension-chromium"
for f in background.js content.js popup.html popup.js; do
  cp -v "$src/$f" "$here/$f"
done
mkdir -p "$here/icons"
[ -d "$src/icons" ] && cp -rv "$src/icons/." "$here/icons/" 2>/dev/null || true
echo "Firefox extension assembled in: $here"
