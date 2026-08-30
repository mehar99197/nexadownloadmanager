// Nexa options page. Settings live in storage.local; background.js watches
// storage.onChanged so a save takes effect immediately. Defaults come from
// the background (single source of truth: SETTINGS_DEFAULTS in background.js).
"use strict";

(function () {
  const $ = (id) => document.getElementById(id);
  const INTERCEPT_ALL = "*";
  const SETTING_KEYS = ["enabled", "minSizeMB", "interceptTypes", "disabledHosts",
                        "askBeforeHandoff", "showFloatingButton", "notifyOnHandoff"];
  let defaults = null;
  let lastTypeList = [];     // remembered while "All file types" is on
  let toastTimer = null;

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          const err = chrome.runtime.lastError;
          resolve(err ? { ok: false, message: err.message } : (r || { ok: false }));
        });
      } catch (e) { resolve({ ok: false, message: String(e) }); }
    });
  }
  function storageGet(keys) {
    return new Promise((resolve) => {
      try { chrome.storage.local.get(keys, (v) => { void chrome.runtime.lastError; resolve(v || {}); }); }
      catch (_) { resolve({}); }
    });
  }
  function storageSet(obj) {
    return new Promise((resolve) => {
      try { chrome.storage.local.set(obj, () => { void chrome.runtime.lastError; resolve(); }); }
      catch (_) { resolve(); }
    });
  }

  function toast(text, kind) {
    const el = $("toast");
    el.textContent = text;
    el.className = "toast" + (kind ? " " + kind : "");
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
  }

  function parseList(text, isHost) {
    const parts = String(text || "").split(/[\s,;]+/);
    const out = [];
    for (let p of parts) {
      p = p.trim().toLowerCase();
      if (!p) continue;
      if (!isHost) {
        if (p === "all" || p === INTERCEPT_ALL) { p = INTERCEPT_ALL; }
        else {
          p = p.replace(/^\.+/, "");
          if (!/^[a-z0-9]{1,12}$/.test(p)) continue;
        }
      } else {
        if (/^[a-z][a-z0-9+.-]*:\/\//.test(p)) { try { p = new URL(p).hostname; } catch (_) { continue; } }
        else p = p.split(/[/?#]/)[0];
        p = p.replace(/^\*?\.+/, "").replace(/\.+$/, "").replace(/:\d+$/, "");
        if (!/^[a-z0-9.-]+$/.test(p)) continue;
      }
      if (!out.includes(p)) out.push(p);
    }
    return out;
  }

  function render(s) {
    $("enabled").checked = s.enabled !== false;
    $("askBeforeHandoff").checked = s.askBeforeHandoff === true;
    $("notifyOnHandoff").checked = s.notifyOnHandoff !== false;
    $("showFloatingButton").checked = s.showFloatingButton !== false;
    $("minSizeMB").value = String(Number(s.minSizeMB) > 0 ? Number(s.minSizeMB) : 0);
    const types = Array.isArray(s.interceptTypes) ? s.interceptTypes : defaults.interceptTypes;
    const all = types.includes(INTERCEPT_ALL);
    lastTypeList = all ? (lastTypeList.length ? lastTypeList : defaults.interceptTypes.slice()) : types.slice();
    $("interceptAll").checked = all;
    $("interceptTypes").value = (all ? lastTypeList : types).join(" ");
    $("interceptTypes").disabled = all;
    $("disabledHosts").value = (Array.isArray(s.disabledHosts) ? s.disabledHosts : []).join("\n");
  }

  function collect() {
    const min = Number($("minSizeMB").value);
    const all = $("interceptAll").checked;
    const typed = parseList($("interceptTypes").value, false).filter((t) => t !== INTERCEPT_ALL);
    return {
      enabled: $("enabled").checked,
      askBeforeHandoff: $("askBeforeHandoff").checked,
      notifyOnHandoff: $("notifyOnHandoff").checked,
      showFloatingButton: $("showFloatingButton").checked,
      minSizeMB: Number.isFinite(min) && min > 0 ? min : 0,
      interceptTypes: all ? [INTERCEPT_ALL] : typed,
      disabledHosts: parseList($("disabledHosts").value, true)
    };
  }

  $("interceptAll").addEventListener("change", (e) => {
    const box = $("interceptTypes");
    if (e.target.checked) {
      lastTypeList = parseList(box.value, false).filter((t) => t !== INTERCEPT_ALL);
      box.disabled = true;
    } else {
      box.disabled = false;
      if (!parseList(box.value, false).length)
        box.value = (lastTypeList.length ? lastTypeList : defaults.interceptTypes).join(" ");
      box.focus();
    }
  });

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const s = collect();
    await storageSet(s);
    render(s);
    toast("Settings saved", "ok");
  });

  $("btn-reset").addEventListener("click", async () => {
    if (!defaults) return;
    const s = JSON.parse(JSON.stringify(defaults));
    lastTypeList = [];
    await storageSet(s);
    render(s);
    toast("Defaults restored", "ok");
  });

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}
    try {
      const ta = $("diag-text");
      ta.value = text;
      $("diag-box").hidden = false;
      $("diag-box").open = true;
      ta.focus();
      ta.select();
      return document.execCommand("copy");
    } catch (_) { return false; }
  }

  $("btn-diag").addEventListener("click", async () => {
    const all = await storageGet(null);
    const manifest = chrome.runtime.getManifest();
    const settings = {};
    for (const k of SETTING_KEYS) settings[k] = k in all ? all[k] : (defaults ? defaults[k] : undefined);
    const diag = {
      exportedAt: new Date().toISOString(),
      extension: {
        name: manifest.name, version: manifest.version,
        manifestVersion: manifest.manifest_version, id: chrome.runtime.id
      },
      browser: navigator.userAgent,
      platform: navigator.platform || "",
      settings,
      lastErrors: Array.isArray(all.lastErrors) ? all.lastErrors : [],
      recent: Array.isArray(all.recent) ? all.recent : []
    };
    const text = JSON.stringify(diag, null, 2);
    $("diag-text").value = text;
    $("diag-box").hidden = false;
    const ok = await copyText(text);
    toast(ok ? "Diagnostics copied to the clipboard" : "Copy failed — the JSON is shown below", ok ? "ok" : "bad");
  });

  (async () => {
    try { $("version").textContent = "· v" + chrome.runtime.getManifest().version; } catch (_) {}
    const r = await send({ type: "nexa-get-defaults" });
    if (!r || !r.ok || !r.defaults) {
      $("load-error").hidden = false;
      for (const el of $("form").querySelectorAll("input, textarea, button")) el.disabled = true;
      return;
    }
    defaults = r.defaults;
    const stored = await storageGet(defaults);
    render(stored);
  })();
})();
