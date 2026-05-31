#!/usr/bin/env bash
# Package the Chromium extension into store-ready zips for Chrome and Edge.
# (The artefacts are identical; named per store for convenience.)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dist="$here/../dist"
mkdir -p "$dist"

files=(manifest.json background.js content.js popup.html popup.js icons)
for f in "${files[@]}"; do
  [ -e "$here/$f" ] || { echo "missing: $f" >&2; exit 1; }
done

cd "$here"
rm -f "$dist/nexa-chrome.zip" "$dist/nexa-edge.zip"
zip -rq "$dist/nexa-chrome.zip" "${files[@]}"
cp "$dist/nexa-chrome.zip" "$dist/nexa-edge.zip"
echo "Packaged:"
echo "  $dist/nexa-chrome.zip"
echo "  $dist/nexa-edge.zip"
