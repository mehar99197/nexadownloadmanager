# Nexa Browser Integration — Firefox

The Firefox build of the Nexa extension. It is the **same code** as
`../extension-chromium/` (`background.js`, `content.js`, popup and options
pages are kept byte-identical apart from a handful of Firefox-specific
differences), wrapped in a Manifest V3 manifest with
`browser_specific_settings.gecko`.

Requires **Firefox 115+** (`storage.session`, used to survive background
restarts, landed in 115).

## Install (temporary, for development)

1. Build the desktop app first so `build/nexa-host` exists (see the top-level README).
2. Register the native-messaging host:
   ```bash
   ../native-host/install.sh ../build/nexa-host
   ```
   The Firefox host manifest allows the add-on ID `nexa@nexa.local` (from
   `browser_specific_settings.gecko.id`).
3. Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** →
   pick `extension-firefox/manifest.json`.
4. Click any download link — Firefox hands it to Nexa.

A temporary add-on is removed when Firefox closes. For a permanent install,
package and sign it through addons.mozilla.org (AMO).

## Package for AMO

```bash
./build.sh          # produces ../dist/nexa-firefox.zip
```

Upload `nexa-firefox.zip` to <https://addons.mozilla.org/developers/>. The
add-on ID is fixed by the manifest (`nexa@nexa.local`), so the desktop app's
native-host allowlist needs no change after publication. (If you ever change
that ID, add the new one to the app — it reads extra IDs from the
`NEXA_EXTRA_EXTENSION_IDS` environment variable / its settings.)

## Toolbar popup, options, shortcut

- **Popup** (toolbar icon): connection status (pings the app; the native host
  launches it if needed), **Take over downloads**, **Pause on this site**,
  **Grab all links on this page**, **Grab media on this page**, **Open Nexa**,
  and the last 8 handoffs.
- **Options** (`about:addons` → Nexa → Preferences, or popup → Options): minimum
  size to take over, file-type list (or *All file types*), paused sites,
  ask-before-start, floating-button and notification switches, **Export
  diagnostics** (settings + last errors as JSON — no cookies or credentials).
- **Shortcut:** `Alt+Shift+N` sends the current page to Nexa (change it in
  `about:addons` → ⚙ → *Manage Extension Shortcuts*).
- **Badge:** the toolbar icon shows how many media streams were sniffed on the
  active tab; a red `!` for 10 s means the app / native host is unreachable.

Settings and their defaults are documented in `../extension-chromium/README.md`
(same keys, same `storage.local`).

## Differences from the Chromium build

| | Chromium | Firefox |
|-|----------|---------|
| Manifest | V3, `background.service_worker`, `action` | V3, `background.scripts` (Firefox runs this as a non-persistent event page — it has no `service_worker` background), `action` |
| Injecting `content.js` into already-open tabs | `scripting.executeScript` | `scripting.executeScript`, with a `tabs.executeScript` fallback kept only in case this build ever runs under MV2 |
| `author` manifest key | `{ "email": … }` (Chrome's shape) | string (AMO's shape) |
| Options page | embedded (`open_in_tab: false`) | own tab (`open_in_tab: true`) |
| Extension ID | fixed by the manifest `key` (dev) / store-assigned | `nexa@nexa.local` always |

Everything else — provider registry (including the MovieBox CDN block), cookie
export, request-header capture, media sniffing, the Download button, popup, options,
notifications and the `ping` / `links` / `show` / `download` / `list-formats`
messages — is identical.

## Privacy

The extension talks only to the locally installed Nexa app through the
browser's native-messaging bridge; it never sends browsing data to a server.
Cookies and request headers are forwarded to the app solely for the download
you asked for. Full policy: <https://nexadownloadmanager.com/privacy>.

## Tests

```bash
node tests/ExtensionProviderConfigTest.js   # provider registry (both copies)
node tests/ExtensionSettingsTest.js         # settings predicates + links/ping payloads (both copies)
```
