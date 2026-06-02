// Nexa integration — service worker.
// Responsibilities:
//   1. Intercept browser downloads and hand them to the Nexa desktop app.
//   2. Capture cookies + User-Agent + referrer so authed/CDN links don't 403.
//   3. Sniff HLS/DASH/media URLs and offer them for download.
//   4. Provide right-click "Download with Nexa" menu items.

const HOST = "com.nexa.host";
const MEDIA_RE = /\.(m3u8|mpd|mp4|mkv|webm|flv|ts|mp3|m4a|aac|zip|rar|7z|iso|exe|dmg|pkg|deb|apk|pdf)(\?|$)/i;

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

// Export all cookies of `authDomain` (incl. subdomains) as Netscape cookies.txt
// TEXT, the exact 7-tab format Nexa's CookieFile parser requires. The extension
// can't write a file (MV3 sandbox), so we send the text and the engine writes it.
async function exportCookiesAsNetscape(authDomain) {
  let cookies = [];
  try { cookies = await X.cookies.getAll({ domain: authDomain }); }
  catch { return ""; }
  const lines = ["# Netscape HTTP Cookie File", "# Exported by Nexa"];
  for (const c of cookies) {
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
  }
  return lines.join("\n") + "\n";
}

// Per-tab detected media stream URLs (for the floating download button).
const tabMedia = new Map();

let integrationEnabled = true;
chrome.storage.local.get({ enabled: true }, (v) => (integrationEnabled = v.enabled));
chrome.storage.onChanged.addListener((c) => {
  if (c.enabled) integrationEnabled = c.enabled.newValue;
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

  try {
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
  } catch (_) { /* already gone */ }

  const tab = await activeTab();
  await handoff(item.url, tab, item.referrer, item.filename);
});

// ---- Media sniffing ------------------------------------------------------
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (!MEDIA_RE.test(details.url)) return;
    const list = tabMedia.get(details.tabId) || [];
    if (!list.some((m) => m.url === details.url)) {
      list.push({ url: details.url, type: mediaType(details.url) });
      tabMedia.set(details.tabId, list);
      // (No icon badge — the user asked not to show a count on the extension icon.)
    }
  },
  { urls: ["<all_urls>"] }
);

chrome.tabs.onRemoved.addListener((tabId) => tabMedia.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading")
    tabMedia.delete(tabId);
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
  (async () => {
    const tab = sender.tab || (await activeTab());
    if (msg.type === "nexa-download") {
      const r = await handoff(msg.url, tab, tab?.url, msg.filename, msg.quality, msg.playlist);
      sendResponse(r);
    } else if (msg.type === "nexa-media-count") {
      // Count only video/stream media for the floating pill.
      const list = (tabMedia.get(tab?.id) || []).filter((m) => VIDEO_TYPES.has(m.type));
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
      sendResponse(tabMedia.get(tab?.id) || []);   // legacy (popup.js)
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
  const list = (tabMedia.get(tab?.id) || []).filter((m) => VIDEO_TYPES.has(m.type));
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
    const res = await fetch(url, { credentials: "include" });
    const text = await res.text();
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
