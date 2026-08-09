#!/usr/bin/env bash
# Package the Chromium extension into store-ready zips for Chrome and Edge.
# (The artefacts are identical; named per store for convenience.)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dist="$here/../dist"
mkdir -p "$dist"

files=(manifest.json background.js content.js icons)
for f in "${files[@]}"; do
  [ -e "$here/$f" ] || { echo "missing: $f" >&2; exit 1; }
done

node - "$here" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const referenced = [
  manifest.background && manifest.background.service_worker,
  ...(manifest.content_scripts || []).flatMap((entry) => entry.js || []),
  ...Object.values(manifest.icons || {}),
  ...Object.values((manifest.action && manifest.action.default_icon) || {}),
].filter(Boolean);
for (const file of referenced) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`manifest file missing: ${file}`);
}
NODE

cd "$here"
rm -f "$dist/nexa-chrome.zip" "$dist/nexa-edge.zip"
zip -rq "$dist/nexa-chrome.zip" "${files[@]}"
cp "$dist/nexa-chrome.zip" "$dist/nexa-edge.zip"
echo "Packaged:"
echo "  $dist/nexa-chrome.zip"
echo "  $dist/nexa-edge.zip"
