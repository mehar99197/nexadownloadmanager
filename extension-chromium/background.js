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

// ---- Messages from popup / content scripts -------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "nexa-download") {
      const r = await handoff(msg.url, sender.tab || (await activeTab()));
      sendResponse(r);
    } else if (msg.type === "nexa-get-media") {
      const tab = await activeTab();
      sendResponse(tabMedia.get(tab?.id) || []);
    } else if (msg.type === "nexa-download-list") {
      const tab = sender.tab || (await activeTab());
      const results = [];
      for (const u of msg.urls) results.push(await handoff(u, tab));
      sendResponse(results);
    }
  })();
  return true; // keep the channel open for the async response
});

// ---- Core handoff --------------------------------------------------------
async function handoff(url, tab, referrer, filename) {
  try {
    const cookies = await cookieHeader(url);
    const payload = {
      type: "download",
      url,
      referrer: referrer || tab?.url || "",
      userAgent: navigator.userAgent,
      cookies,
      filename: filename || "",
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
  if (/\.m3u8/i.test(url)) return "HLS";
  if (/\.mpd/i.test(url)) return "DASH";
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
