// Nexa content script — IDM-style "Download this video" experience.
//
// When the background worker reports media on this tab, a floating pill appears.
// Clicking it opens a panel listing each video and its available qualities
// (parsed from the HLS master playlist in the background). Clicking a quality
// hands that exact stream to the Nexa desktop app.
//
// All UI is built with DOM APIs (createElement/textContent) rather than
// innerHTML. YouTube enforces a `require-trusted-types-for 'script'` CSP, and
// assigning to .innerHTML throws there — which previously aborted UI creation
// so the pill never appeared. DOM construction is Trusted-Types-safe.

(function () {
  "use strict";
  if (window.top !== window) return;        // top frame only

  let pill = null;
  let panel = null;
  let badge = null;
  let lastSignature = "";
  let lastHref = location.href;

  // ---- site-video (YouTube etc.) detection -----------------------------
  function isSiteVideo() {
    const h = location.host;
    if (/(^|\.)youtube\.com$/.test(h))
      return location.pathname === "/watch" || location.pathname.startsWith("/shorts/");
    return /(^|\.)youtu\.be$/.test(h) && location.pathname.length > 1;
  }
  function siteTitle() {
    return (document.title || "video")
      .replace(/\s*-\s*YouTube\s*$/i, "")   // trailing " - YouTube"
      .replace(/^\(\d+\)\s*/, "")            // leading "(7) " notification count
      .trim();
  }

  // ---- playlist detection (YouTube) ------------------------------------
  // A `list=` param means the watch/playlist page belongs to a playlist. RD* ids
  // are auto-generated mixes/radios (dynamic, not a fixed downloadable list) — skip.
  function playlistId() {
    const id = new URLSearchParams(location.search || "").get("list") || "";
    return id && !/^RD/.test(id) ? id : "";
  }
  function isPlaylistPage() {
    return /(^|\.)youtube\.com$/.test(location.host) &&
           location.pathname === "/playlist" && !!playlistId();
  }
  function showPill() { return isSiteVideo() || isPlaylistPage(); }
  function playlistTitle() {
    const el = document.querySelector(
      "ytd-playlist-panel-renderer #header-description #title, " +
      "ytd-playlist-panel-renderer .title.ytd-playlist-panel-renderer, " +
      "ytd-playlist-header-renderer yt-dynamic-sizing-formatted-string, " +
      "h1.ytd-playlist-header-renderer, .ytp-playlist-menu-title");
    const t = el && (el.textContent || el.getAttribute("title"));
    return (t || "YouTube Playlist").trim();
  }
  function playlistCount() {
    // The playlist panel shows "3 / 13"; pull the total. Best-effort (0 = unknown).
    const el = document.querySelector(
      "ytd-playlist-panel-renderer #index-message, " +
      "ytd-playlist-panel-renderer .index-message");
    const m = el && /\/\s*([\d,]+)/.exec(el.textContent || "");
    if (m) return parseInt(m[1].replace(/,/g, ""), 10) || 0;
    // Fallback: count rendered playlist entries.
    const n = document.querySelectorAll("ytd-playlist-panel-video-renderer").length;
    return n || 0;
  }
  function playlistGroup() {
    const id = playlistId();
    const count = playlistCount();
    return {
      title: count ? `Entire playlist — ${count} videos` : "Entire playlist",
      name: playlistTitle(),
      playlist: true,
      playlistUrl: "https://www.youtube.com/playlist?list=" + id,
      qualities: YT_QUALITIES.map((q) => ({ label: q.label, quality: q.quality, meta: q.meta }))
    };
  }
  const YT_QUALITIES = [
    { label: "Best available", quality: "best", meta: "video + audio" },
    { label: "1080p", quality: "1080", meta: "video + audio" },
    { label: "720p", quality: "720", meta: "video + audio" },
    { label: "480p", quality: "480", meta: "video + audio" },
    { label: "360p", quality: "360", meta: "video + audio" },
    { label: "Audio only (m4a)", quality: "audio", meta: "" }
  ];

  // ---- styling (injected once) -----------------------------------------
  const css = `
    #nexa-pill{position:fixed;right:20px;bottom:20px;z-index:2147483647;
      display:none;align-items:center;gap:8px;cursor:pointer;
      background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;
      font:600 13px/1 system-ui,sans-serif;padding:11px 14px;border-radius:24px;
      box-shadow:0 8px 24px rgba(37,99,235,.45);user-select:none;transition:transform .12s}
    #nexa-pill:hover{transform:translateY(-2px)}
    #nexa-pill .nx-badge{background:#fff;color:#2563eb;border-radius:999px;
      font-size:11px;font-weight:700;padding:1px 7px;margin-left:2px}
    #nexa-panel{position:fixed;right:20px;bottom:74px;z-index:2147483647;display:none;
      width:320px;max-height:60vh;overflow:auto;background:#0f172a;color:#e2e8f0;
      border:1px solid #1e293b;border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.5);
      font:13px/1.45 system-ui,sans-serif}
    #nexa-panel .nx-head{display:flex;align-items:center;justify-content:space-between;
      padding:12px 14px;background:#1e293b;border-radius:14px 14px 0 0;font-weight:600}
    #nexa-panel .nx-close{cursor:pointer;color:#94a3b8;font-size:16px;line-height:1}
    #nexa-panel .nx-media{padding:8px 14px;border-top:1px solid #1e293b}
    #nexa-panel .nx-title{color:#94a3b8;font-size:11px;text-transform:uppercase;
      letter-spacing:.04em;margin:4px 0 8px;word-break:break-all}
    #nexa-panel .nx-q{display:flex;align-items:center;justify-content:space-between;
      gap:8px;padding:9px 10px;margin:5px 0;background:#1e293b;border-radius:9px;
      cursor:pointer;transition:background .1s}
    #nexa-panel .nx-q:hover{background:#2b3b55}
    #nexa-panel .nx-q .nx-meta{color:#94a3b8;font-size:11px}
    #nexa-panel .nx-q .nx-dl{background:#3b82f6;color:#fff;border-radius:6px;
      padding:3px 9px;font-size:11px;font-weight:700}
    #nexa-panel .nx-empty{padding:14px;color:#94a3b8}
    #nexa-toast{position:fixed;right:20px;bottom:74px;z-index:2147483647;display:none;
      background:#22c55e;color:#06210f;font:600 13px/1 system-ui,sans-serif;
      padding:10px 14px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.4)}
  `;

  function injectStyleOnce() {
    if (document.getElementById("nexa-style")) return;
    const style = document.createElement("style");
    style.id = "nexa-style";
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  // Small DOM helper: el("div", {class, text, ...attrs}, [children])
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null) continue;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k === "data") { for (const d in v) node.dataset[d] = v[d]; }
        else node.setAttribute(k, v);
      }
    }
    if (children) for (const c of children) if (c) node.appendChild(c);
    return node;
  }

  function ensureUi() {
    injectStyleOnce();
    if (pill && pill.isConnected && panel && panel.isConnected) return;

    if (!pill || !pill.isConnected) {
      pill = el("div", { id: "nexa-pill" }, [
        document.createTextNode("⬇ "),
        el("span", { text: "Download Video" }),
        (badge = el("span", { class: "nx-badge", text: "0" }))
      ]);
      pill.addEventListener("click", togglePanel);
      document.documentElement.appendChild(pill);
    }
    if (!panel || !panel.isConnected) {
      panel = el("div", { id: "nexa-panel" });
      document.documentElement.appendChild(panel);
    }
  }

  function toast(msg) {
    let t = document.getElementById("nexa-toast");
    if (!t) {
      t = el("div", { id: "nexa-toast" });
      document.documentElement.appendChild(t);
    }
    t.textContent = msg;
    t.style.display = "block";
    setTimeout(() => { t.style.display = "none"; }, 2200);
  }

  function togglePanel() {
    if (!panel) return;
    if (panel.style.display === "block") { panel.style.display = "none"; return; }
    panel.style.display = "block";

    // Dedicated playlist page (/playlist?list=…): only the playlist option.
    if (!isSiteVideo() && isPlaylistPage()) {
      renderPanel([playlistGroup()]);
      return;
    }

    if (isSiteVideo()) {
      const hasPlaylist = !!playlistId();
      // Build groups: [this video] (+ [entire playlist] when the video is in one).
      const withPlaylist = (videoGroup) =>
        hasPlaylist ? [videoGroup, playlistGroup()] : [videoGroup];

      // YouTube & co: ask the engine (yt-dlp -J) for this video's REAL qualities.
      renderPanel(withPlaylist({ title: siteTitle(), qualities: [{ label: "Loading qualities…" }] }));
      chrome.runtime.sendMessage({ type: "nexa-list-formats", url: location.href }, (r) => {
        let quals;
        if (!chrome.runtime.lastError && r && r.ok && Array.isArray(r.qualities) && r.qualities.length) {
          // Every quality is delivered as video+audio (yt-dlp merges).
          quals = [{ label: "Best available", quality: "best", meta: "video + audio" }];
          for (const q of r.qualities)
            quals.push({ label: q.label, quality: String(q.height), meta: "video + audio" });
          quals.push({ label: "Audio only (m4a)", quality: "audio", meta: "" });
        } else {
          quals = YT_QUALITIES.map((q) => ({ label: q.label, quality: q.quality, meta: q.meta }));
        }
        renderPanel(withPlaylist({ title: siteTitle(), name: siteTitle(), site: true, qualities: quals }));
      });
      return;
    }
    renderPanel([{ title: "Loading qualities…", qualities: [] }]);
    chrome.runtime.sendMessage({ type: "nexa-get-qualities" }, (groups) => {
      if (chrome.runtime.lastError) { renderPanel([]); return; }
      renderPanel(groups || []);
    });
  }

  function renderPanel(groups) {
    const close = el("span", { class: "nx-close", title: "Close", text: "✕" });
    close.addEventListener("click", () => { panel.style.display = "none"; });
    const head = el("div", { class: "nx-head" }, [
      el("span", { text: "⬇ Download with Nexa" }),
      close
    ]);

    const frag = document.createDocumentFragment();
    frag.appendChild(head);

    if (!groups.length) {
      frag.appendChild(el("div", {
        class: "nx-empty",
        text: "No downloadable video found on this page yet. Start playing the video and try again."
      }));
    }

    groups.forEach((g) => {
      const media = el("div", { class: "nx-media" }, [
        el("div", { class: "nx-title", text: g.title || "Video" })
      ]);
      if (!g.qualities.length) {
        media.appendChild(el("div", { class: "nx-meta", text: "…" }));
      }
      g.qualities.forEach((q) => {
        const row = el("div", {
          class: "nx-q",
          data: { url: q.url || "", quality: q.quality || "", name: g.name || "",
                  plurl: g.playlist ? (g.playlistUrl || "") : "" }
        }, [
          el("span", { text: q.label }),
          el("span", { style: "display:flex;gap:8px;align-items:center" }, [
            el("span", { class: "nx-meta", text: q.meta || "" }),
            el("span", { class: "nx-dl", text: g.playlist ? "Download all" : "Download" })
          ])
        ]);
        // Only wire a download click for real, selectable qualities.
        if (q.url || q.quality) {
          row.addEventListener("click", () => {
            const quality = row.dataset.quality;
            const plurl = row.dataset.plurl;
            const msg = {
              type: "nexa-download",
              filename: row.dataset.name || document.title
            };
            if (plurl) {                     // entire playlist: playlist URL + quality
              msg.url = plurl;
              msg.quality = quality;
              msg.playlist = true;
            } else if (quality) {            // single site video: page URL + quality
              msg.url = location.href;
              msg.quality = quality;
            } else {
              msg.url = row.dataset.url;
            }
            panel.style.display = "none";
            toast("Sending to Nexa…");
            // Report the REAL handoff result. The background worker relays the
            // native-host reply, so a missing host / dead engine surfaces here
            // instead of a misleading success toast.
            chrome.runtime.sendMessage(msg, (r) => {
              if (chrome.runtime.lastError || !r || r.ok === false) {
                const why = (r && r.message) ||
                  (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
                  "engine unavailable";
                toast("Nexa: " + why);
              } else {
                toast("Sent to Nexa ✓");
              }
            });
          });
        }
        media.appendChild(row);
      });
      frag.appendChild(media);
    });

    panel.replaceChildren(frag);
  }

  // ---- poll the background worker for detected media count -------------
  function poll() {
    // YouTube & co: always offer the pill (streams can't be sniffed). On a
    // dedicated playlist page there's no single video, but the playlist is still
    // downloadable, so offer the pill there too.
    if (showPill()) {
      ensureUi();
      pill.style.display = "flex";
      if (badge) badge.textContent = isPlaylistPage() ? "PL" : (playlistId() ? "PL" : "HD");
      return;
    }
    // Left a site-video page (SPA nav): hide the pill until media is sniffed.
    if (pill) pill.style.display = "none";
    chrome.runtime.sendMessage({ type: "nexa-media-count" }, (info) => {
      if (chrome.runtime.lastError || !info) return;
      ensureUi();
      const count = info.count || 0;
      pill.style.display = count > 0 ? "flex" : "none";
      if (badge) badge.textContent = String(count);
      // Refresh an open panel if the media set changed.
      const sig = info.signature || "";
      if (count > 0 && panel && panel.style.display === "block" && sig !== lastSignature)
        togglePanel(), togglePanel();   // close+reopen to refetch
      lastSignature = sig;
    });
  }

  // Re-poll immediately whenever the URL changes (YouTube is a single-page app,
  // so navigating to a video never reloads the document or re-injects this
  // script). We watch three signals: YouTube's own navigation event, the
  // history API, and a cheap href diff on each interval tick.
  function onNav() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    if (panel) panel.style.display = "none";   // stale panel from the old video
    poll();
  }
  window.addEventListener("yt-navigate-finish", () => setTimeout(onNav, 0), true);
  document.addEventListener("yt-page-data-updated", () => setTimeout(onNav, 0), true);
  window.addEventListener("popstate", () => setTimeout(onNav, 0));
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function () {
      const r = orig.apply(this, arguments);
      setTimeout(onNav, 0);
      return r;
    };
  }

  // Collect every link on the page (used by the "download all links" menu).
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "nexa-collect-links") {
      const urls = Array.from(document.querySelectorAll("a[href]"))
        .map((a) => a.href).filter((h) => /^https?:/i.test(h));
      chrome.runtime.sendMessage({ type: "nexa-download-list", urls: [...new Set(urls)] });
    }
  });

  setInterval(() => { onNav(); poll(); }, 2000);
  setTimeout(poll, 600);
  poll();
})();
