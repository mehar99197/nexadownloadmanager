# Store listing assets

Generated from the real product — the screenshot is the actual app running, and
the tiles use the shipped brand mark. Regenerate with `tools/make-store-assets.sh`.

| File | Where it goes |
|------|---------------|
| `promo-marquee-1400x560.png` | Chrome Web Store marquee tile |
| `promo-large-920x680.png` | Chrome Web Store large tile |
| `promo-small-440x280.png` | Chrome Web Store small tile / AMO feature |
| `icon-128.png`, `icon-96.png` | Chrome Web Store / AMO listing icon |
| `screenshot-1-app-1280x800.png` | Screenshot 1 (Chrome wants 1280×800 or 640×400) |

## Still needed before submitting

These need a browser with the extension actually loaded, so they are captured by
hand rather than generated:

1. **The popup** — click the toolbar icon on a video page (shows "Connected", the
   site toggle and recent handoffs).
2. **The on-player button** — hover a video and capture the "Download" button.
3. **The quality picker** — open the panel on a YouTube page.

Crop each to 1280×800. Chrome requires at least one screenshot; up to five help.

## Listing copy

**Name:** Nexa Download Manager Integration
**Short description (132 max):** Send downloads and videos to the Nexa desktop app —
multi-connection speed, resume, and one-click video grabbing.

**Privacy:** the listing must link https://nexadownloadmanager.com/privacy, which
explains why the extension reads cookies and request headers (to hand them to the
locally running app so private/authenticated files download correctly) and states
that nothing is sent to Nexa's servers.

**Permission justifications** (both stores ask):

- `downloads` — take over a download the browser started.
- `cookies` / `webRequest` — replay your existing login for the file being
  downloaded, so authenticated and CDN-signed links work. Read only for the site
  you download from; never transmitted anywhere but the local app.
- `nativeMessaging` — the only way a page can reach the desktop app.
- `contextMenus`, `storage`, `tabs`, `scripting`, `notifications` — the right-click
  entries, your settings, the on-page button, and success/failure messages.
- `<all_urls>` — downloads can start on any site; there is no fixed list.

## After a store approves the listing

Put the id it assigned into `packaging/extension-ids.env` (`NEXA_CHROME_STORE_ID`,
`NEXA_EDGE_STORE_ID`, or the signed `.xpi` link in `NEXA_FIREFOX_XPI_URL`) and
also into `kChromeStoreExtIds` in `src/ipc/NativeHostRegistrar.cpp`. From that
build on, a fresh install of Nexa hands the extension to every browser on the
machine automatically; until then the setup guide shows "waiting for the store
listing" for that browser.
