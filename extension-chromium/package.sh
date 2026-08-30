#!/usr/bin/env bash
# Package the Chromium extension (Chrome / Edge / Brave — one MV3 build).
#
#   dist/nexa-chrome.zip, dist/nexa-edge.zip
#       Development builds. The manifest KEEPS its "key" so the extension ID
#       stays cbogjffoidaepbcbogbfibnldhkckhpb, matching the native-host
#       manifests the installers write.
#   dist/nexa-chrome-store.zip, dist/nexa-edge-store.zip
#       Store uploads. Identical tree, but the "key" field is REMOVED — the
#       Chrome Web Store / Edge Add-ons reject a manifest that carries one and
#       assign their own extension ID on publication.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dist="$here/../dist"
mkdir -p "$dist"

files=(manifest.json background.js content.js
       popup.html popup.js popup.css
       options.html options.js options.css
       _locales icons)
for f in "${files[@]}"; do
  [ -e "$here/$f" ] || { echo "missing: $f" >&2; exit 1; }
done

node - "$here" <<'NODE'
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const htmlRefs = (file) => {
  const html = fs.readFileSync(path.join(root, file), 'utf8');
  const refs = [];
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g))
    if (!/^(?:https?:|#|mailto:)/.test(m[1])) refs.push(m[1]);
  if (/<script[^>]*>[^<]*\S[^<]*<\/script>/i.test(html))
    throw new Error(`${file}: inline <script> is not allowed by the MV3 CSP`);
  return refs;
};
const referenced = [
  manifest.background && manifest.background.service_worker,
  ...(manifest.content_scripts || []).flatMap((entry) => entry.js || []),
  ...Object.values(manifest.icons || {}),
  ...Object.values((manifest.action && manifest.action.default_icon) || {}),
  manifest.action && manifest.action.default_popup,
  manifest.options_ui && manifest.options_ui.page,
  manifest.default_locale && `_locales/${manifest.default_locale}/messages.json`,
].filter(Boolean);
for (const page of ['popup.html', 'options.html']) referenced.push(...htmlRefs(page));
for (const file of referenced) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`manifest file missing: ${file}`);
}
if (manifest.default_locale) {
  const msgs = JSON.parse(fs.readFileSync(path.join(root, `_locales/${manifest.default_locale}/messages.json`), 'utf8'));
  for (const field of ['name', 'description']) {
    const m = /^__MSG_(\w+)__$/.exec(manifest[field] || '');
    if (m && !(msgs[m[1]] && msgs[m[1]].message)) throw new Error(`messages.json lacks ${m[1]}`);
  }
}
for (const file of fs.readdirSync(root).filter((f) => f.endsWith('.js')))
  new vm.Script(fs.readFileSync(path.join(root, file), 'utf8'), { filename: file });   // syntax check
if (!manifest.key) throw new Error('manifest.json must keep its "key" for the dev build');
NODE

cd "$here"
rm -f "$dist/nexa-chrome.zip" "$dist/nexa-edge.zip" \
      "$dist/nexa-chrome-store.zip" "$dist/nexa-edge-store.zip"

# Dev build (manifest with "key").
zip -rq "$dist/nexa-chrome.zip" "${files[@]}" -x '*.DS_Store'
cp "$dist/nexa-chrome.zip" "$dist/nexa-edge.zip"

# Store build: same tree, manifest without "key", zipped from a temp dir.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp -R "${files[@]}" "$tmp/"
node -e '
const fs = require("fs");
const file = process.argv[1];
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
delete manifest.key;
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
' "$tmp/manifest.json"
( cd "$tmp" && zip -rq "$dist/nexa-chrome-store.zip" "${files[@]}" -x '*.DS_Store' )
cp "$dist/nexa-chrome-store.zip" "$dist/nexa-edge-store.zip"

# Prove the store manifest carries no key (the stores refuse it).
if unzip -p "$dist/nexa-chrome-store.zip" manifest.json | grep -q '"key"'; then
  echo "error: store zip still contains a manifest \"key\"" >&2
  exit 1
fi

echo "Packaged:"
echo "  $dist/nexa-chrome.zip          (dev, keeps manifest key)"
echo "  $dist/nexa-edge.zip            (dev, keeps manifest key)"
echo "  $dist/nexa-chrome-store.zip    (store upload, key removed)"
echo "  $dist/nexa-edge-store.zip      (store upload, key removed)"
