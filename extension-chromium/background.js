// Nexa integration — service worker.
// Responsibilities:
//   1. Intercept browser downloads and hand them to the Nexa desktop app.
//   2. Capture cookies + User-Agent + referrer so authed/CDN links don't 403.
//   3. Sniff HLS/DASH/media URLs and offer them for download.
//   4. Provide right-click "Download with Nexa" menu items.

const HOST = "com.nexa.host";
const MEDIA_RE = /\.(m3u8|mpd|mp4|mkv|webm|flv|ts|mp3|m4a|aac|zip|rar|7z|iso|exe|dmg|pkg|deb|apk|pdf)(\?|$)/i;

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
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "nexa-link" && info.linkUrl) {
    await handoff(info.linkUrl, tab);
  } else if (info.menuItemId === "nexa-media" && info.srcUrl) {
    await handoff(info.srcUrl, tab);
  } else if (info.menuItemId === "nexa-page" && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "nexa-collect-links" });
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
      chrome.action.setBadgeText({ tabId: details.tabId, text: String(list.length) });
      chrome.action.setBadgeBackgroundColor({ tabId: details.tabId, color: "#3b82f6" });
    }
  },
  { urls: ["<all_urls>"] }
);

chrome.tabs.onRemoved.addListener((tabId) => tabMedia.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") {
    tabMedia.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: "" });
  }
});

const VIDEO_TYPES = new Set(["HLS", "DASH", "video", "audio"]);

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
      // Ask the desktop app (yt-dlp -J) for a site video's real qualities.
      const r = await sendNative({ type: "list-formats", url: msg.url });
      sendResponse(r);
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
