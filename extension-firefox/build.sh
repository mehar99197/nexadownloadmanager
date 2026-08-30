#!/usr/bin/env bash
# Package the Firefox extension (MV3, Firefox 115+) into dist/nexa-firefox.zip
# for addons.mozilla.org (upload the zip as-is; AMO signs it).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
dist="$here/../dist"
files=(manifest.json background.js content.js
       popup.html popup.js popup.css
       options.html options.js options.css
       _locales icons)

for file in "${files[@]}"; do
  [ -e "$here/$file" ] || { echo "missing: $file" >&2; exit 1; }
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
    throw new Error(`${file}: inline <script> is not allowed by the extension CSP`);
  return refs;
};
// MV3 uses `action`; MV2 used `browser_action`. Accept either so the validator
// keeps working across the migration.
const act = manifest.action || manifest.browser_action || {};
const referenced = [
  ...((manifest.background && manifest.background.scripts) || []),
  manifest.background && manifest.background.service_worker,
  ...(manifest.content_scripts || []).flatMap((entry) => entry.js || []),
  ...Object.values(manifest.icons || {}),
  ...Object.values(act.default_icon || {}),
  act.default_popup,
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
NODE

mkdir -p "$dist"
rm -f "$dist/nexa-firefox.zip"
cd "$here"
zip -rq "$dist/nexa-firefox.zip" "${files[@]}" -x '*.DS_Store'
echo "Packaged: $dist/nexa-firefox.zip"
