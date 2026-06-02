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

  // ---- site-video detection (YouTube + other yt-dlp sites) -------------
  // Public sites: the panel probes real qualities via yt-dlp -J. Auth sites:
  // -J can't see login-gated formats (no cookies), so offer Best/Audio and let
  // the handoff carry the site cookies. Both download via yt-dlp in the engine.
  // Keep these in sync with kVideoSites/kAuthSites in src/site/YtDlpGrabber.cpp.
  const PUBLIC_VIDEO_HOSTS = ["tiktok.com", "instagram.com", "twitter.com", "x.com",
    "facebook.com", "fb.watch", "reddit.com", "dailymotion.com", "twitch.tv", "bilibili.com"];
  const AUTH_VIDEO_HOSTS = ["udemy.com", "coursera.org", "vimeo.com", "skillshare.com",
    "pluralsight.com", "linkedin.com"];
  function hostIn(list) {
    const h = location.host.toLowerCase();
    return list.some((d) => h === d || h.endsWith("." + d));
  }
  function isPublicSite() { return hostIn(PUBLIC_VIDEO_HOSTS); }
  function isAuthSite()   { return hostIn(AUTH_VIDEO_HOSTS); }
  function isYouTubeHost() {
    return /(^|\.)youtube\.com$/.test(location.host) || /(^|\.)youtu\.be$/.test(location.host);
  }

  function isSiteVideo() {
    const h = location.host;
    if (/(^|\.)youtube\.com$/.test(h))
      return location.pathname === "/watch" || location.pathname.startsWith("/shorts/");
    if (/(^|\.)youtu\.be$/.test(h)) return location.pathname.length > 1;
    return isPublicSite() || isAuthSite();
  }

  // Resolve the specific /@author/video/<id> URL for the TikTok video in view.
  // TikTok keeps the address bar on /en/, /foryou or / for the feed AND the
  // logged-out landing page, so the real per-video URL must be dug out of the
  // DOM. Returns "" when no concrete video can be identified.
  const TT_VIDEO_RE = /\/@[\w.\-]+\/video\/(\d+)/;
  function tiktokVideoUrl() {
    const abs = (href) => { try { return new URL(href, location.origin).href; } catch (_) { return ""; } };
    // distance of an element's vertical centre from the viewport centre, or
    // null when it is hidden / fully off-screen.
    const dist = (elm) => {
      const r = elm.getBoundingClientRect();
      if ((!r.width && !r.height) || r.bottom <= 0 || r.top >= window.innerHeight) return null;
      return Math.abs((r.top + r.bottom) / 2 - window.innerHeight / 2);
    };

    // 1) Most-centred visible /@user/video/<id> anchor (works on grids/feeds).
    let best = "", bestDist = Infinity;
    for (const a of document.querySelectorAll('a[href*="/video/"]')) {
      const href = a.getAttribute("href") || "";
      if (!TT_VIDEO_RE.test(href)) continue;
      const d = dist(a);
      if (d != null && d < bestDist) { bestDist = d; best = href; }
    }
    if (best) return abs(best);

    // 2) The most-centred <video> element → climb its ancestors looking for a
    //    /video/ link or a numeric video id embedded in an element id
    //    (e.g. id="xgwrapper-0-7234567890123456789"), pairing it with the
    //    nearest author handle.
    let vid = null, vDist = Infinity;
    for (const v of document.querySelectorAll("video")) {
      const d = dist(v);
      if (d != null && d < vDist) { vDist = d; vid = v; }
    }
    if (vid) {
      for (let node = vid, i = 0; node && i < 10; node = node.parentElement, i++) {
        const a = node.querySelector && node.querySelector('a[href*="/video/"]');
        if (a && TT_VIDEO_RE.test(a.getAttribute("href") || "")) return abs(a.getAttribute("href"));
        const idm = (node.id || "").match(/(\d{15,21})/);
        if (idm) {
          const au = node.querySelector && node.querySelector('a[href*="/@"]')
                     || document.querySelector('a[href*="/@"]');
          const um = au && (au.getAttribute("href") || "").match(/\/@([\w.\-]+)/);
          if (um) return `https://www.tiktok.com/@${um[1]}/video/${idm[1]}`;
        }
      }
    }

    // 3) canonical / og:url meta (present when a single video is rendered).
    const canon = (document.querySelector('link[rel="canonical"]') || {}).href || "";
    if (TT_VIDEO_RE.test(canon)) return canon;
    const og = (document.querySelector('meta[property="og:url"]') || {}).content || "";
    if (TT_VIDEO_RE.test(og)) return abs(og);

    return "";
  }

  // The actual video URL to hand to yt-dlp. Usually the page URL; on the TikTok
  // feed / landing page resolve the most-centred video out of the DOM.
  function videoUrl() {
    const h = location.host.toLowerCase();
    if (/(^|\.)tiktok\.com$/.test(h) && !/\/video\/\d+/.test(location.pathname)) {
      const u = tiktokVideoUrl();
      if (u) return u;
    }
    return location.href;
  }

  function siteTitle() {
    return (document.title || "video")
      .replace(/\s*-\s*YouTube\s*$/i, "")   // trailing " - YouTube"
      .replace(/^\(\d+\)\s*/, "")            // leading "(7) " notification count
      .trim();
  }
  // The course's name, used as the download FOLDER for "Entire course". Prefer a
  // course-title element, else clean the page title (Udemy: "Course: <name>").
  function courseTitle() {
    const el = document.querySelector(
      '[data-purpose="course-header-title"], h1[data-purpose="lead-title"], ' +
      'a[data-purpose="course-header-back-button"]');
    let t = (el && el.textContent || document.title || "Course");
    return t.replace(/\s*[|–-]\s*Udemy\s*$/i, "")
            .replace(/^\s*Course:\s*/i, "")
            .replace(/^\(\d+\)\s*/, "")
            .trim() || "Course";
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
  // Fallback list, shown only when the live yt-dlp enumeration is unavailable
  // (e.g. the desktop app isn't running yet). yt-dlp's "height<=N" selector
  // degrades gracefully, so offering 4K/1440p here is safe even on a video that
  // tops out lower — it just yields that video's best.
  const YT_QUALITIES = [
    { label: "Best available", quality: "best", meta: "video + audio" },
    { label: "2160p (4K)", quality: "2160", meta: "video + audio" },
    { label: "1440p (HD)", quality: "1440", meta: "video + audio" },
    { label: "1080p", quality: "1080", meta: "video + audio" },
    { label: "720p", quality: "720", meta: "video + audio" },
    { label: "480p", quality: "480", meta: "video + audio" },
    { label: "360p", quality: "360", meta: "video + audio" },
    { label: "Audio only (m4a)", quality: "audio", meta: "" }
  ];

  // ---- styling (injected once) -----------------------------------------
  // Palette mirrors the Nexa app + redesigned popup: deep navy canvas, indigo
  // accent (#6366f1/#4f46e5), teal (#34d399), text #e6edf3.
  const css = `
    #nexa-pill{position:fixed;right:20px;bottom:20px;z-index:2147483647;
      display:none;align-items:center;gap:8px;cursor:pointer;
      background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;
      font:700 13px/1 -apple-system,"Segoe UI",system-ui,sans-serif;
      padding:10px 15px 10px 12px;border-radius:24px;letter-spacing:.2px;
      border:1px solid rgba(129,140,248,.55);
      box-shadow:0 8px 24px rgba(79,70,229,.5);user-select:none;
      transition:transform .12s,box-shadow .15s,filter .15s}
    #nexa-pill:hover{transform:translateY(-2px);filter:brightness(1.07);
      box-shadow:0 12px 30px rgba(79,70,229,.6)}
    #nexa-pill svg{flex:0 0 auto;display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
    #nexa-pill .nx-badge{background:#fff;color:#4f46e5;border-radius:999px;
      font-size:11px;font-weight:800;padding:1px 7px;margin-left:2px}
    #nexa-panel{position:fixed;right:20px;bottom:74px;z-index:2147483647;display:none;
      width:328px;max-height:62vh;overflow:auto;color:#e6edf3;
      background:radial-gradient(120% 80% at 50% 0%,#15203a 0%,#0d1326 55%,#0a0e1a 100%);
      border:1px solid #232b42;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.6);
      font:13px/1.45 -apple-system,"Segoe UI",system-ui,sans-serif}
    #nexa-panel .nx-head{display:flex;align-items:center;justify-content:space-between;
      padding:13px 15px;border-bottom:1px solid #1b2236;font-weight:700;color:#f3f6fb}
    #nexa-panel .nx-close{cursor:pointer;color:#8b94a7;font-size:16px;line-height:1;
      padding:2px 7px;border-radius:7px;transition:background .12s,color .12s}
    #nexa-panel .nx-close:hover{background:#1b2236;color:#e6edf3}
    #nexa-panel .nx-media{padding:8px 15px;border-top:1px solid #161d2c}
    #nexa-panel .nx-title{color:#8b94a7;font-size:11px;text-transform:uppercase;
      letter-spacing:.05em;margin:6px 0 8px;word-break:break-all}
    #nexa-panel .nx-q{display:flex;align-items:center;justify-content:space-between;
      gap:8px;padding:10px 11px;margin:6px 0;background:#141b2c;border:1px solid #232b42;
      border-radius:10px;cursor:pointer;transition:background .12s,border-color .12s,transform .1s}
    #nexa-panel .nx-q:hover{background:#1b2236;border-color:#2d3650;transform:translateX(2px)}
    #nexa-panel .nx-q .nx-meta{color:#8b94a7;font-size:11px}
    #nexa-panel .nx-q .nx-dl{background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;
      border-radius:7px;padding:4px 10px;font-size:11px;font-weight:700}
    #nexa-panel .nx-empty{padding:16px;color:#8b94a7}
    #nexa-toast{position:fixed;right:20px;bottom:74px;z-index:2147483647;display:none;
      background:linear-gradient(135deg,#10b981,#34d399);color:#04140c;
      font:700 13px/1 -apple-system,"Segoe UI",system-ui,sans-serif;
      padding:11px 15px;border-radius:12px;box-shadow:0 8px 24px rgba(16,185,129,.4)}
  `;

  function injectStyleOnce() {
    if (document.getElementById("nexa-style")) return;
    const style = document.createElement("style");
    style.id = "nexa-style";
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  // The Nexa brand mark — a letter "N" whose right leg flows into a down arrow
  // ("Nexa Downloader"). Built via the SVG namespace (Trusted-Types-safe; no
  // innerHTML). White N + light-teal arrow reads cleanly on the indigo pill.
  function nexaLogo(size) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 64 64");
    svg.setAttribute("width", String(size || 18));
    svg.setAttribute("height", String(size || 18));
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    const path = (d, attrs) => {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      for (const k in attrs) p.setAttribute(k, attrs[k]);
      svg.appendChild(p);
    };
    const nAttr = { stroke: "#ffffff", "stroke-width": "6.2",
                    "stroke-linecap": "round", "stroke-linejoin": "round" };
    path("M16 46 V18", nAttr);          // left stem
    path("M16 18 L44 42", nAttr);       // diagonal
    path("M44 14 V40", nAttr);          // right stem
    const aAttr = { stroke: "#a7f3d0", "stroke-width": "6.2",
                    "stroke-linecap": "round", "stroke-linejoin": "round" };
    path("M44 40 V50", aAttr);          // arrow shaft (continues the right leg)
    path("M35 45 L44 54 L53 45 Z",      // arrowhead
         { fill: "#a7f3d0", stroke: "#a7f3d0", "stroke-width": "2",
           "stroke-linejoin": "round" });
    return svg;
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
        nexaLogo(18),
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
      const vurl = videoUrl();
      const hasPlaylist = !!playlistId();
      // Let yt-dlp name non-YouTube videos from their real title (the page title
      // isn't the caption); keep the cleaned title as the name for YouTube.
      const dlName = isYouTubeHost() ? siteTitle() : "";
      // Build groups: [this video] (+ [entire playlist] when the video is in one).
      const withPlaylist = (videoGroup) =>
        hasPlaylist ? [videoGroup, playlistGroup()] : [videoGroup];

      // Auth sites (Udemy/Coursera/…): the -J probe can't see login-gated
      // formats, so offer Best/Audio directly — the handoff carries the cookies.
      if (isAuthSite()) {
        // "Entire course" sends the current lecture page URL with the playlist
        // flag; the engine normalises it to udemy.com/course/<slug>/learn/lecture/
        // (the page that exposes the course id) so yt-dlp enumerates every
        // lecture. NOTE: DRM-protected lectures can't be downloaded by yt-dlp, so
        // a DRM course yields only its non-DRM (plain) videos.
        const onLecture = /\/learn\/lecture\//.test(location.pathname);
        const quals = [];
        if (onLecture)
          quals.push({ label: "⬇  Entire course — all lectures", quality: "best",
                       meta: "every video", course: true, name: courseTitle() });
        quals.push({ label: onLecture ? "This lecture only" : "Best available",
                     quality: "best", meta: "video + audio" });
        quals.push({ label: "Audio only (m4a)", quality: "audio", meta: "" });
        renderPanel(withPlaylist({ title: siteTitle(), name: dlName, site: true,
                                   url: vurl, qualities: quals }));
        return;
      }

      // YouTube + public sites: ask the engine (yt-dlp -J) for REAL qualities.
      renderPanel(withPlaylist({ title: siteTitle(), qualities: [{ label: "Loading qualities…" }] }));
      chrome.runtime.sendMessage({ type: "nexa-list-formats", url: vurl }, (r) => {
        let quals;
        if (!chrome.runtime.lastError && r && r.ok && Array.isArray(r.qualities) && r.qualities.length) {
          // Every quality is delivered as video+audio (yt-dlp merges). The label
          // already carries the frame-rate ("2160p60"); append the 4K/HD note.
          quals = [{ label: "Best available", quality: "best", meta: "video + audio" }];
          for (const q of r.qualities)
            quals.push({
              label: q.note ? `${q.label}  ${q.note}` : q.label,
              quality: String(q.height),
              meta: "video + audio"
            });
          quals.push({ label: "Audio only (m4a)", quality: "audio", meta: "" });
        } else {
          quals = YT_QUALITIES.map((q) => ({ label: q.label, quality: q.quality, meta: q.meta }));
        }
        renderPanel(withPlaylist({ title: siteTitle(), name: dlName, site: true,
                                   url: vurl, qualities: quals }));
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
          data: { url: q.url || "", quality: q.quality || "", name: q.name || g.name || "",
                  plurl: g.playlist ? (g.playlistUrl || "") : "",
                  siteurl: g.url || "", course: q.course ? "1" : "" }
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
            const msg = { type: "nexa-download" };
            if (plurl) {                     // entire playlist: playlist URL + quality
              msg.url = plurl;
              msg.quality = quality;
              msg.playlist = true;
              msg.filename = row.dataset.name || "";
            } else if (quality) {            // single site video: resolved page URL
              let siteUrl = row.dataset.siteurl || location.href;
              // The TikTok feed scrolls between the panel opening and this click,
              // so re-resolve the centred video now. If we still can't pin a
              // concrete /video/<id>, guide the user instead of handing off the
              // bare feed URL (which yt-dlp rejects as "Unsupported URL").
              const onTikTok = /(^|\.)tiktok\.com$/.test(location.host.toLowerCase());
              if (onTikTok && !/\/video\/\d+/.test(location.pathname)) {
                siteUrl = videoUrl();
                if (!TT_VIDEO_RE.test(siteUrl)) {
                  panel.style.display = "none";
                  toast("Nexa: open the specific TikTok video first (tap it so the "
                        + "address bar shows /video/…), then click Download.");
                  return;
                }
              }
              msg.url = siteUrl;
              msg.quality = quality;
              msg.filename = row.dataset.name || "";   // empty -> yt-dlp uses real title
              if (row.dataset.course === "1") msg.playlist = true;  // whole course
            } else {                         // sniffed direct media URL
              msg.url = row.dataset.url;
              msg.filename = row.dataset.name || document.title;
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
