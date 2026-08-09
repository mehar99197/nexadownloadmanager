#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
dist="$here/../dist"
files=(manifest.json background.js content.js icons)

for file in "${files[@]}"; do
  [ -e "$here/$file" ] || { echo "missing: $file" >&2; exit 1; }
done

node - "$here" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const referenced = [
  ...((manifest.background && manifest.background.scripts) || []),
  ...(manifest.content_scripts || []).flatMap((entry) => entry.js || []),
  ...Object.values(manifest.icons || {}),
  ...Object.values((manifest.browser_action && manifest.browser_action.default_icon) || {}),
].filter(Boolean);
for (const file of referenced) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`manifest file missing: ${file}`);
}
NODE

mkdir -p "$dist"
rm -f "$dist/nexa-firefox.zip"
cd "$here"
zip -rq "$dist/nexa-firefox.zip" "${files[@]}"
echo "Packaged: $dist/nexa-firefox.zip"