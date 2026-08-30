// Nexa toolbar popup. All app I/O goes through background.js (runtime
// messages) so the popup never talks to the native host itself.
"use strict";

(function () {
  const $ = (id) => document.getElementById(id);

  let tabId = null;
  let tabHost = "";
  let tabUrl = "";
  let toastTimer = null;

  // ---- tiny promise wrappers (callback style works in Chromium and Firefox) --
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          const err = chrome.runtime.lastError;
          if (err) resolve({ ok: false, message: err.message || "no reply from the extension" });
          else resolve(r || { ok: false, message: "no reply from the extension" });
        });
      } catch (e) { resolve({ ok: false, message: String(e) }); }
    });
  }
  function storageGet(defaults) {
    return new Promise((resolve) => {
      try { chrome.storage.local.get(defaults, (v) => { void chrome.runtime.lastError; resolve(v || defaults); }); }
      catch (_) { resolve(defaults); }
    });
  }
  function storageSet(obj) {
    return new Promise((resolve) => {
      try { chrome.storage.local.set(obj, () => { void chrome.runtime.lastError; resolve(); }); }
      catch (_) { resolve(); }
    });
  }
  function activeTab() {
    return new Promise((resolve) => {
      try { chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => { void chrome.runtime.lastError; resolve((tabs && tabs[0]) || null); }); }
      catch (_) { resolve(null); }
    });
  }

  // ---- helpers -------------------------------------------------------------
  function hostnameOf(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ""; }
  }
  function normalizeHost(entry) {
    let s = String(entry || "").trim().toLowerCase();
    if (!s) return "";
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) { try { s = new URL(s).hostname; } catch (_) { return ""; } }
    else s = s.split(/[/?#]/)[0];
    s = s.replace(/^\*?\.+/, "").replace(/\.+$/, "").replace(/:\d+$/, "");
    return /^[a-z0-9.-]+$/.test(s) ? s : "";
  }
  function hostMatches(host, entry) {
    const d = normalizeHost(entry);
    return !!d && (host === d || host.endsWith("." + d));
  }
  function capitalize(s) { s = String(s || ""); return s ? s[0].toUpperCase() + s.slice(1) : ""; }
  function relTime(ts) {
    const d = Math.max(0, Date.now() - Number(ts || 0));
    const m = Math.round(d / 60000);
    if (m < 1) return "now";
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.round(h / 24)}d`;
  }

  function toast(text, kind) {
    const el = $("toast");
    el.textContent = text;
    el.className = "toast" + (kind ? " " + kind : "");
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  // ---- status row ----------------------------------------------------------
  function setStatus(state, text) {
    const box = $("status");
    box.className = "status status-" + state;
    $("status-text").textContent = text;
    const bad = state === "bad";
    $("get-nexa").hidden = !bad;
    $("btn-retry").hidden = !bad;
  }
  async function ping() {
    setStatus("wait", "Connecting to Nexa…");
    $("btn-retry").disabled = true;
    const r = await send({ type: "nexa-ping", tabId });
    $("btn-retry").disabled = false;
    if (r && r.ok) {
      const parts = ["Connected"];
      if (r.version) parts.push("v" + String(r.version));
      if (r.plan) parts.push(capitalize(r.plan));
      let text = parts.join(" · ");
      const active = Number(r.active) || 0;
      const queued = Number(r.queued) || 0;
      if (active || queued) text += ` · ${active} active, ${queued} queued`;
      setStatus("ok", text);
    } else {
      setStatus("bad", "Nexa not running / not installed");
    }
  }

  // ---- toggles ---------------------------------------------------------------
  async function loadToggles() {
    const v = await storageGet({ enabled: true, disabledHosts: [] });
    $("tgl-enabled").checked = v.enabled !== false;
    const list = Array.isArray(v.disabledHosts) ? v.disabledHosts : [];
    const pauseRow = $("tgl-pause").closest(".row");
    if (tabHost) {
      $("site-host").textContent = tabHost;
      $("tgl-pause").disabled = false;
      $("tgl-pause").checked = list.some((d) => hostMatches(tabHost, d));
      pauseRow.classList.remove("disabled");
    } else {
      $("site-host").textContent = "(not a web page)";
      $("tgl-pause").disabled = true;
      $("tgl-pause").checked = false;
      pauseRow.classList.add("disabled");
    }
  }
  $("tgl-enabled").addEventListener("change", async (e) => {
    await storageSet({ enabled: !!e.target.checked });
    toast(e.target.checked ? "Nexa will take over downloads" : "Downloads stay in the browser", "ok");
  });
  $("tgl-pause").addEventListener("change", async (e) => {
    if (!tabHost) return;
    const v = await storageGet({ disabledHosts: [] });
    let list = Array.isArray(v.disabledHosts) ? v.disabledHosts.slice() : [];
    if (e.target.checked) {
      if (!list.some((d) => normalizeHost(d) === tabHost)) list.push(tabHost);
    } else {
      // Remove every entry that pauses this host (exact or a parent domain).
      list = list.filter((d) => !hostMatches(tabHost, d));
    }
    await storageSet({ disabledHosts: list });
    toast(e.target.checked ? `Paused on ${tabHost}` : `Resumed on ${tabHost}`, "ok");
  });

  // ---- actions -----------------------------------------------------------------
  async function runAction(button, msg, busyText) {
    const original = button.firstChild && button.firstChild.nodeType === 3 ? button.firstChild.textContent : "";
    button.disabled = true;
    if (busyText && button.firstChild && button.firstChild.nodeType === 3) button.firstChild.textContent = busyText;
    const r = await send(Object.assign({ tabId }, msg));
    button.disabled = false;
    if (original && button.firstChild && button.firstChild.nodeType === 3) button.firstChild.textContent = original;
    return r;
  }
  $("btn-links").addEventListener("click", async () => {
    const r = await runAction($("btn-links"), { type: "nexa-grab-links" }, "Sending links… ");
    if (r && r.ok) toast(`Sent ${r.count} links to Nexa`, "ok");
    else toast(r && r.message ? r.message : "Could not send links", "bad");
    loadRecent();
  });
  $("btn-media").addEventListener("click", async () => {
    const r = await runAction($("btn-media"), { type: "nexa-grab-media" }, "Sending media… ");
    if (r && r.ok) toast(`Sent ${r.count} media items to Nexa`, "ok");
    else toast(r && r.message ? r.message : "Could not send media", "bad");
    loadRecent();
  });
  $("btn-open").addEventListener("click", async () => {
    const r = await runAction($("btn-open"), { type: "nexa-show" }, "Opening…");
    if (r && r.ok) window.close();
    else { toast(r && r.message ? r.message : "Nexa is not running", "bad"); setStatus("bad", "Nexa not running / not installed"); }
  });
  function openOptions() {
    try { chrome.runtime.openOptionsPage(); } catch (_) { window.open(chrome.runtime.getURL("options.html")); }
  }
  $("btn-options").addEventListener("click", openOptions);
  $("btn-options-icon").addEventListener("click", openOptions);
  $("btn-retry").addEventListener("click", ping);

  async function loadMediaCount() {
    const list = await send({ type: "nexa-get-media", tabId });
    const n = Array.isArray(list) ? list.length : 0;
    const el = $("media-count");
    el.textContent = String(n);
    el.hidden = n === 0;
  }

  // ---- recent handoffs -------------------------------------------------------
  async function loadRecent() {
    const v = await storageGet({ recent: [] });
    const list = Array.isArray(v.recent) ? v.recent.slice(0, 8) : [];
    const ul = $("recent-list");
    ul.replaceChildren();
    $("recent-empty").hidden = list.length > 0;
    for (const item of list) {
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "r-dot" + (item.ok ? "" : " bad");
      dot.title = item.ok ? "Sent" : ("Failed" + (item.message ? ": " + item.message : ""));
      const body = document.createElement("div");
      body.style.minWidth = "0";
      const name = document.createElement("div");
      name.className = "r-name";
      name.textContent = item.name || "(unnamed)";
      name.title = item.ok ? (item.name || "") : (item.message || "failed");
      const host = document.createElement("div");
      host.className = "r-host";
      host.textContent = (item.ok ? "" : "failed · ") + (item.host || "");
      body.append(name, host);
      const time = document.createElement("span");
      time.className = "r-time";
      time.textContent = relTime(item.time);
      li.append(dot, body, time);
      ul.appendChild(li);
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.recent) loadRecent();
    if (changes.enabled || changes.disabledHosts) loadToggles();
  });

  // ---- init ------------------------------------------------------------------
  (async () => {
    try { $("version").textContent = "v" + chrome.runtime.getManifest().version; } catch (_) {}
    const tab = await activeTab();
    if (tab) {
      tabId = tab.id;
      tabUrl = tab.url || "";
      tabHost = /^https?:\/\//i.test(tabUrl) ? hostnameOf(tabUrl) : "";
    }
    await loadToggles();
    loadRecent();
    loadMediaCount();
    ping();
  })();
})();
