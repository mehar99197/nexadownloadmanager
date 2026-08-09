// Nexa integration — service worker.
// Responsibilities:
//   1. Intercept browser downloads and hand them to the Nexa desktop app.
//   2. Capture cookies + User-Agent + referrer so authed/CDN links don't 403.
//   3. Sniff HLS/DASH/media URLs and offer them for download.
//   4. Provide right-click "Download with Nexa" menu items.
//
// PROVIDER_CONFIG is the SINGLE source of truth for all host matching and
// cookie-forwarding rules. Everything below is derived from it.

const HOST = "com.nexa.host";
const MEDIA_RE = /\.(m3u8|mpd|mp4|mkv|webm|flv|ts|mp3|m4a|aac|zip|rar|7z|iso|exe|dmg|pkg|deb|apk|pdf)(\?|$)/i;
const SPOTIFY_PREVIEW_RE = /\/\/p\.scdn\.co\/mp3-preview\//i;

const X = (typeof browser !== "undefined") ? browser : chrome;

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
    // AI attachment endpoints can require a short-lived Authorization header
    // that is not available through the cookies API.
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
// Firefox does not expose an AI assistant's transient Authorization header through the
// cookie API. Keep the real browser request headers briefly so the native
// downloader can replay the authenticated attachment request.
const CAPTURED_HEADER_TTL_MS = 2 * 60 * 1000;
const MAX_CAPTURED_REQUESTS = 64;
const MAX_CAPTURED_HEADER_VALUE_BYTES = 16 * 1024;
const MAX_CAPTURED_HEADER_BYTES = 64 * 1024;
const CAPTURED_HEADER_DENYLIST = new Set([
  "host", "content-length", "transfer-encoding", "connection", "proxy-authorization"
]);
const capturedRequests = new Map();

function requestUrlKey(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
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

function cacheRequestHeaders(details) {
  if (details.incognito || !shouldCaptureRequestHeaders(details.url)) return;
  const urlKey = requestUrlKey(details.url);
  if (!urlKey) return;

  const headers = Object.create(null);
  let totalBytes = 0;
  for (const header of (details.requestHeaders || [])) {
    const name = String(header.name || "").trim();
    const value = typeof header.value === "string" ? header.value : "";
    const lowerName = name.toLowerCase();
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
  capturedRequests.delete(key);
  capturedRequests.set(key, { tabId, urlKey, headers, capturedAt: now });
  evictExpiredCapturedRequests(now);
}

function capturedHeadersFor(url, tabId) {
  const urlKey = requestUrlKey(url);
  if (!urlKey) return {};
  const now = Date.now();
  evictExpiredCapturedRequests(now);

  let match = Number.isInteger(tabId)
    ? capturedRequests.get(captureKey(tabId, urlKey))
    : null;
  if (!match) {
    for (const entry of capturedRequests.values()) {
      if (entry.urlKey === urlKey
          && (!match || entry.capturedAt > match.capturedAt)) match = entry;
    }
  }
  return match ? { ...match.headers } : {};
}

X.webRequest.onBeforeSendHeaders.addListener(
  cacheRequestHeaders,
  { urls: ["<all_urls>"] },
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

let integrationEnabled = true;
chrome.storage.local.get({ enabled: true }, (v) => (integrationEnabled = v.enabled));
chrome.storage.onChanged.addListener((c, area) => {
  if (area === "local" && c.enabled) integrationEnabled = c.enabled.newValue;
});

// ---- Context menus ---------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "nexa-link",  title: "Download with Nexa",        contexts: ["link"] });
  chrome.contextMenus.create({ id: "nexa-media", title: "Download video/audio with Nexa", contexts: ["video", "audio", "image"] });
  chrome.contextMenus.create({ id: "nexa-page",  title: "Download all links on page",  contexts: ["page"] });
  chrome.contextMenus.create({ id: "nexa-course", title: "Download whole course with Nexa", contexts: ["page", "link"] });
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
    chrome.tabs.sendMessage(tab.id, { type: "nexa-collect-links" });
  } else if (info.menuItemId === "nexa-course") {
    const target = info.linkUrl || tab?.url;
    if (target) await handoff(target, tab, tab?.url, "", "", true, true);
  }
});

// ---- Download interception -------------------------------------------------
chrome.downloads.onCreated.addListener(async (item) => {
  if (!integrationEnabled) return;
  const originalUrl = item.url || "";
  const targetUrl = item.finalUrl || originalUrl;
  if (!targetUrl || isBrowserOwnedDownloadUrl(originalUrl)
      || isBrowserOwnedDownloadUrl(targetUrl)) return;
  if (letBrowserHandle(targetUrl)) return;
  try {
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
  } catch (_) {}
  // The browser has already accepted this as a download action. Starting it
  // immediately avoids a second hidden confirmation when the native host
  // auto-starts Nexa in the background.
  await handoff(targetUrl, null, item.referrer, item.filename, "", false, true, originalUrl);
});

// ---- Media sniffing --------------------------------------------------------
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (!MEDIA_RE.test(details.url) && !SPOTIFY_PREVIEW_RE.test(details.url)) return;
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
    if (details.tabId < 0) return;
    const ct = ctOf(details.responseHeaders);
    if (!ct) return;
    let type = "";
    if (/(application|audio|video)\/(x-mpegurl|vnd\.apple\.mpegurl|mpegurl)/.test(ct)) type = "HLS";
    else if (/application\/dash\+xml/.test(ct)) type = "DASH";
    else if (/^audio\//.test(ct)) type = "audio";
    else if (/^video\//.test(ct)) type = "video";
    else return;
    if ((type === "audio" || type === "video") && SEGMENT_RE.test(details.url)) return;
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

// ---- quality-probe cache ---------------------------------------------------
const FMT_CACHE_TTL = 5 * 60 * 1000;
const FMT_CACHE_MAX = 32;
const fmtCache = new Map();
const fmtInflight = new Map();

async function listFormatsCached(url) {
  const hit = fmtCache.get(url);
  if (hit && (Date.now() - hit.ts) < FMT_CACHE_TTL) return hit.result;
  if (fmtInflight.has(url)) return fmtInflight.get(url);
  const p = (async () => {
    const r = await sendNative({ type: "list-formats", url });
    if (r && r.ok) {
      fmtCache.set(url, { result: r, ts: Date.now() });
      if (fmtCache.size > FMT_CACHE_MAX)
        fmtCache.delete(fmtCache.keys().next().value);
    }
    fmtInflight.delete(url);
    return r;
  })();
  fmtInflight.set(url, p);
  return p;
}

// ---- Messages ---------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) return;
  (async () => {
    const tab = sender.tab || (await activeTab());
    if (msg.type === "nexa-download") {
      const r = isBrowserOwnedDownloadUrl(msg.url)
        ? await requestBrowserDownload(tab, msg.url, msg.filename)
        : await handoff(msg.url, tab, tab?.url, msg.filename, msg.quality,
                        msg.playlist, true);
      sendResponse(r);
    } else if (msg.type === "nexa-media-count") {
      const list = (await getTabMedia(tab?.id)).filter((m) => VIDEO_TYPES.has(m.type));
      sendResponse({ count: list.length, signature: list.map((m) => m.url).join("|") });
    } else if (msg.type === "nexa-list-formats") {
      sendResponse(await listFormatsCached(msg.url));
    } else if (msg.type === "nexa-prefetch-formats") {
      listFormatsCached(msg.url);
      sendResponse({ ok: true, prefetching: true });
    } else if (msg.type === "nexa-get-qualities") {
      sendResponse(await buildQualities(tab));
    } else if (msg.type === "nexa-get-media") {
      sendResponse(await getTabMedia(tab?.id));
    } else if (msg.type === "nexa-download-list") {
      const results = [];
      for (const u of msg.urls) {
        results.push(isBrowserOwnedDownloadUrl(u)
          ? await requestBrowserDownload(tab, u, "")
          : await handoff(u, tab, "", "", "", false, true));
      }
      sendResponse(results);
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
  try { raw = decodeURIComponent(raw); } catch (_) {}
  return raw
    .replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 120);
}

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
  try {
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
    if (reply?.ok) notify("Sent to Nexa", filenameOf(url));
    else notify("Nexa error", reply?.message || "could not reach the app");
    return reply;
  } catch (e) {
    notify("Nexa error", String(e));
    return { ok: false, message: String(e) };
  }
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
    chrome.runtime.sendNativeMessage(HOST, payload, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, message: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: true });
      }
    });
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

function notify(title, message) {
  console.log(`[Nexa] ${title}: ${message}`);
}
