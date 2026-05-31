// Nexa content script — IDM-style "Download this video" experience.
//
// When the background worker reports media on this tab, a floating pill appears.
// Clicking it opens a panel listing each video and its available qualities
// (parsed from the HLS master playlist in the background). Clicking a quality
// hands that exact stream to the Nexa desktop app.

(function () {
  "use strict";
  if (window.top !== window) return;        // top frame only

  let pill = null;
  let panel = null;
  let lastSignature = "";

  // ---- site-video (YouTube etc.) detection -----------------------------
  function isSiteVideo() {
    const h = location.host;
    if (/(^|\.)youtube\.com$/.test(h))
      return location.pathname === "/watch" || location.pathname.startsWith("/shorts/");
    return /(^|\.)youtu\.be$/.test(h);
  }
  function siteTitle() {
    return (document.title || "video")
      .replace(/\s*-\s*YouTube\s*$/i, "")   // trailing " - YouTube"
      .replace(/^\(\d+\)\s*/, "")            // leading "(7) " notification count
      .trim();
  }
  const YT_QUALITIES = [
    { label: "Best available", quality: "best", meta: "video + audio" },
    { label: "1080p", quality: "1080", meta: "" },
    { label: "720p", quality: "720", meta: "" },
    { label: "480p", quality: "480", meta: "" },
    { label: "360p", quality: "360", meta: "" },
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
  const style = document.createElement("style");
  style.textContent = css;
  document.documentElement.appendChild(style);

  function ensureUi() {
    if (pill) return;
    pill = document.createElement("div");
    pill.id = "nexa-pill";
    pill.innerHTML = `⬇ <span>Download Video</span><span class="nx-badge">0</span>`;
    pill.addEventListener("click", togglePanel);
    document.documentElement.appendChild(pill);

    panel = document.createElement("div");
    panel.id = "nexa-panel";
    document.documentElement.appendChild(panel);
  }

  function toast(msg) {
    let t = document.getElementById("nexa-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "nexa-toast";
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

    if (isSiteVideo()) {
      // YouTube & co: a fixed quality menu (yt-dlp resolves the streams).
      renderPanel([{
        title: siteTitle(), name: siteTitle(), site: true,
        qualities: YT_QUALITIES.map((q) => ({ label: q.label, meta: q.meta, quality: q.quality }))
      }]);
      return;
    }
    renderPanel([{ title: "Loading qualities…", qualities: [] }]);
    chrome.runtime.sendMessage({ type: "nexa-get-qualities" }, (groups) => {
      if (chrome.runtime.lastError) { renderPanel([]); return; }
      renderPanel(groups || []);
    });
  }

  function renderPanel(groups) {
    let html = `<div class="nx-head"><span>⬇ Download with Nexa</span>
                <span class="nx-close" title="Close">✕</span></div>`;
    if (!groups.length) {
      html += `<div class="nx-empty">No downloadable video found on this page yet.
               Start playing the video and try again.</div>`;
    }
    groups.forEach((g) => {
      html += `<div class="nx-media"><div class="nx-title">${esc(g.title || "Video")}</div>`;
      if (!g.qualities.length) {
        html += `<div class="nx-meta">…</div>`;
      }
      g.qualities.forEach((q) => {
        html += `<div class="nx-q" data-url="${esc(q.url || "")}" data-quality="${esc(q.quality || "")}"
                      data-name="${esc(g.name || "")}">
                   <span>${esc(q.label)}</span>
                   <span style="display:flex;gap:8px;align-items:center">
                     <span class="nx-meta">${esc(q.meta || "")}</span>
                     <span class="nx-dl">Download</span>
                   </span></div>`;
      });
      html += `</div>`;
    });
    panel.innerHTML = html;
    panel.querySelector(".nx-close").addEventListener("click", () => { panel.style.display = "none"; });
    panel.querySelectorAll(".nx-q").forEach((el) => {
      el.addEventListener("click", () => {
        const quality = el.getAttribute("data-quality");
        const msg = {
          type: "nexa-download",
          filename: el.getAttribute("data-name") || document.title
        };
        if (quality) {                       // site video (YouTube): page URL + quality
          msg.url = location.href;
          msg.quality = quality;
        } else {
          msg.url = el.getAttribute("data-url");
        }
        chrome.runtime.sendMessage(msg);
        panel.style.display = "none";
        toast("Sent to Nexa ✓");
      });
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // ---- poll the background worker for detected media count -------------
  function poll() {
    // YouTube & co: always offer the pill (streams can't be sniffed).
    if (isSiteVideo()) {
      ensureUi();
      pill.style.display = "flex";
      pill.querySelector(".nx-badge").textContent = "HD";
      return;
    }
    chrome.runtime.sendMessage({ type: "nexa-media-count" }, (info) => {
      if (chrome.runtime.lastError || !info) return;
      ensureUi();
      const count = info.count || 0;
      pill.style.display = count > 0 ? "flex" : "none";
      pill.querySelector(".nx-badge").textContent = String(count);
      // Refresh an open panel if the media set changed.
      const sig = info.signature || "";
      if (count > 0 && panel && panel.style.display === "block" && sig !== lastSignature)
        togglePanel(), togglePanel();   // close+reopen to refetch
      lastSignature = sig;
    });
  }

  // Collect every link on the page (used by the "download all links" menu).
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "nexa-collect-links") {
      const urls = Array.from(document.querySelectorAll("a[href]"))
        .map((a) => a.href).filter((h) => /^https?:/i.test(h));
      chrome.runtime.sendMessage({ type: "nexa-download-list", urls: [...new Set(urls)] });
    }
  });

  setInterval(poll, 2000);
  setTimeout(poll, 1200);
})();
