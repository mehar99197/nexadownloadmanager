// Nexa integration — service worker.
// Responsibilities:
//   1. Intercept browser downloads and hand them to the Nexa desktop app.
//   2. Capture cookies + the browser's request context so authed/CDN links don't 403.
//   3. Sniff HLS/DASH/media URLs and offer them for download.
//   4. Provide right-click "Download with Nexa" menu items.
//   5. Serve the toolbar popup / options page (settings live in storage.local).
//
// PROVIDER_CONFIG is the SINGLE source of truth for all host matching and
// cookie-forwarding rules. Everything below is derived from it.

const HOST = "com.nexa.host";
const MEDIA_RE = /\.(m3u8|mpd|mp4|mkv|webm|flv|ts|mp3|m4a|aac|zip|rar|7z|iso|exe|dmg|pkg|deb|apk|pdf)(\?|$)/i;
const SPOTIFY_PREVIEW_RE = /\/\/p\.scdn\.co\/mp3-preview\//i;

// Spotify's full tracks stream as Widevine-DRM encrypted MP4s from
// *.spotifycdn.com — even a "successful" download is unplayable (a few seconds
// of cleartext header, then silence). Never offer those. The 30-second previews
// (p.scdn.co/mp3-preview) ARE plain MP3 and are handled separately above.
function isSpotifyCdn(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return false; }
  return host === "spotifycdn.com" || host.endsWith(".spotifycdn.com");
}

const X = (typeof browser !== "undefined") ? browser : chrome;
// Toolbar button API: `action` under MV3, `browserAction` under MV2.
const ACTION = X.action || X.browserAction || null;
const BADGE_COLOR = "#2bc7ff";        // Nexa brand
const BADGE_ERROR_COLOR = "#e5484d";
const ERROR_BADGE_MS = 10 * 1000;

// Content scripts declared in the manifest are not retroactively injected into
// tabs that were already open when the extension started or was reloaded. Udemy
// is commonly left open in the first tab, so explicitly hydrate existing tabs.
// The content script has its own marker to make this safe alongside normal
// manifest injection and SPA navigations.
async function injectIntoExistingTabs() {
  let tabs = [];
  try { tabs = await X.tabs.query({}); } catch (_) { return; }
  for (const tab of tabs) {
    if (!tab.id || !/^https?:\/\//i.test(tab.url || "")) continue;
    try {
      await X.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    } catch (_) {
      // Chrome internal pages and restricted frames reject script injection.
    }
  }
}

if (X.runtime?.onInstalled) X.runtime.onInstalled.addListener(injectIntoExistingTabs);
if (X.runtime?.onStartup) X.runtime.onStartup.addListener(injectIntoExistingTabs);

// =====================================================================
// PROVIDER CONFIG — single source of truth for all host lists.
// To add a new provider, add one entry here; everything else auto-derives.
// =====================================================================
const PROVIDER_CONFIG = [
  {
    id: "google",
    authDomain: "google.com",
    cookieUrl: "https://drive.google.com/",
    isAuthSite: true,
    hosts: [
      "drive.google.com", "drive.usercontent.google.com",
      "docs.google.com", "photos.google.com", "video.google.com",
      "googleusercontent.com", "googlevideo.com", "ggpht.com"
    ]
  },
  {
    id: "microsoft",
    authDomain: "live.com",
    cookieUrl: "https://onedrive.live.com/",
    isAuthSite: false,
    hosts: [
      "onedrive.live.com", "1drv.ms", "sharepoint.com",
      "microsoft.com", "microsoftonline.com", "live.net", "svc.ms"
    ]
  },
  {
    id: "dropbox",
    authDomain: "dropbox.com",
    cookieUrl: "https://www.dropbox.com/",
    isAuthSite: false,
    hosts: [
      "dropbox.com", "www.dropbox.com", "dropboxusercontent.com"
    ]
  },
  {
    id: "mediafire",
    authDomain: "mediafire.com",
    cookieUrl: "https://www.mediafire.com/",
    isAuthSite: false,
    hosts: [
      "mediafire.com", "www.mediafire.com", "download.mediafire.com"
    ]
  },
  {
    id: "meta",
    authDomain: "facebook.com",
    cookieUrl: "https://www.facebook.com/",
    isAuthSite: true,
    hosts: [
      "facebook.com", "instagram.com", "fbcdn.net",
      "cdninstagram.com", "threads.net"
    ]
  },
  {
    id: "ai",
    authDomain: "", // resolved per-host
    cookieUrl: "",  // resolved per-host
    isAuthSite: false,
    // AI attachment URLs can require a short-lived Authorization header which is
    // not available through chrome.cookies. Capture the real browser request
    // context immediately before it is sent.
    captureRequestHeaders: true,
    hosts: [
      "chatgpt.com", "openai.com", "oaiusercontent.com",
      "huggingface.co", "cdn-lfs.huggingface.co",
      "claude.ai", "claudeusercontent.com",
      "grok.com", "x.ai",
      "perplexity.ai", "pplx.ai", "pplx-res.cloudinary.com",
      // Keep the registry extensible for other browser-based AI assistants.
      "gemini.google.com", "chat.mistral.ai", "mistral.ai",
      "chat.deepseek.com", "deepseek.com", "poe.com", "poecdn.net",
      "character.ai", "characterai.io", "pi.ai", "you.com", "you.ai"
    ],
    authResolver(host) {
      if (host.includes("openai") || host.includes("chatgpt") || host.includes("oaiusercontent"))
        return { domain: "chatgpt.com", url: "https://chatgpt.com/" };
      if (host.includes("huggingface"))
        return { domain: "huggingface.co", url: "https://huggingface.co/" };
      if (host.includes("claude"))
        return { domain: "claude.ai", url: "https://claude.ai/" };
      if (host === "grok.com" || host.endsWith(".grok.com") ||
          host === "x.ai" || host.endsWith(".x.ai"))
        return { domain: "grok.com", url: "https://grok.com/" };
      if (host.includes("perplexity") || host.includes("pplx"))
        return { domain: "perplexity.ai", url: "https://www.perplexity.ai/" };
      if (host === "gemini.google.com" || host.endsWith(".gemini.google.com"))
        return { domain: "google.com", url: "https://gemini.google.com/" };
      if (host.includes("mistral"))
        return { domain: "mistral.ai", url: "https://chat.mistral.ai/" };
      if (host.includes("deepseek"))
        return { domain: "deepseek.com", url: "https://chat.deepseek.com/" };
      if (host.includes("poe"))
        return { domain: "poe.com", url: "https://poe.com/" };
      if (host.includes("character"))
        return { domain: "character.ai", url: "https://character.ai/" };
      if (host === "pi.ai" || host.endsWith(".pi.ai"))
        return { domain: "pi.ai", url: "https://pi.ai/" };
      if (host === "you.com" || host.endsWith(".you.com") ||
          host === "you.ai" || host.endsWith(".you.ai"))
        return { domain: "you.com", url: "https://you.com/" };
      return null;
    }
  },
  {
    id: "auth_only",
    authDomain: "", // has no download hosts, only cookie export
    cookieUrl: "",
    isAuthSite: true,
    authDomains: ["udemy.com", "vimeo.com", "coursera.org",
                  "skillshare.com", "pluralsight.com", "linkedin.com"]
  },
  {
    id: "moviebox",
    authDomain: "movie-box.co",
    cookieUrl: "https://movie-box.co/",
    isAuthSite: false,
    hosts: [
      "movie-box.co", "www.movie-box.co",
      "aoneroom.com", "macdn.aoneroom.com",
      "pacdn.aoneroom.com", "pbcdnw.aoneroom.com",
      "hakunaymatata.com", "sbcdnw2.hakunaymatata.com"
    ]
  }
];

// Derived list: auth domains for NEXA_AUTH_SITES (yt-dlp cookies.txt export).
const NEXA_AUTH_SITES = (() => {
  const sites = [];
  for (const p of PROVIDER_CONFIG) {
    if (p.authDomains) {
      sites.push(...p.authDomains);
    } else if (p.isAuthSite && p.authDomain) {
      sites.push(p.authDomain);
    }
  }
  return [...new Set(sites)];
})();

// Derived: host -> provider lookup (lazy-built).
let _hostProvider = null;
function providerFor(host) {
  if (!_hostProvider) {
    _hostProvider = {};
    for (const p of PROVIDER_CONFIG) {
      for (const h of (p.hosts || [])) {
        _hostProvider[h] = p;
      }
    }
  }
  host = host.toLowerCase();
  if (_hostProvider[host]) return _hostProvider[host];
  for (const [h, p] of Object.entries(_hostProvider)) {
    if (host === h || host.endsWith("." + h)) return p;
  }
  return null;
}

// Derived: BROWSER_ONLY_HOSTS (currently none).
const BROWSER_ONLY_HOSTS = [];

function letBrowserHandle(url) {
  if (!BROWSER_ONLY_HOSTS.length) return false;
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return BROWSER_ONLY_HOSTS.some((d) => host === d || host.endsWith("." + d));
}

// These URLs belong to the renderer or to an AI assistant's virtual file layer, not to
// an HTTP server that the Qt engine can access. Leaving them in Nexa would make
// the browser download disappear and then produce "unsupported url scheme".
// Let the page/browser perform these downloads instead.
function isBrowserOwnedDownloadUrl(url) {
  return /^(?:blob|data|sandbox):/i.test(String(url || ""));
}

const authOnlyDomains = (() => {
  const d = [];
  for (const p of PROVIDER_CONFIG) {
    if (p.authDomains) d.push(...p.authDomains);
  }
  return d;
})();

function authDomainFor(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return ""; }
  for (const d of NEXA_AUTH_SITES)
    if (host === d || host.endsWith("." + d)) return d;
  for (const d of authOnlyDomains)
    if (host === d || host.endsWith("." + d)) return d;
  return "";
}

function getProviderCookieInfo(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  const p = providerFor(host);
  if (!p) return null;
  if (p.authResolver) return p.authResolver(host);
  return { domain: p.authDomain, url: p.cookieUrl };
}

// ---- Storage helpers -------------------------------------------------------
// Callback-style calls work under both namespaces (chrome.* in Chromium and
// Firefox); a promise-returning implementation is handled as well.
function storageGet(area, keys) {
  return new Promise((resolve) => {
    const st = chrome.storage && chrome.storage[area];
    if (!st || typeof st.get !== "function") return resolve({});
    try {
      const ret = st.get(keys, (v) => { void chrome.runtime.lastError; resolve(v || {}); });
      if (ret && typeof ret.then === "function") ret.then((v) => resolve(v || {}), () => resolve({}));
    } catch (_) { resolve({}); }
  });
}
function storageSet(area, obj) {
  return new Promise((resolve) => {
    const st = chrome.storage && chrome.storage[area];
    if (!st || typeof st.set !== "function") return resolve(false);
    try {
      const ret = st.set(obj, () => { void chrome.runtime.lastError; resolve(true); });
      if (ret && typeof ret.then === "function") ret.then(() => resolve(true), () => resolve(false));
    } catch (_) { resolve(false); }
  });
}

// ---- Settings (storage.local) ---------------------------------------------
// Every key below is user-editable from the options page / popup. Keep the
// defaults in ONE place; normalizeSettings() coerces whatever storage holds.
const INTERCEPT_ALL = "*";   // interceptTypes entry meaning "every file type"
const DEFAULT_INTERCEPT_TYPES = [
  // archives / disk images
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz", "iso", "img",
  // installers / binaries
  "exe", "msi", "dmg", "pkg", "deb", "rpm", "apk", "appimage", "bin",
  // video
  "mp4", "mkv", "webm", "avi", "mov", "flv", "wmv", "m4v", "ts",
  // audio
  "mp3", "m4a", "aac", "flac", "wav", "ogg", "opus",
  // documents
  "pdf", "epub", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "torrent"
];
const SETTINGS_DEFAULTS = Object.freeze({
  enabled: true,               // master "take over downloads" switch
  minSizeMB: 0,                // 0 = every size; >0 lets the browser keep smaller files
  interceptTypes: DEFAULT_INTERCEPT_TYPES,   // ["*"] = all file types
  disabledHosts: [],           // hosts (plus their subdomains) where Nexa stays out
  askBeforeHandoff: false,     // pass ask:true so the app confirms before starting
  showFloatingButton: true,    // content.js Download button on media pages
  notifyOnHandoff: true        // "Sent to Nexa: <name>" system notification
});

function normalizeHostEntry(entry) {
  let s = String(entry == null ? "" : entry).trim().toLowerCase();
  if (!s) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try { s = new URL(s).hostname; } catch (_) { return ""; }
  } else {
    s = s.split(/[/?#]/)[0];            // "example.com/path" -> "example.com"
  }
  s = s.replace(/^\*?\.+/, "").replace(/\.+$/, "").replace(/:\d+$/, "");
  return /^[a-z0-9.-]+$/.test(s) ? s : "";
}
function normalizeHostList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const h = normalizeHostEntry(raw);
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}
function normalizeTypeList(list) {
  if (!Array.isArray(list)) return [...DEFAULT_INTERCEPT_TYPES];
  const out = [];
  for (const raw of list) {
    let t = String(raw == null ? "" : raw).trim().toLowerCase();
    if (t === INTERCEPT_ALL || t === "all") t = INTERCEPT_ALL;
    else t = t.replace(/^\.+/, "");
    if (t !== INTERCEPT_ALL && !/^[a-z0-9]{1,12}$/.test(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}
function normalizeSettings(v) {
  const s = v || {};
  const min = Number(s.minSizeMB);
  return {
    enabled: s.enabled !== false,
    minSizeMB: Number.isFinite(min) && min > 0 ? min : 0,
    interceptTypes: normalizeTypeList(s.interceptTypes),
    disabledHosts: normalizeHostList(s.disabledHosts),
    askBeforeHandoff: s.askBeforeHandoff === true,
    showFloatingButton: s.showFloatingButton !== false,
    notifyOnHandoff: s.notifyOnHandoff !== false
  };
}

const settings = normalizeSettings({});
const settingsReady = storageGet("local", SETTINGS_DEFAULTS)
  .then((v) => { Object.assign(settings, normalizeSettings(v)); })
  .catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const patch = {};
  for (const key of Object.keys(SETTINGS_DEFAULTS))
    if (changes[key]) patch[key] = changes[key].newValue;
  if (Object.keys(patch).length)
    Object.assign(settings, normalizeSettings({ ...settings, ...patch }));
});

// ---- Pure setting predicates (unit-tested in tests/ExtensionSettingsTest.js) --
function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ""; }
}
// `target` may be a URL, an origin or a bare hostname. Matches the exact host
// and every subdomain of a listed entry — never a mere suffix ("evilexample.com").
function isHostDisabled(target, list) {
  if (!Array.isArray(list) || !list.length) return false;
  const host = hostnameOf(target) || normalizeHostEntry(target);
  if (!host) return false;
  return list.some((raw) => {
    const d = normalizeHostEntry(raw);
    return !!d && (host === d || host.endsWith("." + d));
  });
}
// minSizeMB <= 0 takes everything; an unknown size (<= 0 / NaN) is taken over
// because the browser has not seen the headers yet and Nexa can probe itself.
function passesMinSize(bytes, minSizeMB) {
  const min = Number(minSizeMB);
  if (!Number.isFinite(min) || min <= 0) return true;
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return true;
  return n >= min * 1024 * 1024;
}
function downloadSizeOf(item) {
  const known = [item?.fileSize, item?.totalBytes]
    .map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return known.length ? Math.max(...known) : -1;
}
function extensionOf(name) {
  const base = String(name || "").split(/[\\/]/).pop();
  const m = /\.([a-z0-9]{1,12})$/i.exec(base);
  return m ? m[1].toLowerCase() : "";
}
function urlExtension(url) {
  let path;
  try { path = new URL(url).pathname; } catch (_) { return ""; }
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch (_) {}
  return extensionOf(decoded);
}
// Case-insensitive extension match; "*" means every type. The browser's own
// filename wins over the URL path. No detectable extension (dynamic endpoints
// such as /download?id=…) is taken over so Nexa can probe the real type.
function matchesInterceptType(url, filename, types) {
  const list = normalizeTypeList(Array.isArray(types) ? types : DEFAULT_INTERCEPT_TYPES);
  if (list.includes(INTERCEPT_ALL)) return true;
  const ext = extensionOf(filename) || urlExtension(url);
  if (!ext) return true;
  return list.includes(ext);
}

// ---- Link grabber payload ---------------------------------------------------
// One `links` message per page: deduped, http(s) only, capped. The desktop app
// shows its own grabber dialog where the user filters and ticks entries.
const MAX_LINKS = 2000;
const MAX_LINK_TEXT = 200;
const LINK_KINDS = new Set(["link", "image", "media"]);
function headerPairSafe(name, value) {
  return !!name && typeof value === "string" && value !== ""
      && !/[\x00-\x1f\x7f]/.test(name) && !/[\r\n\x00]/.test(value);
}
function buildLinksPayload(input, max = MAX_LINKS) {
  const src = input || {};
  const links = [];
  const seen = new Set();
  const cap = Number.isInteger(max) && max > 0 ? max : MAX_LINKS;
  for (const raw of (Array.isArray(src.links) ? src.links : [])) {
    if (links.length >= cap) break;
    const item = typeof raw === "string" ? { url: raw } : (raw || {});
    let parsed;
    try { parsed = new URL(String(item.url || "")); } catch (_) { continue; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    parsed.hash = "";                       // fragments never reach the server
    if (seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    links.push({
      url: parsed.href,
      text: String(item.text || "").replace(/\s+/g, " ").trim().slice(0, MAX_LINK_TEXT),
      kind: LINK_KINDS.has(item.kind) ? item.kind : "link"
    });
  }
  const headers = [];
  const seenHeader = new Set();
  for (const pair of (Array.isArray(src.headers) ? src.headers : [])) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const name = String(pair[0] || "").trim().toLowerCase();
    if (!headerPairSafe(name, pair[1]) || seenHeader.has(name)) continue;
    seenHeader.add(name);
    headers.push([name, pair[1]]);
  }
  return {
    type: "links",
    pageUrl: String(src.pageUrl || ""),
    pageTitle: String(src.pageTitle || "").replace(/\s+/g, " ").trim().slice(0, 300),
    links,
    headers
  };
}

// ---- Cookie export --------------------------------------------------------
async function exportCookiesAsNetscape(authDomain, targetUrl) {
  const queries = [
    ...(targetUrl ? [{ url: targetUrl }] : []),
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
  if (!cookies.length) return "";
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
    if (/[\x00-\x1f\x7f]/.test(c.name) || /[\x00-\x1f\x7f]/.test(c.value)) continue;
    const dom = c.domain;
    const includeSub = dom.startsWith(".") ? "TRUE" : "FALSE";
    const path = c.path || "/";
    const secure = c.secure ? "TRUE" : "FALSE";
    const expires = (c.session || !c.expirationDate) ? 0 : Math.floor(c.expirationDate);
    const prefix = c.httpOnly ? "#HttpOnly_" : "";
    lines.push(`${prefix}${dom}\t${includeSub}\t${path}\t${secure}\t${expires}\t${c.name}\t${c.value}`);
    kept++;
  }
  if (kept === 0) return "";
  return lines.join("\n") + "\n";
}

// ---- Request-context capture ------------------------------------------------
// Some AI attachment endpoints authenticate a download with
// transient browser request headers such as Authorization. chrome.cookies cannot
// see those values, so retain the headers from the real request briefly and only
// replay them when Nexa is handed the exact URL. The cache is mirrored into
// storage.session (memory-only, cleared when the browser closes) so a captured
// Authorization header survives service-worker teardown — never to disk.
const CAPTURED_HEADER_TTL_MS = 2 * 60 * 1000;
const MAX_CAPTURED_REQUESTS = 64;
const MAX_CAPTURED_HEADER_VALUE_BYTES = 16 * 1024;
const MAX_CAPTURED_HEADER_BYTES = 64 * 1024;
const CAPTURED_HEADER_DENYLIST = new Set([
  "host", "content-length", "transfer-encoding", "connection", "proxy-authorization"
]);
const capturedRequests = new Map();
const CAPTURED_SESSION_KEY = "capturedRequests";

function requestUrlKey(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = ""; // fragments are never sent over HTTP
    return parsed.href;
  } catch (_) { return ""; }
}

function shouldCaptureRequestHeaders(url) {
  try {
    return !!providerFor(new URL(url).hostname)?.captureRequestHeaders;
  } catch (_) { return false; }
}

function captureKey(tabId, urlKey) {
  return `${tabId}\n${urlKey}`;
}

function evictExpiredCapturedRequests(now = Date.now()) {
  for (const [key, entry] of capturedRequests) {
    if (now - entry.capturedAt > CAPTURED_HEADER_TTL_MS)
      capturedRequests.delete(key);
  }
  while (capturedRequests.size > MAX_CAPTURED_REQUESTS)
    capturedRequests.delete(capturedRequests.keys().next().value);
}

// Coalesce bursts of captures into one storage.session write.
let capturedPersistTimer = null;
function persistCapturedRequests() {
  if (capturedPersistTimer) return;
  capturedPersistTimer = setTimeout(() => {
    capturedPersistTimer = null;
    storageSet("session", { [CAPTURED_SESSION_KEY]: Array.from(capturedRequests.values()) });
  }, 250);
}

function cacheRequestHeaders(details) {
  // Do not transfer an Incognito session to the desktop app. Requests without a
  // tab still get an exact-URL entry: downloads.onCreated has no tab ID and
  // An AI assistant can issue attachment requests from a renderer-owned path.
  if (details.incognito || !shouldCaptureRequestHeaders(details.url)) return;
  const urlKey = requestUrlKey(details.url);
  if (!urlKey) return;

  const headers = Object.create(null);
  let totalBytes = 0;
  for (const header of (details.requestHeaders || [])) {
    const name = String(header.name || "").trim();
    const value = typeof header.value === "string" ? header.value : "";
    const lowerName = name.toLowerCase();
    // The native side repeats its own sanitisation and framing-header rejection.
    // Applying the same basic guard here keeps the ephemeral cache bounded and
    // avoids retaining headers that can never be replayed.
    if (!name || !value || CAPTURED_HEADER_DENYLIST.has(lowerName)
        || /[\x00-\x1f\x7f]/.test(name) || /[\r\n\x00]/.test(value)
        || value.length > MAX_CAPTURED_HEADER_VALUE_BYTES) continue;
    const bytes = name.length + value.length;
    if (totalBytes + bytes > MAX_CAPTURED_HEADER_BYTES) continue;
    headers[name] = value;
    totalBytes += bytes;
  }
  if (!Object.keys(headers).length) return;

  const now = Date.now();
  const tabId = Number.isInteger(details.tabId) ? details.tabId : -1;
  const key = captureKey(tabId, urlKey);
  // Refresh Map insertion order so capacity eviction always removes the oldest
  // observation when a browser retries the same attachment request.
  capturedRequests.delete(key);
  capturedRequests.set(key, { tabId, urlKey, headers, capturedAt: now });
  evictExpiredCapturedRequests(now);
  persistCapturedRequests();
}

function capturedHeadersFor(url, tabId) {
  const urlKey = requestUrlKey(url);
  if (!urlKey) return {};
  const now = Date.now();
  evictExpiredCapturedRequests(now);

  let match = Number.isInteger(tabId)
    ? capturedRequests.get(captureKey(tabId, urlKey))
    : null;
  // downloads.onCreated does not give us a tab ID. In that flow the most recent
  // matching request is still safe: it has the same full URL and browser profile.
  if (!match) {
    for (const entry of capturedRequests.values()) {
      if (entry.urlKey === urlKey
          && (!match || entry.capturedAt > match.capturedAt)) match = entry;
    }
  }
  return match ? { ...match.headers } : {};
}

// Match patterns for exactly the hosts whose request context we capture.
//
// Registering an `extraHeaders` listener is not free: in Chromium it opts EVERY
// request in the browser out of network-stack fast paths, whether or not the
// listener does anything with it. cacheRequestHeaders() returns immediately for
// any host without captureRequestHeaders, so <all_urls> was paying that cost
// across the whole browser to serve a handful of AI-assistant hosts.
const CAPTURE_URL_PATTERNS = (() => {
  const patterns = [];
  for (const p of PROVIDER_CONFIG) {
    if (!p.captureRequestHeaders) continue;
    for (const h of (p.hosts || [])) patterns.push(`*://${h}/*`, `*://*.${h}/*`);
  }
  // addListener rejects an empty url list; fall back rather than throw if the
  // registry ever stops marking any provider for capture.
  return patterns.length ? patterns : ["<all_urls>"];
})();

chrome.webRequest.onBeforeSendHeaders.addListener(
  cacheRequestHeaders,
  { urls: CAPTURE_URL_PATTERNS },
  // extraHeaders exposes Cookie and Authorization in Chromium. We observe only;
  // no blocking permission or request mutation is needed.
  ["requestHeaders", "extraHeaders"]
);

// ---- Tab media tracking ---------------------------------------------------
const tabMedia = new Map();
const sessKey = (tabId) => "media_" + tabId;
function persistTabMedia(tabId, list) {
  try { chrome.storage.session.set({ [sessKey(tabId)]: list }); } catch (_) {}
}
function dropTabMedia(tabId) {
  tabMedia.delete(tabId);
  try { chrome.storage.session.remove(sessKey(tabId)); } catch (_) {}
  updateBadgeForTab(tabId);
}
const MAX_MEDIA_PER_TAB = 40;
function addMedia(tabId, url, type) {
  if (tabId < 0) return;
  const list = tabMedia.get(tabId) || [];
  if (list.some((m) => m.url === url)) return;
  if (list.length >= MAX_MEDIA_PER_TAB) return;
  list.push({ url, type });
  tabMedia.set(tabId, list);
  persistTabMedia(tabId, list);
  updateBadgeForTab(tabId);
  pushMediaChanged(tabId);
}
async function getTabMedia(tabId) {
  if (tabId == null) return [];
  if (tabMedia.has(tabId)) return tabMedia.get(tabId);
  try {
    const v = await chrome.storage.session.get(sessKey(tabId));
    const list = v[sessKey(tabId)] || [];
    if (list.length) tabMedia.set(tabId, list);
    return list;
  } catch (_) { return []; }
}

// Tell the tab's content script that its media set changed so the pill can
// appear without polling. Coalesced per tab; a missing receiver is fine.
const mediaPushTimers = new Map();
function pushMediaChanged(tabId) {
  if (mediaPushTimers.has(tabId)) return;
  mediaPushTimers.set(tabId, setTimeout(async () => {
    mediaPushTimers.delete(tabId);
    const list = (tabMedia.get(tabId) || []).filter((m) => VIDEO_TYPES.has(m.type));
    try {
      await X.tabs.sendMessage(tabId, {
        type: "nexa-media-changed",
        count: list.length,
        signature: list.map((m) => m.url).join("|")
      });
    } catch (_) {}
  }, 300));
}

// ---- Toolbar badge --------------------------------------------------------
function setBadge(tabId, text) {
  if (!ACTION || typeof ACTION.setBadgeText !== "function") return;
  const q = { text: String(text || "") };
  if (Number.isInteger(tabId) && tabId >= 0) q.tabId = tabId;
  try {
    const r = ACTION.setBadgeText(q);
    if (r && typeof r.catch === "function") r.catch(() => {});
  } catch (_) {}
}
function setBadgeColor(color) {
  if (!ACTION || typeof ACTION.setBadgeBackgroundColor !== "function") return;
  try {
    const r = ACTION.setBadgeBackgroundColor({ color });
    if (r && typeof r.catch === "function") r.catch(() => {});
  } catch (_) {}
}
function updateBadgeForTab(tabId) {
  const n = (tabMedia.get(tabId) || []).length;
  setBadge(tabId, n ? String(n) : "");
}
// Red "!" for 10 s when the desktop app / native host cannot be reached.
let errorBadgeTimer = null;
let errorBadgeTabId = -1;
async function flashErrorBadge() {
  if (!ACTION) return;
  let tab = null;
  try { tab = await activeTab(); } catch (_) {}
  setBadgeColor(BADGE_ERROR_COLOR);
  setBadge(-1, "!");
  if (tab?.id != null) { errorBadgeTabId = tab.id; setBadge(tab.id, "!"); }
  clearTimeout(errorBadgeTimer);
  errorBadgeTimer = setTimeout(clearErrorBadge, ERROR_BADGE_MS);
}
function clearErrorBadge() {
  errorBadgeTimer = null;
  setBadgeColor(BADGE_COLOR);
  setBadge(-1, "");
  if (errorBadgeTabId >= 0) updateBadgeForTab(errorBadgeTabId);
  errorBadgeTabId = -1;
}

// ---- quality-probe cache ---------------------------------------------------
const FMT_CACHE_TTL = 5 * 60 * 1000;
const FMT_CACHE_MAX = 32;
const FMT_SESSION_KEY = "fmtCache";
const fmtCache = new Map();
const fmtInflight = new Map();

function persistFmtCache() {
  storageSet("session", {
    [FMT_SESSION_KEY]: Array.from(fmtCache, ([url, v]) => ({ url, result: v.result, ts: v.ts }))
  });
}

async function listFormatsCached(url) {
  await stateReady;
  const hit = fmtCache.get(url);
  if (hit && (Date.now() - hit.ts) < FMT_CACHE_TTL) return hit.result;
  if (fmtInflight.has(url)) return fmtInflight.get(url);
  const p = (async () => {
    const r = await sendNative({ type: "list-formats", url });
    if (r && r.ok) {
      fmtCache.set(url, { result: r, ts: Date.now() });
      if (fmtCache.size > FMT_CACHE_MAX)
        fmtCache.delete(fmtCache.keys().next().value);
      persistFmtCache();
    }
    fmtInflight.delete(url);
    return r;
  })();
  fmtInflight.set(url, p);
  return p;
}

// ---- Service-worker survival: rehydrate from storage.session ---------------
// MV3 tears the worker down after ~30 s idle. Everything a later event needs
// (sniffed media, captured Authorization headers, the quality cache) is
// mirrored in storage.session and merged back in here; in-memory entries that
// arrived before this finished win.
const stateReady = (async () => {
  const all = await storageGet("session", null);
  const now = Date.now();
  for (const [key, value] of Object.entries(all || {})) {
    if (key.startsWith("media_")) {
      const tabId = Number(key.slice(6));
      if (!Number.isInteger(tabId) || !Array.isArray(value)) continue;
      const cur = tabMedia.get(tabId) || [];
      const merged = [...value.filter((m) => m && m.url && !cur.some((c) => c.url === m.url)), ...cur]
        .slice(0, MAX_MEDIA_PER_TAB);
      if (merged.length) tabMedia.set(tabId, merged);
    } else if (key === CAPTURED_SESSION_KEY && Array.isArray(value)) {
      for (const entry of value) {
        if (!entry || !entry.urlKey || !entry.headers) continue;
        if (now - Number(entry.capturedAt || 0) > CAPTURED_HEADER_TTL_MS) continue;
        const k = captureKey(Number.isInteger(entry.tabId) ? entry.tabId : -1, entry.urlKey);
        if (!capturedRequests.has(k)) capturedRequests.set(k, entry);
      }
      evictExpiredCapturedRequests(now);
    } else if (key === FMT_SESSION_KEY && Array.isArray(value)) {
      for (const entry of value) {
        if (!entry || !entry.url || !entry.result) continue;
        if (now - Number(entry.ts || 0) >= FMT_CACHE_TTL) continue;
        if (!fmtCache.has(entry.url)) fmtCache.set(entry.url, { result: entry.result, ts: entry.ts });
      }
      while (fmtCache.size > FMT_CACHE_MAX) fmtCache.delete(fmtCache.keys().next().value);
    }
  }
  for (const tabId of tabMedia.keys()) updateBadgeForTab(tabId);
})().catch(() => {});

setBadgeColor(BADGE_COLOR);
setBadge(-1, "");   // clear a stale "!" left by a worker that died mid-flash

// ---- Recent handoffs + last errors (popup / diagnostics) --------------------
const MAX_RECENT = 8;
const MAX_ERRORS = 20;
async function recordRecent(entry) {
  const v = await storageGet("local", { recent: [] });
  const list = Array.isArray(v.recent) ? v.recent : [];
  list.unshift({
    name: String(entry.name || "").slice(0, 120),
    host: String(entry.host || "").slice(0, 120),
    time: Date.now(),
    ok: !!entry.ok,
    message: entry.message ? String(entry.message).slice(0, 200) : ""
  });
  await storageSet("local", { recent: list.slice(0, MAX_RECENT) });
}
async function recordError(context, message) {
  const v = await storageGet("local", { lastErrors: [] });
  const list = Array.isArray(v.lastErrors) ? v.lastErrors : [];
  list.unshift({ time: Date.now(), context: String(context || ""), message: String(message || "").slice(0, 300) });
  await storageSet("local", { lastErrors: list.slice(0, MAX_ERRORS) });
}

function isEngineUnavailable(reply) {
  if (!reply || reply.ok) return false;
  if (reply.unavailable) return true;
  return /engine unavailable|native messaging host|host has exited|not found|forbidden/i
    .test(String(reply.message || ""));
}

// ---- Context menus ---------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "nexa-link",  title: "Download with Nexa",        contexts: ["link"] });
  chrome.contextMenus.create({ id: "nexa-media", title: "Download video/audio with Nexa", contexts: ["video", "audio", "image"] });
  chrome.contextMenus.create({ id: "nexa-page",  title: "Download all links on page",  contexts: ["page"] });
  // No "whole course" item: yt-dlp can't read a whole Udemy course, so that
  // handoff always failed. A lecture goes from the Download button on its page.
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "nexa-link" && info.linkUrl) {
    if (isBrowserOwnedDownloadUrl(info.linkUrl))
      await requestBrowserDownload(tab, info.linkUrl, "");
    else
      await handoff(info.linkUrl, tab, "", "", "", false, true);
  } else if (info.menuItemId === "nexa-media" && info.srcUrl) {
    if (isBrowserOwnedDownloadUrl(info.srcUrl))
      await requestBrowserDownload(tab, info.srcUrl, "");
    else
      await handoff(info.srcUrl, tab, "", "", "", false, true);
  } else if (info.menuItemId === "nexa-page" && tab?.id) {
    await grabLinks(tab, "links");
  }
});

// ---- Keyboard shortcut (Alt+Shift+N) ---------------------------------------
if (X.commands?.onCommand) {
  X.commands.onCommand.addListener(async (command) => {
    if (command !== "send-page-to-nexa") return;
    let tab = null;
    try { tab = await activeTab(); } catch (_) {}
    if (!tab?.url || !/^https?:\/\//i.test(tab.url)) {
      notify("Open a web page first, then press the shortcut again.");
      return;
    }
    await handoff(tab.url, tab, tab.url, "", "", false, true);
  });
}

// ---- Download interception -------------------------------------------------
chrome.downloads.onCreated.addListener(async (item) => {
  await settingsReady;
  if (!settings.enabled) return;

  // Only adopt a download the user just started.
  //
  // onCreated does NOT fire solely for fresh clicks: when the browser starts it
  // re-creates the downloads left over from the previous session (interrupted,
  // paused, or resumable ones) and fires onCreated for each. Without the guards
  // below, every one of those stale items was handed to Nexa the moment the
  // browser opened — which is why opening Chrome queued a pile of old .deb/.php
  // files nobody asked for, and why they showed 0 B with "Resume capability: No".
  //
  // Three independent signals distinguish a restored item from a real click:
  //   state    — a restored leftover is "interrupted"/"complete", never "in_progress"
  //   bytes    — a genuinely new download has received nothing yet
  //   startTime— a restored item keeps its ORIGINAL timestamp from the old session
  if (item.state && item.state !== "in_progress") return;
  if (item.paused) return;
  if (Number(item.bytesReceived) > 0) return;
  const startedAt = Date.parse(item.startTime || "");
  if (Number.isFinite(startedAt) && Date.now() - startedAt > 60000) return;

  const originalUrl = item.url || "";
  const targetUrl = item.finalUrl || originalUrl;
  if (!targetUrl || isBrowserOwnedDownloadUrl(originalUrl)
      || isBrowserOwnedDownloadUrl(targetUrl)) return;
  if (letBrowserHandle(targetUrl)) return;

  // User-configurable gates (options page / popup "Pause on this site").
  if (isHostDisabled(item.referrer || "", settings.disabledHosts)
      || isHostDisabled(targetUrl, settings.disabledHosts)) return;
  if (!passesMinSize(downloadSizeOf(item), settings.minSizeMB)) return;
  if (!matchesInterceptType(targetUrl, item.filename, settings.interceptTypes)) return;

  // Let Nexa acknowledge the handoff before deleting the browser's copy. If
  // the native host is unavailable or rejects the URL, the browser download
  // continues instead of silently losing the user's file.
  const reply = await handoff(targetUrl, null, item.referrer, item.filename, "", false, true, originalUrl);
  if (reply?.ok) {
    try {
      await X.downloads.cancel(item.id);
      await X.downloads.erase({ id: item.id });
    } catch (e) {
      const why = (e && e.message) || String(e);
      notify(`Nexa has the download, but the browser's copy could not be cancelled: ${why}`);
      await recordError("cancel-browser-download", why);
    }
  }
});

// ---- Media sniffing --------------------------------------------------------
// The page that issued the request (Chromium: initiator; Firefox: originUrl /
// documentUrl). Falls back to the request URL itself.
function sniffAllowed(details) {
  if (details.tabId < 0) return false;
  const origin = details.initiator || details.originUrl || details.documentUrl || "";
  if (origin && isHostDisabled(origin, settings.disabledHosts)) return false;
  if (isHostDisabled(details.url, settings.disabledHosts)) return false;
  return true;
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!sniffAllowed(details)) return;
    if (!MEDIA_RE.test(details.url) && !SPOTIFY_PREVIEW_RE.test(details.url)) return;
    if (isSpotifyCdn(details.url)) return;
    addMedia(details.tabId, details.url, mediaType(details.url));
  },
  { urls: ["<all_urls>"] }
);

const SEGMENT_RE = /\.(m4s|ts)(\?|$)|[?&](range|bytes)=|\/(seg(ment)?|chunk|frag(ment)?)[-_/0-9]/i;
function ctOf(headers) {
  for (const h of (headers || []))
    if (h.name.toLowerCase() === "content-type") return (h.value || "").toLowerCase();
  return "";
}
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!sniffAllowed(details)) return;
    const ct = ctOf(details.responseHeaders);
    if (!ct) return;
    let type = "";
    if (/(application|audio|video)\/(x-mpegurl|vnd\.apple\.mpegurl|mpegurl)/.test(ct)) type = "HLS";
    else if (/application\/dash\+xml/.test(ct)) type = "DASH";
    else if (/^audio\//.test(ct)) type = "audio";
    else if (/^video\//.test(ct)) type = "video";
    else return;
    if ((type === "audio" || type === "video") && SEGMENT_RE.test(details.url)) return;
    if (isSpotifyCdn(details.url)) return;
    addMedia(details.tabId, details.url, type);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.tabs.onRemoved.addListener((tabId) => dropTabMedia(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") dropTabMedia(tabId);
});

const VIDEO_TYPES = new Set(["HLS", "DASH", "video", "audio"]);

// ---- Messages ---------------------------------------------------------------
// From content.js (sender.tab set) and from popup.html (no sender.tab — the
// popup passes tabId, else the active tab is used).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) return;
  (async () => {
    try {
      let tab = sender.tab || null;
      if (!tab && Number.isInteger(msg.tabId)) {
        try { tab = await X.tabs.get(msg.tabId); } catch (_) { tab = null; }
      }
      if (!tab) tab = await activeTab();
      if (msg.type === "nexa-download") {
        const r = isBrowserOwnedDownloadUrl(msg.url)
          ? await requestBrowserDownload(tab, msg.url, msg.filename)
          : await handoff(msg.url, tab, tab?.url, msg.filename, msg.quality,
                          msg.playlist, true);
        sendResponse(r);
      } else if (msg.type === "nexa-media-count") {
        await stateReady;
        const list = (await getTabMedia(tab?.id)).filter((m) => VIDEO_TYPES.has(m.type));
        sendResponse({ count: list.length, signature: list.map((m) => m.url).join("|") });
      } else if (msg.type === "nexa-list-formats") {
        sendResponse(await listFormatsCached(msg.url));
      } else if (msg.type === "nexa-prefetch-formats") {
        listFormatsCached(msg.url);
        sendResponse({ ok: true, prefetching: true });
      } else if (msg.type === "nexa-get-qualities") {
        await stateReady;
        sendResponse(await buildQualities(tab));
      } else if (msg.type === "nexa-get-media") {
        await stateReady;
        sendResponse(await getTabMedia(tab?.id));
      } else if (msg.type === "nexa-ping") {
        sendResponse(await pingEngine());
      } else if (msg.type === "nexa-show") {
        sendResponse(await sendNative({ type: "show" }));
      } else if (msg.type === "nexa-grab-links") {
        sendResponse(await grabLinks(tab, "links"));
      } else if (msg.type === "nexa-grab-media") {
        sendResponse(await grabLinks(tab, "media"));
      } else if (msg.type === "nexa-get-defaults") {
        sendResponse({ ok: true, defaults: { ...SETTINGS_DEFAULTS, interceptTypes: [...DEFAULT_INTERCEPT_TYPES] } });
      } else {
        sendResponse({ ok: false, message: "unknown message" });
      }
    } catch (e) {
      try { sendResponse({ ok: false, message: String(e && e.message || e) }); } catch (_) {}
    }
  })();
  return true;
});

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

async function fetchHlsVariants(url) {
  try {
    const scheme = (new URL(url)).protocol;
    if (scheme !== "http:" && scheme !== "https:") return null;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > 4 * 1024 * 1024) return null;
    if (!/#EXTM3U/.test(text)) return null;
    if (!/#EXT-X-STREAM-INF/i.test(text)) return null;
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
  } catch (_) { return null; }
}

function shortName(url) {
  try { return new URL(url).hostname + new URL(url).pathname.replace(/^(.{0,40}).*$/, "$1"); }
  catch { return url.slice(0, 50); }
}
function sanitizeName(s) {
  let raw = String(s || "").split(/[\\/]/).pop();
  // Chrome reports some attachment names exactly as they appeared in the
  // signed download URL (some providers return C%2B%2B_...). Decode only
  // the filename token; malformed percent sequences remain unchanged.
  try { raw = decodeURIComponent(raw); } catch (_) {}
  return raw.replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 120);
}

// Prefer cookies that actually match the download URL. Provider-page cookies
// are only a fallback for shared parent-domain sessions (Google Drive's file
// CDN is a different host from drive.google.com). Duplicate cookie names are
// intentionally resolved in favour of the first header, which is the URL-scoped
// value returned by chrome.cookies for the active tab.
function mergeCookieHeaders(preferred, fallback) {
  const out = [];
  const seen = new Set();
  for (const header of [preferred || "", fallback || ""]) {
    for (const part of header.split(";")) {
      const item = part.trim();
      const eq = item.indexOf("=");
      if (eq <= 0) continue;
      const name = item.slice(0, eq).trim();
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(item);
    }
  }
  return out.join("; ");
}

// ---- Core handoff (data-driven provider lookup) ----------------------------
async function handoff(url, tab, referrer, filename, quality, playlist,
                       userInitiated = false, captureUrl = "") {
  const displayName = sanitizeName(filename) || filenameOf(url);
  try {
    await settingsReady;
    await stateReady;
    const cookies = await cookieHeader(url);
    const captured = captureUrl && captureUrl !== url
      ? { ...capturedHeadersFor(captureUrl, tab?.id),
          ...capturedHeadersFor(url, tab?.id) }
      : capturedHeadersFor(url, tab?.id);
    const payload = {
      type: "download",
      url,
      referrer: referrer || tab?.url || "",
      userAgent: navigator.userAgent,
      cookies,
      filename: sanitizeName(filename) || "",
      quality: quality || "",
      playlist: !!playlist,
      userInitiated: !!userInitiated,
      // "Ask before handoff" option: the app shows its confirm-before-start
      // dialog for this item instead of queueing it straight away.
      ask: !!settings.askBeforeHandoff,
      // For a recent AI attachment request this includes its transient
      // Authorization and browser metadata. IpcServer sanitises this map before
      // it reaches the network layer; normal handoffs simply send an empty map.
      headers: captured
    };

    const authDomain = authDomainFor(url);
    if (authDomain) {
      const txt = await exportCookiesAsNetscape(authDomain, url);
      if (txt) { payload.authDomain = authDomain; payload.authCookiesText = txt; }
    }

    const ci = getProviderCookieInfo(url);
    if (ci && ci.url && ci.domain) {
      const providerCookies = await cookieHeader(ci.url);
      if (providerCookies) payload.cookies = mergeCookieHeaders(payload.cookies, providerCookies);
      if (!authDomain) {
        const txt = await exportCookiesAsNetscape(ci.domain, url);
        if (txt) { payload.authDomain = ci.domain; payload.authCookiesText = txt; }
      }
    }

    const reply = await sendNative(payload);
    if (reply?.ok) {
      if (settings.notifyOnHandoff) notify(`Sent to Nexa: ${displayName}`);
      await recordRecent({ name: displayName, host: hostnameOf(url), ok: true });
    } else {
      const why = reply?.message || "could not reach the app";
      notify(`Could not send "${displayName}" to Nexa: ${why}`);
      await recordRecent({ name: displayName, host: hostnameOf(url), ok: false, message: why });
      await recordError("handoff", why);
      if (isEngineUnavailable(reply)) flashErrorBadge();
    }
    return reply;
  } catch (e) {
    const why = String(e && e.message || e);
    notify(`Could not send "${displayName}" to Nexa: ${why}`);
    await recordRecent({ name: displayName, host: hostnameOf(url), ok: false, message: why });
    await recordError("handoff", why);
    return { ok: false, message: why };
  }
}

// ---- Link grabber -----------------------------------------------------------
// Header pairs for a `links` message: the same cookie / UA / referrer context a
// single-download handoff carries, as [name, value] pairs.
async function pageHeaderPairs(pageUrl, tabId) {
  const pairs = [];
  let cookies = await cookieHeader(pageUrl);
  const ci = getProviderCookieInfo(pageUrl);
  if (ci && ci.url && ci.domain) {
    const providerCookies = await cookieHeader(ci.url);
    if (providerCookies) cookies = mergeCookieHeaders(cookies, providerCookies);
  }
  if (cookies) pairs.push(["cookie", cookies]);
  pairs.push(["user-agent", navigator.userAgent]);
  if (pageUrl) pairs.push(["referer", pageUrl]);
  for (const [name, value] of Object.entries(capturedHeadersFor(pageUrl, tabId)))
    pairs.push([name.toLowerCase(), value]);
  return pairs;
}

// mode "links": every a[href] on the page. mode "media": the sniffed tabMedia
// list (kind "media") plus the page's img/video/audio sources.
async function grabLinks(tab, mode) {
  if (!tab?.id) return { ok: false, message: "no active tab" };
  const media = mode === "media";
  await settingsReady;
  await stateReady;
  let collected = null;
  try {
    collected = await X.tabs.sendMessage(tab.id, { type: "nexa-collect-links", mode: media ? "media" : "links" });
  } catch (_) { collected = null; }
  if (!collected || typeof collected !== "object") {
    if (!/^https?:\/\//i.test(tab.url || "")) {
      const why = "Nexa can only grab links from a normal web page";
      notify(why);
      return { ok: false, message: why };
    }
    collected = { pageUrl: tab.url || "", pageTitle: tab.title || "", links: [] };
  }
  const links = Array.isArray(collected.links) ? [...collected.links] : [];
  if (media) {
    const sniffed = await getTabMedia(tab.id);
    links.unshift(...sniffed.map((m) => ({ url: m.url, text: m.type || "", kind: "media" })));
  }
  const pageUrl = collected.pageUrl || tab.url || "";
  const headers = await pageHeaderPairs(pageUrl, tab.id);
  const payload = buildLinksPayload({
    pageUrl, pageTitle: collected.pageTitle || tab.title || "", links, headers
  });
  const label = media ? "media items" : "links";
  const host = hostnameOf(pageUrl);
  if (!payload.links.length) {
    const why = media ? "No media found on this page yet. Start playing the video and try again."
                      : "No links found on this page.";
    notify(why);
    return { ok: false, message: why, count: 0 };
  }
  const reply = await sendNative(payload);
  if (reply?.ok) {
    const n = Number.isFinite(Number(reply.count)) ? Number(reply.count) : payload.links.length;
    notify(`Sent ${n} ${label} from ${host || "this page"} to Nexa`);
    await recordRecent({ name: `${n} ${label} from ${host || "page"}`, host, ok: true });
    return { ok: true, count: n };
  }
  const why = reply?.message || "could not reach the app";
  notify(`Could not send ${label} to Nexa: ${why}`);
  await recordRecent({ name: `${payload.links.length} ${label} from ${host || "page"}`, host, ok: false, message: why });
  await recordError("links", why);
  if (isEngineUnavailable(reply)) flashErrorBadge();
  return { ok: false, message: why };
}

async function pingEngine() {
  const reply = await sendNative({ type: "ping" });
  if (!reply?.ok) recordError("ping", reply?.message || "no reply");
  return reply;
}

// Ask the page to download a renderer-owned URL. The desktop process cannot
// resolve a blob:/data:/sandbox: object because it lives in the browser's
// renderer, and binary/base64 forwarding through native messaging is bounded
// and unsafe for real attachments.
async function requestBrowserDownload(tab, url, filename) {
  if (!tab?.id)
    return { ok: false, message: "The AI assistant keeps this file in the browser; open the attachment there" };
  try {
    const reply = await X.tabs.sendMessage(tab.id, {
      type: "nexa-browser-download", url, filename: sanitizeName(filename)
    });
    return reply || { ok: true, browser: true };
  } catch (_) {
    return { ok: false, message: "open the AI attachment in the browser first" };
  }
}

function sendNative(payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(HOST, payload, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({ ok: false, message: err.message || "native host unavailable", unavailable: true });
        } else {
          resolve(resp || { ok: true });
        }
      });
    } catch (e) {
      resolve({ ok: false, message: String(e && e.message || e), unavailable: true });
    }
  });
}

async function cookieHeader(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch (_) { return ""; }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function mediaType(url) {
  if (SPOTIFY_PREVIEW_RE.test(url)) return "audio";
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

// System notification (title is always "Nexa"). Falls back to the console
// where the notifications API is unavailable (unit-test sandbox).
let notifySeq = 0;
function notify(message) {
  const text = String(message || "").slice(0, 500);
  const api = X.notifications;
  if (!api || typeof api.create !== "function") {
    console.log(`[Nexa] ${text}`);
    return;
  }
  try {
    const id = `nexa-${Date.now()}-${++notifySeq}`;
    const r = api.create(id, {
      type: "basic",
      iconUrl: X.runtime.getURL("icons/icon128.png"),
      title: "Nexa",
      message: text
    });
    if (r && typeof r.catch === "function") r.catch(() => {});
  } catch (_) {
    console.log(`[Nexa] ${text}`);
  }
}
