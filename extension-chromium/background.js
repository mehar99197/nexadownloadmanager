// Nexa integration — service worker.
// Responsibilities:
//   1. Intercept browser downloads and hand them to the Nexa desktop app.
//   2. Capture cookies + User-Agent + referrer so authed/CDN links don't 403.
//   3. Sniff HLS/DASH/media URLs and offer them for download.
//   4. Provide right-click "Download with Nexa" menu items.

const HOST = "com.nexa.host";
const MEDIA_RE = /\.(m3u8|mpd|mp4|mkv|webm|flv|ts|mp3|m4a|aac|zip|rar|7z|iso|exe|dmg|pkg|deb|apk|pdf)(\?|$)/i;
// Spotify's 30-second preview clips are plain MP3s but have NO file extension
// (https://p.scdn.co/mp3-preview/<hash>?cid=…), so MEDIA_RE misses them — match the
// host+path instead. (Full tracks are encrypted/DRM and can't be sniffed.)
const SPOTIFY_PREVIEW_RE = /\/\/p\.scdn\.co\/mp3-preview\//i;

// Firefox exposes the promise-based `browser.*`; Chrome only `chrome.*`. Use this
// for the NEW auth-cookie calls so existing (working) chrome.* lines are untouched.
const X = (typeof browser !== "undefined") ? browser : chrome;

// Auth-gated sites Nexa routes through yt-dlp with cookies. MUST stay in sync with
// kAuthSites in src/site/YtDlpGrabber.cpp so the engine actually uses the cookies.
const NEXA_AUTH_SITES = [
  "udemy.com", "vimeo.com", "coursera.org",
  "skillshare.com", "pluralsight.com", "linkedin.com"
];

// The registrable auth domain for a URL (host-suffix match), e.g.
// "www.udemy.com" -> "udemy.com". Empty string if it's not an auth site.
function authDomainFor(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return ""; }
  for (const d of NEXA_AUTH_SITES)
    if (host === d || host.endsWith("." + d)) return d;
  return "";
}

// Hosts the extension must NOT auto-intercept. These gate downloads behind a
// session login (and sometimes a "confirm"/signed-URL step) that the desktop app
// can't reliably reproduce from outside the browser — so we leave them to the
// browser, which already holds the session and just downloads them normally.
// (Manual paste into Nexa, or right-click "Download with Nexa", still routes to
// the app on purpose; this only affects the silent auto-takeover of a click.)
const BROWSER_ONLY_HOSTS = [
  // Google Drive / Docs — Google login + large-file virus-scan confirm page.
  "drive.google.com",
  "drive.usercontent.google.com",
  "docs.google.com",
  "googleusercontent.com",        // the CDN Drive redirects large files to
  // GitHub — release assets & private-repo files use signed/login-gated URLs.
  "github.com",                   // also codeload.github.com, gist.github.com, …
  "githubusercontent.com",        // raw./objects./release-assets.githubusercontent.com
];

function letBrowserHandle(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return BROWSER_ONLY_HOSTS.some((d) => host === d || host.endsWith("." + d));
}

// Export all cookies of `authDomain` (incl. subdomains) as Netscape cookies.txt
// TEXT, the exact 7-tab format Nexa's CookieFile parser requires. The extension
// can't write a file (MV3 sandbox), so we send the text and the engine writes it.
async function exportCookiesAsNetscape(authDomain) {
  // Gather the site's cookies from SEVERAL angles and merge. A lone
  // getAll({domain}) misses host-only and __Host-/__Secure- cookies in some
  // cookie stores — and on Udemy/Coursera those host-only cookies ARE the
  // session yt-dlp needs, so the export came back empty and the engine reported
  // "cookie file is empty". Querying the apex + www URLs as well catches them;
  // we de-dupe across all sources by (name, domain, path, store).
  const queries = [
    { domain: authDomain },
    { url: "https://" + authDomain + "/" },
    { url: "https://www." + authDomain + "/" },
  ];
  let cookies = [];
  const seenKey = new Set();
  for (const q of queries) {
    let part = [];
    try { part = await X.cookies.getAll(q); } catch { part = []; }
    for (const c of part) {
      const k = `${c.name}\t${c.domain}\t${c.path}\t${c.storeId || ""}`;
      if (seenKey.has(k)) continue;
      seenKey.add(k);
      cookies.push(c);
    }
  }
  // No cookies at all => not logged in / no host access. Return "" so the caller
  // skips the auth handoff entirely instead of sending a header-only file the
  // engine would (correctly) reject as empty.
  if (!cookies.length) return "";
  // De-dupe by cookie NAME. A jar from repeated logins carries several with the
  // same name (e.g. access_token at .udemy.com AND www.udemy.com); forwarding all
  // of them makes the server honour a STALE one and bounce to a login page. Keep
  // the most host-specific domain, tie-break by latest expiry. (The engine also
  // de-dupes, but cleaning at the source keeps the handoff small and correct.)
  const spec = (d) => (d.startsWith(".") ? 0 : 1) + d.replace(/^\./, "").length * 2;
  const expOf = (c) => (c.session || !c.expirationDate) ? Number.MAX_SAFE_INTEGER : c.expirationDate;
  const best = new Map();
  for (const c of cookies) {
    const prev = best.get(c.name);
    if (!prev || spec(c.domain) > spec(prev.domain) ||
        (spec(c.domain) === spec(prev.domain) && expOf(c) >= expOf(prev)))
      best.set(c.name, c);
  }
  const lines = ["# Netscape HTTP Cookie File", "# Exported by Nexa"];
  let kept = 0;
  for (const c of best.values()) {
    // The C++ parser rejects the WHOLE file on any control char, so skip a bad
    // cookie rather than poison the export.
    if (/[\x00-\x1f\x7f]/.test(c.name) || /[\x00-\x1f\x7f]/.test(c.value)) continue;
    const dom = c.domain;
    const includeSub = dom.startsWith(".") ? "TRUE" : "FALSE";
    const path = c.path || "/";
    const secure = c.secure ? "TRUE" : "FALSE";
    // WebExtensions expirationDate is epoch SECONDS (float); session cookies omit it.
    const expires = (c.session || !c.expirationDate) ? 0 : Math.floor(c.expirationDate);
    const prefix = c.httpOnly ? "#HttpOnly_" : "";
    lines.push(`${prefix}${dom}\t${includeSub}\t${path}\t${secure}\t${expires}\t${c.name}\t${c.value}`);
    kept++;
  }
  // Every cookie was filtered out (only the header would remain) — treat the
  // same as "no cookies": return "" so we never hand the engine an empty file.
  if (kept === 0) return "";
  return lines.join("\n") + "\n";
}

// Per-tab detected media stream URLs (for the floating download button).
// NOTE: an MV3 service worker is terminated when idle and loses module globals,
// so this Map is mirrored into chrome.storage.session (survives worker restarts,
// cleared when the browser closes) and re-warmed on demand.
const tabMedia = new Map();
const sessKey = (tabId) => "media_" + tabId;
function persistTabMedia(tabId, list) {
  try { chrome.storage.session.set({ [sessKey(tabId)]: list }); } catch (_) {}
}
function dropTabMedia(tabId) {
  tabMedia.delete(tabId);
  try { chrome.storage.session.remove(sessKey(tabId)); } catch (_) {}
}
// Record one detected media URL for a tab (deduped, capped). Shared by the
// URL-extension sniffer and the Content-Type sniffer below.
const MAX_MEDIA_PER_TAB = 40;   // keep the list bounded (MSE streams can be chatty)
function addMedia(tabId, url, type) {
  if (tabId < 0) return;
  const list = tabMedia.get(tabId) || [];
  if (list.some((m) => m.url === url)) return;
  if (list.length >= MAX_MEDIA_PER_TAB) return;
  list.push({ url, type });
  tabMedia.set(tabId, list);
  persistTabMedia(tabId, list);
}

// Read a tab's media list, re-hydrating from session storage if the worker was
// restarted and the in-memory Map is cold.
async function getTabMedia(tabId) {
  if (tabId == null) return [];
  if (tabMedia.has(tabId)) return tabMedia.get(tabId);
  try {
    const v = await chrome.storage.session.get(sessKey(tabId));
    const list = v[sessKey(tabId)] || [];
    if (list.length) tabMedia.set(tabId, list);   // re-warm memory
    return list;
  } catch (_) { return []; }
}

let integrationEnabled = true;
chrome.storage.local.get({ enabled: true }, (v) => (integrationEnabled = v.enabled));
chrome.storage.onChanged.addListener((c, area) => {
  if (area === "local" && c.enabled) integrationEnabled = c.enabled.newValue;
});

// ---- Context menus -------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "nexa-link",  title: "Download with Nexa",        contexts: ["link"] });
  chrome.contextMenus.create({ id: "nexa-media", title: "Download video/audio with Nexa", contexts: ["video", "audio", "image"] });
  chrome.contextMenus.create({ id: "nexa-page",  title: "Download all links on page",  contexts: ["page"] });
  // On a course page (Udemy/Coursera/…) this grabs every lecture via yt-dlp
  // --yes-playlist, carrying your site cookies. Use it on the course URL.
  chrome.contextMenus.create({ id: "nexa-course", title: "Download whole course with Nexa", contexts: ["page", "link"] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "nexa-link" && info.linkUrl) {
    await handoff(info.linkUrl, tab);
  } else if (info.menuItemId === "nexa-media" && info.srcUrl) {
    await handoff(info.srcUrl, tab);
  } else if (info.menuItemId === "nexa-page" && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "nexa-collect-links" });
  } else if (info.menuItemId === "nexa-course") {
    // Course/playlist URL (the link, or the current page) -> playlist download.
    const target = info.linkUrl || tab?.url;
    if (target) await handoff(target, tab, tab?.url, "", "", /*playlist=*/true);
  }
});

// ---- Download interception ----------------------------------------------
// When the browser starts a download, cancel it and let Nexa take over.
chrome.downloads.onCreated.addListener(async (item) => {
  if (!integrationEnabled) return;
  if (!item.url || item.url.startsWith("blob:") || item.url.startsWith("data:")) return;
  // Drive/Docs & co.: don't take over — let the browser download it natively with
  // its own Google login (the app can't reliably auth these from outside).
  if (letBrowserHandle(item.url)) return;

  try {
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
  } catch (_) { /* already gone */ }

  // Don't assume the ACTIVE tab started this — a background tab may have. Use the
  // download item's OWN referrer; cookies come from the URL (cookieHeader), so the
  // tab isn't needed. Falling back to an unrelated active tab's URL would attach a
  // wrong/misleading Referer.
  await handoff(item.url, null, item.referrer, item.filename);
});

// ---- Media sniffing ------------------------------------------------------
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (!MEDIA_RE.test(details.url) && !SPOTIFY_PREVIEW_RE.test(details.url)) return;
    addMedia(details.tabId, details.url, mediaType(details.url));
  },
  { urls: ["<all_urls>"] }
);

// Content-Type sniffer: catch media that the URL-extension test misses — any
// response served as audio/* , video/* , or an HLS/DASH manifest, regardless of
// its URL (e.g. extensionless streaming audio). MSE segments are skipped because
// they flood the list and aren't independently downloadable; whole files and
// manifests are kept. NOTE: this detects PLAIN media only — DRM-encrypted streams
// (Spotify full tracks, Netflix) are delivered as encrypted segments that, even if
// detected, can't be decrypted or played, so they're intentionally not surfaced.
const SEGMENT_RE = /\.(m4s|ts)(\?|$)|[?&](range|bytes)=|\/(seg(ment)?|chunk|frag(ment)?)[-_/0-9]/i;
function ctOf(headers) {
  for (const h of (headers || []))
    if (h.name.toLowerCase() === "content-type") return (h.value || "").toLowerCase();
  return "";
}
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const ct = ctOf(details.responseHeaders);
    if (!ct) return;
    let type = "";
    if (/(application|audio|video)\/(x-mpegurl|vnd\.apple\.mpegurl|mpegurl)/.test(ct)) type = "HLS";
    else if (/application\/dash\+xml/.test(ct)) type = "DASH";
    else if (/^audio\//.test(ct)) type = "audio";
    else if (/^video\//.test(ct)) type = "video";
    else return;
    // Don't capture the myriad segments of an MSE stream — only whole files/manifests.
    if ((type === "audio" || type === "video") && SEGMENT_RE.test(details.url)) return;
    addMedia(details.tabId, details.url, type);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.tabs.onRemoved.addListener((tabId) => dropTabMedia(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading")
    dropTabMedia(tabId);
});

const VIDEO_TYPES = new Set(["HLS", "DASH", "video", "audio"]);

// ---- quality-probe cache -------------------------------------------------
// yt-dlp -J (real video qualities) is network + subprocess bound — a few
// seconds. We cache it per video URL so that, after a page-load prefetch,
// opening the panel is an O(1) cache hit (instant) instead of a fresh probe.
// In-flight requests are de-duplicated so a prefetch racing a click never runs
// yt-dlp twice. Bounded size + TTL keep it small and reasonably fresh.
const FMT_CACHE_TTL = 5 * 60 * 1000;   // 5 minutes
const FMT_CACHE_MAX = 32;              // evict oldest beyond this
const fmtCache = new Map();            // url -> { result, ts }
const fmtInflight = new Map();         // url -> Promise<result>

async function listFormatsCached(url) {
  const hit = fmtCache.get(url);
  if (hit && (Date.now() - hit.ts) < FMT_CACHE_TTL)
    return hit.result;                 // best case: O(1), no probe
  if (fmtInflight.has(url))
    return fmtInflight.get(url);        // coalesce a concurrent prefetch + click
  const p = (async () => {
    const r = await sendNative({ type: "list-formats", url });
    if (r && r.ok) {                   // only cache successes; let failures retry
      fmtCache.set(url, { result: r, ts: Date.now() });
      if (fmtCache.size > FMT_CACHE_MAX)
        fmtCache.delete(fmtCache.keys().next().value);   // evict oldest (insertion order)
    }
    fmtInflight.delete(url);
    return r;
  })();
  fmtInflight.set(url, p);
  return p;
}

// ---- Messages from popup / content scripts -------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only act on messages from THIS extension's own content scripts/pages. A
  // different extension (or anything without our id) is ignored — these handlers
  // drive downloads and export cookies, so the origin must be trusted.
  if (!sender || sender.id !== chrome.runtime.id) return;
  (async () => {
    const tab = sender.tab || (await activeTab());
    if (msg.type === "nexa-download") {
      const r = await handoff(msg.url, tab, tab?.url, msg.filename, msg.quality, msg.playlist);
      sendResponse(r);
    } else if (msg.type === "nexa-media-count") {
      // Count only video/stream media for the floating pill.
      const list = (await getTabMedia(tab?.id)).filter((m) => VIDEO_TYPES.has(m.type));
      sendResponse({ count: list.length, signature: list.map((m) => m.url).join("|") });
    } else if (msg.type === "nexa-list-formats") {
      // A site video's real qualities (yt-dlp -J), served from cache when warm.
      sendResponse(await listFormatsCached(msg.url));
    } else if (msg.type === "nexa-prefetch-formats") {
      // Page-load prefetch: warm the cache in the background, reply immediately
      // (the content script doesn't wait on this).
      listFormatsCached(msg.url);      // fire-and-forget
      sendResponse({ ok: true, prefetching: true });
    } else if (msg.type === "nexa-get-qualities") {
      sendResponse(await buildQualities(tab));
    } else if (msg.type === "nexa-get-media") {
      sendResponse(await getTabMedia(tab?.id));   // legacy (popup.js)
    } else if (msg.type === "nexa-download-list") {
      const results = [];
      for (const u of msg.urls) results.push(await handoff(u, tab));
      sendResponse(results);
    }
  })();
  return true; // keep the channel open for the async response
});

// Build the per-video quality groups shown in the floating panel.
async function buildQualities(tab) {
  const list = (await getTabMedia(tab?.id)).filter((m) => VIDEO_TYPES.has(m.type));
  const title = tab?.title || "Video";
  const baseName = sanitizeName(tab?.title) || "video";
  const groups = [];
  for (const m of list) {
    if (m.type === "HLS") {
      const variants = await fetchHlsVariants(m.url);
      if (variants && variants.length) {
        groups.push({
          title: shortName(m.url), name: baseName,
          qualities: variants.map((v) => ({
            label: v.height ? `${v.height}p` : (v.bandwidth ? `${Math.round(v.bandwidth / 1000)} kbps` : "Auto"),
            meta: v.bandwidth ? `${(v.bandwidth / 1e6).toFixed(1)} Mbps` : "",
            url: v.url
          }))
        });
      } else {
        groups.push({ title: shortName(m.url), name: baseName,
          qualities: [{ label: "Original (HLS)", meta: "", url: m.url }] });
      }
    } else if (m.type === "DASH") {
      groups.push({ title: shortName(m.url), name: baseName,
        qualities: [{ label: "Best available (DASH)", meta: "", url: m.url }] });
    } else {
      groups.push({ title: shortName(m.url), name: filenameOf(m.url),
        qualities: [{ label: "Original", meta: m.type, url: m.url }] });
    }
  }
  return groups;
}

// Fetch an HLS playlist and, if it's a master, return its variant streams.
async function fetchHlsVariants(url) {
  try {
    // Only http(s) playlist URLs (sniffed from the page's own requests); never
    // let a planted file:/blob:/other URL through this privileged fetch.
    const scheme = (new URL(url)).protocol;
    if (scheme !== "http:" && scheme !== "https:") return null;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;   // a 403/redirect HTML body must not be parsed as a playlist
    const text = await res.text();
    if (text.length > 4 * 1024 * 1024) return null;      // a real master playlist is tiny
    if (!/#EXTM3U/.test(text)) return null;              // not an HLS playlist at all
    if (!/#EXT-X-STREAM-INF/i.test(text)) return null;   // media playlist, not a master
    const lines = text.split("\n");
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l.toUpperCase().startsWith("#EXT-X-STREAM-INF")) continue;
      const bw = /BANDWIDTH=(\d+)/i.exec(l);
      const res2 = /RESOLUTION=(\d+)x(\d+)/i.exec(l);
      let uri = "";
      for (let j = i + 1; j < lines.length; j++) {
        const u = lines[j].trim();
        if (u && !u.startsWith("#")) { uri = u; break; }
      }
      if (uri) out.push({
        bandwidth: bw ? +bw[1] : 0,
        width: res2 ? +res2[1] : 0,
        height: res2 ? +res2[2] : 0,
        url: new URL(uri, url).href
      });
    }
    out.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
    const seen = new Set();
    return out.filter((v) => {
      const k = `${v.height}x${v.bandwidth}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  } catch (_) {
    return null;
  }
}

function shortName(url) {
  try { return new URL(url).hostname + new URL(url).pathname.replace(/^(.{0,40}).*$/, "$1"); }
  catch { return url.slice(0, 50); }
}
function sanitizeName(s) {
  return (s || "").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 120);
}

// ---- Core handoff --------------------------------------------------------
async function handoff(url, tab, referrer, filename, quality, playlist) {
  try {
    const cookies = await cookieHeader(url);
    const payload = {
      type: "download",
      url,
      referrer: referrer || tab?.url || "",
      userAgent: navigator.userAgent,
      cookies,
      filename: sanitizeName(filename) || "",
      quality: quality || "",        // YouTube etc.: chosen yt-dlp quality
      playlist: !!playlist,          // download the whole playlist (yt-dlp --yes-playlist)
      headers: {}
    };
    // For auth-gated sites (Udemy/Coursera/…), attach this site's cookies as a
    // Netscape cookies.txt so yt-dlp can fetch courses you're enrolled in. (The
    // plain Cookie header above is ignored by yt-dlp for these sites.)
    const authDomain = authDomainFor(url);
    if (authDomain) {
      const txt = await exportCookiesAsNetscape(authDomain);
      if (txt) { payload.authDomain = authDomain; payload.authCookiesText = txt; }
    }
    const reply = await sendNative(payload);
    if (reply?.ok) notify("Sent to Nexa", filenameOf(url));
    else notify("Nexa error", reply?.message || "could not reach the app");
    return reply;
  } catch (e) {
    notify("Nexa error", String(e));
    return { ok: false, message: String(e) };
  }
}

function sendNative(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST, payload, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, message: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: true });
      }
    });
  });
}

// Build a "name=value; ..." Cookie header for the target URL.
async function cookieHeader(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch (_) {
    return "";
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function mediaType(url) {
  if (SPOTIFY_PREVIEW_RE.test(url)) return "audio";   // extensionless Spotify preview
  if (/\.m3u8(\?|$)/i.test(url)) return "HLS";
  if (/\.mpd(\?|$)/i.test(url)) return "DASH";
  if (/\.(mp4|mkv|webm|flv|ts|m4v|mov|avi)(\?|$)/i.test(url)) return "video";
  if (/\.(mp3|m4a|aac|ogg|opus|wav|flac)(\?|$)/i.test(url)) return "audio";
  return "file";
}

function filenameOf(url) {
  try { return decodeURIComponent(new URL(url).pathname.split("/").pop()) || url; }
  catch { return url; }
}

function notify(title, message) {
  // Badge-only feedback keeps things quiet; swap for chrome.notifications if desired.
  console.log(`[Nexa] ${title}: ${message}`);
}
