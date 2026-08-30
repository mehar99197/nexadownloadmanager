// Nexa content script — IDM-style "Download this video" experience.
//
// A compact "Download" button sits over the top-right corner of the video the
// user is watching. It appears on hover, like the player's own controls, and
// flashes once when a page with something downloadable opens so it can be
// found without hunting. Clicking it drops a panel down from the button that
// lists each video and its available qualities (parsed from the HLS master
// playlist / yt-dlp in the background); clicking a quality hands that exact
// stream to the Nexa desktop app. A page with sniffed media but no player (an
// audio preview) parks the same button in the top-right corner instead.
//
// All UI is built with DOM APIs (createElement/textContent) rather than
// innerHTML. YouTube enforces a `require-trusted-types-for 'script'` CSP, and
// assigning to .innerHTML throws there — which previously aborted UI creation
// so the button never appeared. DOM construction is Trusted-Types-safe.

(function () {
  "use strict";
  // The background worker also injects this file into tabs that were already
  // open when the extension started. Do not create duplicate buttons/panels when
  // Chrome subsequently injects the declared content script on navigation.
  if (globalThis.__nexaContentScriptLoaded) return;
  globalThis.__nexaContentScriptLoaded = true;
  if (window.top !== window) return;        // top frame only

  let panel = null;
  let badge = null;             // small "PL" / count tag on the Download button
  let uiActive = false;         // something downloadable is on offer on this page
  let lastOfferKey = "";        // page URL the button was last flashed for
  let lastSignature = "";
  let lastHref = location.href;
  let prefetchedUrl = "";       // video URL whose qualities we've warmed the cache for
  let prefetchArmedUrl = "";    // URL the debounced prefetch timer is counting for
  let prefetchTimer = null;
  let pollTimer = null;         // 2s poll — runs only while a download is on offer on a visible tab
  let nexaStopped = false;      // true once our extension context is invalidated
  let uiAllowed = true;         // showFloatingButton on AND this site not paused (storage.local)

  // ---- extension-context safety ----------------------------------------
  // When the extension is reloaded/updated/disabled, content scripts already
  // injected in open tabs keep running but their context is invalidated — any
  // chrome.* call then throws "Extension context invalidated". Our 2s poll would
  // otherwise throw on every tick (hundreds of console errors). So: detect the
  // dead context, tear our timers/UI down, and make every sendMessage a safe
  // no-op once it's gone.
  function extAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }
  function shutdown() {
    if (nexaStopped) return;
    nexaStopped = true;
    clearInterval(pollTimer);
    pollTimer = null;
    clearTimeout(prefetchTimer);
    hideVideoBtn();             // also closes the panel
  }
  // Drop-in replacement for chrome.runtime.sendMessage that never throws on a
  // dead context. Touches lastError so Chrome doesn't log "Unchecked
  // runtime.lastError", and shuts us down when the context is gone.
  function sendMessageSafe(msg, cb) {
    if (nexaStopped || !extAlive()) { shutdown(); return; }
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        const err = chrome.runtime.lastError;
        if (err && /context invalidated|message port closed|receiving end does not exist/i
                     .test(err.message || "")) { shutdown(); return; }
        if (cb) cb(resp);
      });
    } catch (_) {
      shutdown();   // synchronous "Extension context invalidated"
    }
  }

  // ---- site-video detection (YouTube + other yt-dlp sites) -------------
  // Public sites: the panel probes real qualities via yt-dlp -J. Auth sites:
  // -J can't see login-gated formats (no cookies), so offer Best/Audio and let
  // the handoff carry the site cookies. Both download via yt-dlp in the engine.
  // Keep these in sync with kVideoSites/kAuthSites in src/site/YtDlpGrabber.cpp.
  const PUBLIC_VIDEO_HOSTS = ["tiktok.com", "twitter.com", "x.com",
    "reddit.com", "dailymotion.com", "twitch.tv", "bilibili.com", "threads.net"];
  const AUTH_VIDEO_HOSTS = ["udemy.com", "coursera.org", "vimeo.com", "skillshare.com",
    "pluralsight.com", "linkedin.com", "facebook.com", "fb.watch", "instagram.com"];
  function hostIn(list) {
    const h = location.host.toLowerCase();
    return list.some((d) => h === d || h.endsWith("." + d));
  }
  function isPublicSite() { return hostIn(PUBLIC_VIDEO_HOSTS); }
  function isAuthSite()   { return hostIn(AUTH_VIDEO_HOSTS); }
  // Coursera needs special handling: it's login-gated (so it lives in the auth
  // list for cookies), but yt-dlp has NO Coursera extractor — handing it the page
  // URL fails with "Unsupported URL". So instead we download the actual video the
  // page is streaming, sniffed from its own network requests.
  function isCoursera()   { return /(^|\.)coursera\.org$/.test(location.host.toLowerCase()); }
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

  function sanitizeName(s) {
    let raw = String(s || "").split(/[\\/]/).pop();
    try { raw = decodeURIComponent(raw); } catch (_) {}
    return raw.replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 120);
  }
  // Apple Music plays preview clips from audio-ssl.itunes.apple.com, which the
  // extension sniffs and downloads directly. Those URLs name the file after the CDN
  // blob ("mzaf_…plus.aac.ep.m4a"), so derive the real "Artist - Song" name from the
  // page instead. og:title is the song; the music-row/now-playing artist fills the
  // prefix. Returns "" when nothing usable is found (caller keeps the old name then).
  function isAppleMusicPage() { return /(^|\.)music\.apple\.com$/.test(location.host.toLowerCase()); }
  function appleMusicName() {
    const meta = (sel, attr) => { const e = document.querySelector(sel); return (e && (e.getAttribute(attr) || e.content) || "").trim(); };
    let song = meta('meta[property="og:title"]', "content");
    if (!song) { const h = document.querySelector("h1"); song = (h && h.textContent || "").trim(); }
    song = song.replace(/\s+on Apple Music\s*$/i, "").replace(/\s*[|–-]\s*Apple Music\s*$/i, "").trim();
    if (!song) return "";
    let artist = meta('meta[name="apple:artist"]', "content") ||
                 meta('meta[property="music:musician_description"]', "content");
    if (!artist) {
      // Subtitle under the title is usually the artist on a song/album page.
      const sub = document.querySelector('.headings__subtitles, [data-testid="track-subtitle"], .song-subtitles');
      artist = (sub && sub.textContent || "").trim();
    }
    const full = artist ? `${artist} - ${song}` : song;
    // Strip path-illegal characters; the engine sanitises too, but keep it clean here.
    return full.replace(/[\/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  }

  // Spotify plays encrypted full tracks (DRM, unsniffable); only its 30-second
  // preview clips are plain MP3 (p.scdn.co/mp3-preview), which the sniffer now
  // catches. Name the file after the track instead of the preview-hash URL.
  function isSpotifyPage() { return /(^|\.)spotify\.com$/.test(location.host.toLowerCase()); }
  function spotifyName() {
    const meta = (sel, attr) => { const e = document.querySelector(sel); return (e && (e.getAttribute(attr) || e.content) || "").trim(); };
    let song = meta('meta[property="og:title"]', "content");
    if (!song) { const h = document.querySelector("h1"); song = (h && h.textContent || "").trim(); }
    song = song.replace(/\s*[|–-]\s*Spotify\s*$/i, "").trim();
    if (!song) return "";
    // og:description on a track page reads like "Artist · Song · Year"; take the artist.
    let artist = meta('meta[name="music:musician_description"]', "content");
    if (!artist) {
      const m = /^([^·•]+?)\s*[·•]/.exec(meta('meta[property="og:description"]', "content"));
      if (m) artist = m[1].trim();
    }
    const full = artist ? `${artist} - ${song}` : song;
    return full.replace(/[\/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  }

  // Coursera streams its lecture video from a CDN, which the extension sniffs and
  // downloads directly — so the file would be named after the CDN blob. Derive the
  // lecture's real title instead: prefer the on-page heading, else the URL slug
  // (…/lecture/<id>/<this-slug>), e.g. "overview-of-the-job-interview" -> "Overview
  // Of The Job Interview". Returns "" when nothing usable is found.
  function courseraLectureName() {
    let t = "";
    const h = document.querySelector('h1, [data-e2e="item-title"], [data-testid="item-page-title"], .video-name');
    if (h) t = (h.textContent || "").trim();
    if (!t) {
      const m = /\/lecture\/[^/]+\/([^/?#]+)/.exec(location.pathname);
      if (m) t = decodeURIComponent(m[1]).replace(/[-_]+/g, " ").trim()
                   .replace(/\b\w/g, (c) => c.toUpperCase());
    }
    t = t.replace(/\s*[|–-]\s*Coursera\s*$/i, "").trim();
    return t.replace(/[\/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
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
    // Empty (not a generic "YouTube Playlist") when the page scrape misses, so
    // the engine falls back to yt-dlp's real %(playlist_title)s for the folder
    // name instead of a placeholder.
    return (t || "").trim();
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
    { label: "4320p (8K)", quality: "4320", meta: "video + audio" },
    { label: "2160p (4K)", quality: "2160", meta: "video + audio" },
    { label: "1440p (2K)", quality: "1440", meta: "video + audio" },
    { label: "1080p (FHD)", quality: "1080", meta: "video + audio" },
    { label: "720p (HD)", quality: "720", meta: "video + audio" },
    { label: "480p (SD)", quality: "480", meta: "video + audio" },
    { label: "360p (SD)", quality: "360", meta: "video + audio" },
    { label: "Audio only (m4a)", quality: "audio:m4a", meta: "" }
  ];

  // The one name the on-video button and the panel wear. Kept in one place so
  // the button, its tooltip and the panel header can never drift apart.
  const BRAND = "Download with NDM";

  // ---- styling (injected once) -----------------------------------------
  // Palette mirrors the Nexa app: deep navy glass, indigo accent
  // (#6366f1/#4f46e5), mint (#34d399), text #e6edf3. Every property the UI
  // relies on is declared explicitly — host pages ship aggressive `*` rules,
  // so box-sizing, font, colour and casing are never left to inherit.
  const css = `
    #nexa-video-btn,#nexa-panel,#nexa-toast,
    #nexa-video-btn *,#nexa-panel *,#nexa-toast *{box-sizing:border-box}

    /* ---- the button that floats over the player ---- */
    #nexa-video-btn{position:fixed;z-index:2147483646;display:none;align-items:center;gap:7px;
      cursor:pointer;color:#f3f6fb;
      background:linear-gradient(180deg,rgba(33,38,62,.92),rgba(14,17,30,.94));
      backdrop-filter:blur(10px) saturate(140%);-webkit-backdrop-filter:blur(10px) saturate(140%);
      font:700 12px/1 -apple-system,"Segoe UI",Inter,system-ui,sans-serif;
      letter-spacing:.005em;text-transform:none;text-align:left;
      padding:8px 13px 8px 10px;border-radius:12px;
      border:1px solid rgba(129,140,248,.42);
      box-shadow:0 10px 26px rgba(2,4,12,.5),inset 0 1px 0 rgba(255,255,255,.09);
      user-select:none;opacity:0;
      transition:opacity .16s ease,transform .14s cubic-bezier(.2,.8,.3,1),
                 background .16s ease,border-color .16s ease,box-shadow .16s ease}
    #nexa-video-btn.nx-on{opacity:1}
    #nexa-video-btn:hover,#nexa-video-btn.nx-open{transform:translateY(-1px);
      background:linear-gradient(135deg,#6366f1,#4f46e5);border-color:#a5b4fc;
      box-shadow:0 12px 30px rgba(79,70,229,.45),inset 0 1px 0 rgba(255,255,255,.18)}
    #nexa-video-btn:active{transform:translateY(0) scale(.985)}
    #nexa-video-btn svg{flex:0 0 auto;display:block}
    #nexa-video-btn .nx-label{white-space:nowrap}
    #nexa-video-btn .nx-badge{display:none;background:#fff;color:#4f46e5;border-radius:999px;
      font-size:10px;font-weight:800;padding:2px 7px;margin-left:1px;line-height:1.2;
      letter-spacing:.02em}
    #nexa-video-btn .nx-badge.nx-show{display:inline-block}

    /* ---- the quality panel: a dropdown hanging off the button ---- */
    #nexa-panel{position:fixed;z-index:2147483647;display:none;
      width:344px;max-height:68vh;overflow:hidden auto;color:#e6edf3;
      background:radial-gradient(120% 120% at 100% 0%,rgba(99,102,241,.17),transparent 58%),
                 linear-gradient(180deg,rgba(23,27,46,.97),rgba(12,15,26,.97));
      backdrop-filter:blur(18px) saturate(140%);-webkit-backdrop-filter:blur(18px) saturate(140%);
      border:1px solid rgba(129,140,248,.3);border-radius:16px;
      box-shadow:0 24px 60px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.35),
                 inset 0 1px 0 rgba(255,255,255,.07);
      font:500 13px/1.45 -apple-system,"Segoe UI",Inter,system-ui,sans-serif;
      letter-spacing:normal;text-align:left;
      scrollbar-width:thin;scrollbar-color:rgba(129,140,248,.42) transparent;
      transform-origin:top right;animation:nx-drop .16s cubic-bezier(.2,.8,.3,1)}
    #nexa-panel.nx-up{transform-origin:bottom right;animation-name:nx-rise}
    #nexa-panel::-webkit-scrollbar{width:10px}
    #nexa-panel::-webkit-scrollbar-track{background:transparent}
    #nexa-panel::-webkit-scrollbar-thumb{background:rgba(129,140,248,.34);border-radius:999px;
      border:3px solid transparent;background-clip:content-box}
    #nexa-panel::-webkit-scrollbar-thumb:hover{background:rgba(129,140,248,.62);
      border:3px solid transparent;background-clip:content-box}
    @keyframes nx-drop{from{opacity:0;transform:translateY(-8px) scale(.97)}to{opacity:1;transform:none}}
    @keyframes nx-rise{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}

    /* Header stays put while a long quality list scrolls under it. */
    #nexa-panel .nx-head{position:sticky;top:0;z-index:2;
      display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 13px;
      /* Opaque: a translucent header lets the rows scrolling under it bleed through.
         The radial repeats the panel's own top-right glow so it still reads as one surface. */
      background:radial-gradient(140% 210% at 100% 0%,rgba(99,102,241,.2),transparent 60%),#181c30;
      border-bottom:1px solid rgba(129,140,248,.16);
      box-shadow:0 6px 14px -8px rgba(0,0,0,.7)}
    #nexa-panel .nx-brand{display:flex;align-items:center;gap:9px;min-width:0}
    #nexa-panel .nx-brand-text{font-size:13px;font-weight:700;color:#f3f6fb;
      white-space:nowrap;letter-spacing:.005em}
    #nexa-panel .nx-close{display:flex;align-items:center;justify-content:center;flex:0 0 auto;
      width:26px;height:26px;padding:0;cursor:pointer;color:#8b94a7;
      background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:8px;
      transition:background .14s,color .14s,border-color .14s}
    #nexa-panel .nx-close:hover{background:rgba(244,63,94,.18);
      border-color:rgba(244,63,94,.42);color:#fecdd3}
    #nexa-panel .nx-close:focus-visible,#nexa-panel .nx-q:focus-visible{outline:2px solid #818cf8;
      outline-offset:2px}

    /* One media block per detected video / playlist. */
    #nexa-panel .nx-media{padding:11px 12px 8px}
    #nexa-panel .nx-media+.nx-media{border-top:1px solid rgba(255,255,255,.06)}
    #nexa-panel .nx-mhead{display:flex;align-items:flex-start;gap:9px;padding:0 2px 4px}
    #nexa-panel .nx-mhead svg{flex:0 0 auto;margin-top:2px;color:#818cf8;opacity:.85}
    /* Sentence case, clamped to two lines — a long video title used to shout in
       uppercase and eat half the panel. */
    #nexa-panel .nx-title{flex:1 1 auto;min-width:0;color:#dfe6f2;font-size:12.5px;font-weight:600;
      line-height:1.35;text-transform:none;letter-spacing:normal;overflow-wrap:anywhere;
      display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    #nexa-panel .nx-chip{flex:0 0 auto;color:#a5b4fc;background:rgba(99,102,241,.16);
      border:1px solid rgba(129,140,248,.24);border-radius:999px;font-size:9.5px;font-weight:700;
      letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;white-space:nowrap;opacity:.9}
    #nexa-panel .nx-sec{display:flex;align-items:baseline;justify-content:space-between;gap:10px;
      color:#6f7890;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;
      padding:9px 4px 4px}
    #nexa-panel .nx-sec .nx-secnote{font-weight:600;letter-spacing:.06em;color:#5d6579}
    #nexa-panel .nx-hint{color:#6f7890;font-size:11.5px;padding:2px 2px 6px}

    /* A quality row: [tag] name … meta [go]. The whole row is the button. */
    #nexa-panel .nx-q{display:flex;align-items:center;gap:9px;padding:7px 9px;margin:4px 0;
      background:rgba(255,255,255,.035);border:1px solid rgba(129,140,248,.14);border-radius:11px;
      cursor:pointer;transition:background .14s,border-color .14s,
      transform .12s cubic-bezier(.2,.8,.3,1)}
    #nexa-panel .nx-q:hover{background:rgba(99,102,241,.18);border-color:rgba(129,140,248,.55);
      transform:translateX(2px)}
    #nexa-panel .nx-q:active{transform:translateX(2px) scale(.99)}
    #nexa-panel .nx-q.nx-best{background:linear-gradient(135deg,rgba(99,102,241,.24),
      rgba(16,185,129,.1));border-color:rgba(129,140,248,.45)}
    #nexa-panel .nx-q.nx-best:hover{background:linear-gradient(135deg,rgba(99,102,241,.34),
      rgba(16,185,129,.16))}
    #nexa-panel .nx-tag{flex:0 0 auto;min-width:54px;text-align:center;color:#c7d2fe;
      background:rgba(99,102,241,.18);border:1px solid rgba(129,140,248,.3);border-radius:7px;
      font-size:11px;font-weight:800;line-height:1.35;letter-spacing:.01em;padding:3px 6px;
      white-space:nowrap;text-transform:none}
    #nexa-panel .nx-q.nx-best .nx-tag{color:#06231a;border-color:transparent;
      background:linear-gradient(135deg,#a7f3d0,#6ee7b7)}
    #nexa-panel .nx-q.nx-audio .nx-tag{color:#a7f3d0;background:rgba(16,185,129,.14);
      border-color:rgba(52,211,153,.3)}
    #nexa-panel .nx-name{flex:1 1 auto;min-width:0;color:#e6edf3;font-size:12.5px;font-weight:600;
      line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #nexa-panel .nx-meta{flex:0 0 auto;color:#7d879c;font-size:10.5px;font-weight:500;
      white-space:nowrap}
    #nexa-panel .nx-go{flex:0 0 auto;display:flex;align-items:center;justify-content:center;
      width:24px;height:24px;border-radius:8px;color:#a5b4fc;background:rgba(129,140,248,.12);
      border:1px solid rgba(129,140,248,.22);
      transition:background .14s,color .14s,border-color .14s,transform .14s}
    #nexa-panel .nx-q:hover .nx-go{background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;
      border-color:transparent;transform:translateY(1px)}
    #nexa-panel .nx-dl{flex:0 0 auto;color:#a5b4fc;background:rgba(129,140,248,.12);
      border:1px solid rgba(129,140,248,.22);border-radius:8px;padding:4px 9px;font-size:10.5px;
      font-weight:700;letter-spacing:.02em;white-space:nowrap;
      transition:background .14s,color .14s,border-color .14s}
    #nexa-panel .nx-q:hover .nx-dl{background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;
      border-color:transparent}

    /* Waiting on yt-dlp: shimmer placeholders instead of a bare line of text. */
    #nexa-panel .nx-q.nx-skel,#nexa-panel .nx-q.nx-skel:hover{cursor:default;transform:none;
      background:rgba(255,255,255,.03);border-color:rgba(255,255,255,.06);
      position:relative;overflow:hidden}
    #nexa-panel .nx-skel .nx-tag,#nexa-panel .nx-skel .nx-go{color:transparent;
      background:rgba(255,255,255,.06);border-color:transparent}
    #nexa-panel .nx-skel .nx-name{color:#6f7890;font-weight:500}
    #nexa-panel .nx-skel .nx-name:empty::before{content:"";display:block;height:9px;width:58%;
      border-radius:5px;background:rgba(255,255,255,.07)}
    #nexa-panel .nx-skel::after{content:"";position:absolute;inset:0;
      background:linear-gradient(90deg,transparent,rgba(255,255,255,.08),transparent);
      transform:translateX(-100%);animation:nx-shine 1.3s linear infinite}
    @keyframes nx-shine{to{transform:translateX(100%)}}

    #nexa-panel .nx-empty{display:flex;flex-direction:column;align-items:center;gap:7px;
      padding:26px 22px 30px;color:#aab3c5;font-size:12.5px;line-height:1.5;text-align:center}
    #nexa-panel .nx-empty svg{color:#818cf8;opacity:.55;margin-bottom:2px}
    #nexa-panel .nx-empty .nx-sub{color:#6f7890;font-size:11.5px}

    #nexa-toast{position:fixed;z-index:2147483647;display:none;max-width:min(360px,58vw);
      background:linear-gradient(135deg,#10b981,#34d399);color:#04140c;
      font:700 12.5px/1.4 -apple-system,"Segoe UI",Inter,system-ui,sans-serif;
      letter-spacing:normal;text-align:left;padding:11px 14px;border-radius:12px;
      box-shadow:0 14px 34px rgba(16,185,129,.38),inset 0 1px 0 rgba(255,255,255,.28)}

    @media (prefers-reduced-motion:reduce){
      #nexa-video-btn,#nexa-panel,#nexa-panel *{animation:none!important;transition:none!important}
    }
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
  // innerHTML). White N + light-teal arrow reads cleanly on the dark button.
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

  // Line icons for the panel chrome (close, download arrow, media, playlist,
  // empty state). Same SVG-namespace construction as the logo, so they are
  // Trusted-Types-safe; `currentColor` lets CSS drive every state.
  const ICONS = {
    close:  ["M5.6 5.6 L14.4 14.4", "M14.4 5.6 L5.6 14.4"],
    arrow:  ["M10 3.6 V12.4", "M6.3 8.9 L10 12.6 L13.7 8.9", "M4.6 16.2 H15.4"],
    film:   ["M2.9 6.6 Q2.9 4.7 4.8 4.7 H15.2 Q17.1 4.7 17.1 6.6 V13.4 "
             + "Q17.1 15.3 15.2 15.3 H4.8 Q2.9 15.3 2.9 13.4 Z",
             "M8.6 8.2 L12.5 10 L8.6 11.8 Z"],
    list:   ["M3.6 5.6 H16.4", "M3.6 10 H11.6", "M3.6 14.4 H9.2",
             "M13.6 12.2 L16.8 14.3 L13.6 16.4 Z"],
    note:   ["M7.8 14.1 V5.1 L15.3 3.5 V12.5",
             "M4 14.1 A1.9 1.6 0 1 0 7.8 14.1 A1.9 1.6 0 1 0 4 14.1",
             "M11.5 12.5 A1.9 1.6 0 1 0 15.3 12.5 A1.9 1.6 0 1 0 11.5 12.5"],
    empty:  ["M2.9 10 A7.1 7.1 0 1 0 17.1 10 A7.1 7.1 0 1 0 2.9 10",
             "M5.4 5.4 L14.6 14.6"]
  };
  function strokeIcon(name, size, width) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("width", String(size || 14));
    svg.setAttribute("height", String(size || 14));
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", String(width || 1.8));
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const d of ICONS[name] || []) {
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  }

  // Friendly names for the bare heights yt-dlp reports, so a row never reads as
  // a lone number: "1080p · Full HD".
  const HEIGHT_NAMES = { 4320: "8K Ultra HD", 2160: "4K Ultra HD", 1440: "2K Quad HD",
                         1080: "Full HD", 720: "HD ready", 480: "Standard",
                         360: "Low data", 240: "Data saver", 144: "Data saver" };

  // A label like "1080p60  FHD", "Audio only (m4a)" or "Best available" is split
  // into a fixed-width tag and a readable name, so the list scans down its left
  // edge instead of being one ragged column of strings. An unrecognisable label
  // gets no tag at all and simply takes the full width.
  function splitLabel(label, q) {
    const raw = String(label == null ? "" : label).replace(/^[⬇↓\s]+/, "").trim();
    if (q && q.course) return { tag: "ALL", name: raw || "Entire course" };
    if (q && q.quality === "best") return { tag: "BEST", name: raw || "Best available" };
    const res = /^(\d{3,4}p(?:\d{2,3})?)\b[\s(]*([^)]*)\)?\s*$/.exec(raw);
    if (res) {
      const rest = (res[2] || "").trim();
      return { tag: res[1], name: rest || HEIGHT_NAMES[parseInt(res[1], 10)] || "Video" };
    }
    const paren = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(raw);
    if (paren && paren[1].trim())
      return { tag: paren[2].trim().toUpperCase().slice(0, 7), name: paren[1].trim() };
    if (/audio/i.test(raw)) return { tag: "AUDIO", name: raw };
    return { tag: "", name: raw };
  }

  function isAudioQuality(q) {
    return /^audio/i.test(q.quality || "") || /\baudio\b/i.test(q.label || "");
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
    if (!panel || !panel.isConnected) {
      panel = el("div", { id: "nexa-panel", role: "dialog", "aria-label": BRAND });
      document.documentElement.appendChild(panel);
    }
  }

  // ---- the Download button ---------------------------------------------
  // IDM's most recognisable touch: a small button floating over the top-right
  // corner of the video the user is actually watching. It shows on hover (like
  // the player's own controls) and flashes once when a page with something
  // downloadable opens, so it can be found without hunting. One element is
  // reused and repositioned rather than one per <video>, so pages that swap
  // players (YouTube, SPAs) stay cheap. The quality panel drops down from it.
  let videoBtn = null;
  let videoBtnTarget = null;
  let videoBtnHideTimer = null;
  let videoBtnDocked = false;   // parked in the corner because the page has no player

  function largestVisibleVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      // Ignore hidden, tiny or off-screen players (ad slots, sprite previews).
      if (r.width < 220 || r.height < 130) continue;
      if (r.bottom <= 0 || r.top >= innerHeight) continue;
      const style = getComputedStyle(v);
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = v; }
    }
    return best;
  }

  // Any sizeable player on the page at all, on screen or not. Decides whether
  // the button belongs on a video (hover) or parked in the corner (no video).
  function anyPlayer() {
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      if (r.width >= 220 && r.height >= 130) return true;
    }
    return false;
  }

  function ensureVideoBtn() {
    if (videoBtn && videoBtn.isConnected) return videoBtn;
    videoBtn = el("div", { id: "nexa-video-btn", role: "button", tabindex: "0",
                           title: BRAND, "aria-label": BRAND }, [
      nexaLogo(14),
      el("span", { class: "nx-label", text: BRAND }),
      (badge = el("span", { class: "nx-badge", text: "" }))
    ]);
    videoBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    });
    // Keep it up while the pointer is on the button itself.
    videoBtn.addEventListener("mouseenter", () => clearTimeout(videoBtnHideTimer));
    videoBtn.addEventListener("mouseleave", () => scheduleVideoBtnHide());
    document.documentElement.appendChild(videoBtn);
    return videoBtn;
  }

  function panelOpen() { return !!(panel && panel.style.display === "block"); }

  // Fade the button out after `delay` ms — unless it is anchoring an open panel
  // or parked in the corner, where it is the only way in.
  function scheduleVideoBtnHide(delay) {
    clearTimeout(videoBtnHideTimer);
    videoBtnHideTimer = setTimeout(() => {
      if (!videoBtn || panelOpen() || videoBtnDocked) return;
      videoBtn.classList.remove("nx-on");
    }, delay == null ? 900 : delay);
  }

  function placeVideoBtnOn(video) {
    const btn = ensureVideoBtn();
    const r = video.getBoundingClientRect();
    btn.style.display = "flex";
    // Top-right of the player, inset so it clears most native control overlays.
    btn.style.left = Math.max(4, Math.round(r.right - btn.offsetWidth - 14)) + "px";
    btn.style.top = Math.max(4, Math.round(r.top + 14)) + "px";
  }

  function positionVideoBtn(video, linger) {
    videoBtnDocked = false;
    videoBtnTarget = video;
    placeVideoBtnOn(video);
    videoBtn.classList.remove("nx-docked");
    videoBtn.classList.add("nx-on");
    clearTimeout(videoBtnHideTimer);
    scheduleVideoBtnHide(linger);
    placePanel();
  }

  // No player to hover: park the button in the top-right corner, persistently.
  function dockVideoBtn() {
    const btn = ensureVideoBtn();
    videoBtnDocked = true;
    videoBtnTarget = null;
    clearTimeout(videoBtnHideTimer);
    btn.style.display = "flex";
    btn.style.left = Math.max(4, Math.round(innerWidth - btn.offsetWidth - 20)) + "px";
    btn.style.top = "20px";
    btn.classList.add("nx-docked", "nx-on");
    placePanel();
  }

  function hideVideoBtn() {
    closePanel();
    if (!videoBtn) return;
    videoBtn.classList.remove("nx-on", "nx-docked");
    videoBtn.style.display = "none";
    videoBtnDocked = false;
  }

  // Put the button on offer for this page, or withdraw it. Called from poll().
  // `canDock` is false on YouTube-style pages, whose player is simply not sized
  // yet on the first ticks — parking in the corner there would only flicker.
  function offer(on, badgeText, canDock) {
    uiActive = on;
    if (!on) { hideVideoBtn(); return; }
    ensureUi();
    ensureVideoBtn();
    if (badge) {
      badge.textContent = badgeText || "";
      badge.classList.toggle("nx-show", !!badgeText);
    }
    const key = location.href;
    if (anyPlayer()) {
      const video = largestVisibleVideo();
      if (video && key !== lastOfferKey) {
        // Flash it once per page so it can be found; after that, hover reveals it.
        lastOfferKey = key;
        positionVideoBtn(video, 3000);
      } else if (video && videoBtn.classList.contains("nx-on")) {
        videoBtnTarget = video;
        placeVideoBtnOn(video);
        placePanel();
      } else if (videoBtnDocked) {
        hideVideoBtn();   // a player has appeared: hover takes over from the corner
      }
    } else if (canDock) {
      dockVideoBtn();
    }
  }

  // Showing on pointer movement over a player keeps the page uncluttered and
  // matches what people expect from a download manager.
  function onPointerOverVideo(e) {
    if (nexaStopped || !uiAllowed || videoBtnDocked) return;
    const video = e.target && e.target.closest ? e.target.closest("video") : null;
    const target = video || largestVisibleVideo();
    if (!target) return;
    // Only react when the pointer is actually within the player's box.
    const r = target.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    // Never jump to another player while the panel is open on this one.
    if (panelOpen() && videoBtnTarget && videoBtnTarget !== target) return;
    positionVideoBtn(target);
  }

  function refreshVideoBtnPosition() {
    if (!videoBtn || !videoBtn.classList.contains("nx-on")) return;
    if (videoBtnDocked) {
      videoBtn.style.left = Math.max(4, Math.round(innerWidth - videoBtn.offsetWidth - 20)) + "px";
      placePanel();
      return;
    }
    if (!videoBtnTarget || !videoBtnTarget.isConnected) { hideVideoBtn(); return; }
    const r = videoBtnTarget.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= innerHeight) { hideVideoBtn(); return; }
    placeVideoBtnOn(videoBtnTarget);
    placePanel();
  }

  document.addEventListener("pointermove", onPointerOverVideo, { passive: true, capture: true });
  addEventListener("scroll", refreshVideoBtnPosition, { passive: true, capture: true });
  addEventListener("resize", refreshVideoBtnPosition, { passive: true });

  // ---- the panel: a dropdown hanging from the button ----------------------
  function openPanel() {
    ensureUi();
    panel.style.display = "block";
    if (videoBtn) {
      videoBtn.classList.add("nx-open", "nx-on");
      clearTimeout(videoBtnHideTimer);
    }
    placePanel();
  }

  function closePanel() {
    if (videoBtn) videoBtn.classList.remove("nx-open");
    if (!panelOpen()) return;
    panel.style.display = "none";
    panel.classList.remove("nx-up");
    if (videoBtn) scheduleVideoBtnHide();
  }

  // Right-align the panel under the button; flip above it when the button is
  // near the bottom of the window; never let it run off the viewport.
  function placePanel() {
    if (!panelOpen()) return;
    const gap = 8, margin = 12;
    const w = panel.offsetWidth || 344;
    const btnShown = videoBtn && videoBtn.style.display !== "none" && videoBtn.classList.contains("nx-on");
    const a = btnShown ? videoBtn.getBoundingClientRect() : null;
    let left, top, up = false;
    if (a && a.width) {
      const below = innerHeight - a.bottom - gap - margin;
      const above = a.top - gap - margin;
      up = below < 240 && above > below;
      const room = Math.max(120, up ? above : below);
      panel.style.maxHeight = Math.min(Math.round(innerHeight * 0.68), room) + "px";
      left = Math.round(a.right - w);
      top = up ? Math.round(a.top - gap - panel.offsetHeight) : Math.round(a.bottom + gap);
    } else {
      panel.style.maxHeight = Math.round(innerHeight * 0.68) + "px";
      left = innerWidth - w - 20;
      top = 64;
    }
    left = Math.max(margin, Math.min(left, innerWidth - w - margin));
    top = Math.max(margin, top);
    panel.style.left = left + "px";
    panel.style.top = top + "px";
    panel.classList.toggle("nx-up", up);
  }

  // Click anywhere else, or Escape, closes it — it is a dropdown, not a window.
  document.addEventListener("pointerdown", (e) => {
    if (!panelOpen()) return;
    const t = e.target;
    if ((panel && panel.contains(t)) || (videoBtn && videoBtn.contains(t))) return;
    closePanel();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panelOpen()) closePanel();
  }, true);

  function toast(msg) {
    let t = document.getElementById("nexa-toast");
    if (!t) {
      t = el("div", { id: "nexa-toast" });
      document.documentElement.appendChild(t);
    }
    t.textContent = msg;
    // Under the button the user just used; top-right when there is none.
    const a = videoBtn && videoBtn.classList.contains("nx-on") ? videoBtn.getBoundingClientRect() : null;
    t.style.left = "";
    t.style.bottom = "";
    if (a && a.width) {
      t.style.right = Math.max(12, Math.round(innerWidth - a.right)) + "px";
      t.style.top = Math.round(a.bottom + 8) + "px";
    } else {
      t.style.right = "20px";
      t.style.top = "20px";
    }
    t.style.display = "block";
    setTimeout(() => { t.style.display = "none"; }, 2200);
  }

  function togglePanel() {
    if (panelOpen()) { closePanel(); return; }
    openPanel();

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

      // Coursera: yt-dlp can't extract its pages, so don't hand off the page URL
      // (that's the "Unsupported URL" error). Instead offer the real video the page
      // is streaming — the MP4/HLS sniffed from its own requests — which downloads
      // via Nexa's normal HTTP/HLS engine. The user grabs lectures one by one.
      if (isCoursera()) {
        renderPanel([{ title: siteTitle(),
                       qualities: [{ label: "Detecting video…" }, { label: "" }] }]);
        sendMessageSafe({ type: "nexa-get-qualities" }, (groups) => {
          if (chrome.runtime.lastError) { renderPanel([]); return; }
          renderPanel(groups && groups.length ? groups : []);
        });
        return;
      }

      // Auth sites (Udemy/…): the -J probe can't see login-gated formats, so offer
      // Best/Audio directly — the handoff carries the cookies.
      if (isAuthSite()) {
        // "Entire course" sends the current lecture page URL with the playlist
        // flag; the engine normalises it to yt-dlp's /<slug>/ course URL so the
        // extractor can enumerate every lecture. NOTE: DRM-protected lectures
        // can't be downloaded by yt-dlp, so a DRM course yields only its
        // non-DRM (plain) videos.
        const onLecture = /\/learn\/(?:v4\/t\/)?lecture\//.test(location.pathname)
                          || /(?:^|\/)lecture\/\d+/.test(location.hash);
        const quals = [];
        if (onLecture)
          quals.push({ label: "⬇  Entire course — all lectures", quality: "best",
                       meta: "every video", course: true, name: courseTitle() });
        quals.push({ label: onLecture ? "This lecture only" : "Best available",
                     quality: "best", meta: "video + audio" });
        quals.push({ label: "Audio only (m4a)", quality: "audio:m4a", meta: "" });
        renderPanel(withPlaylist({ title: siteTitle(), name: dlName, site: true,
                                   url: vurl, qualities: quals }));
        return;
      }

      // YouTube + public sites: ask the engine (yt-dlp -J) for REAL qualities.
      renderPanel(withPlaylist({ title: siteTitle(),
                                 qualities: [{ label: "Loading qualities…" }, { label: "" }] }));
      sendMessageSafe({ type: "nexa-list-formats", url: vurl }, (r) => {
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
          // Audio formats: use real per-format list when available, else fallbacks
          if (Array.isArray(r.audioFormats) && r.audioFormats.length) {
            for (const af of r.audioFormats)
              quals.push({ label: af.label, quality: af.quality, meta: "m4a" });
          } else {
            quals.push({ label: "Audio only (m4a)", quality: "audio:m4a", meta: "" });
          }
        } else {
          quals = YT_QUALITIES.map((q) => ({ label: q.label, quality: q.quality, meta: q.meta }));
        }
        renderPanel(withPlaylist({ title: siteTitle(), name: dlName, site: true,
                                   url: vurl, qualities: quals }));
      });
      return;
    }
    renderPanel([{ title: "Checking this page…",
                   qualities: [{ label: "Looking for media…" }, { label: "" }] }]);
    sendMessageSafe({ type: "nexa-get-qualities" }, (groups) => {
      if (chrome.runtime.lastError) { renderPanel([]); return; }
      renderPanel(groups || []);
    });
  }

  function renderPanel(groups) {
    // aria-label rather than title: a native OS tooltip over a floating panel
    // reads as a stray browser artefact.
    const close = el("span", { class: "nx-close", role: "button", tabindex: "0",
                               "aria-label": "Close" }, [strokeIcon("close", 14)]);
    close.addEventListener("click", closePanel);
    close.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); closePanel(); }
    });
    const head = el("div", { class: "nx-head" }, [
      el("div", { class: "nx-brand" }, [
        nexaLogo(17),
        el("span", { class: "nx-brand-text", text: BRAND })
      ]),
      close
    ]);

    const frag = document.createDocumentFragment();
    frag.appendChild(head);

    if (!groups.length) {
      frag.appendChild(el("div", { class: "nx-empty" }, [
        strokeIcon("empty", 30, 1.5),
        el("span", { text: "Nothing downloadable here yet" }),
        el("span", { class: "nx-sub",
                     text: "Start the video playing, then open this panel again." })
      ]));
    }

    groups.forEach((g) => {
      const quals = g.qualities || [];
      // A quality with neither a URL nor a selector is a placeholder
      // ("Loading qualities…") — it renders as a shimmer, not a button.
      const ready = (q) => !!(q.url || q.quality);
      const pickable = quals.filter(ready);
      // Only label the Video / Audio runs when both are actually on offer.
      const split = pickable.some(isAudioQuality) && pickable.some((q) => !isAudioQuality(q));
      // A sniffed .mp3 has no "audio" anywhere in its quality label — its name is
      // the only tell, and it is enough to pick the right glyph.
      const audioOnly = !!pickable.length
        && (pickable.every(isAudioQuality)
            || /\.(mp3|m4a|aac|opus|flac|ogg|wav)(\?|#|$)/i.test(g.title || ""));

      const media = el("div", { class: "nx-media" }, [
        el("div", { class: "nx-mhead" }, [
          strokeIcon(g.playlist ? "list" : (audioOnly ? "note" : "film"), 15),
          el("div", { class: "nx-title", title: g.title || "Video", text: g.title || "Video" }),
          pickable.length > 1
            ? el("span", { class: "nx-chip", text: pickable.length + " formats" })
            : null
        ])
      ]);
      if (!quals.length) {
        media.appendChild(el("div", { class: "nx-hint", text: "No formats offered." }));
      }
      // Collect the qualities into runs (video, then audio). A run carries the
      // detail every one of its rows shares — "video + audio" spelled out on all
      // eight rows is noise; once, as the run's column head, it is information.
      const runs = [];
      quals.forEach((q) => {
        const kind = !ready(q) ? "wait" : (isAudioQuality(q) ? "audio" : "video");
        const last = runs[runs.length - 1];
        if (last && last.kind === kind) last.items.push(q);
        else runs.push({ kind, items: [q] });
      });

      runs.forEach((run) => {
        const metas = new Set(run.items.map((q) => q.meta || ""));
        const shared = run.kind !== "wait" && run.items.length > 1
                       && metas.size === 1 && !metas.has("") ? run.items[0].meta : "";
        if (run.kind !== "wait" && (split || shared)) {
          media.appendChild(el("div", { class: "nx-sec" }, [
            el("span", { class: "nx-seclabel",
                         text: run.kind === "audio" ? "Audio only" : "Video" }),
            shared ? el("span", { class: "nx-secnote", text: shared }) : null
          ]));
        }
        run.items.forEach((q) => {
          const live = ready(q);
          const audio = run.kind === "audio";
          const parts = splitLabel(q.label, q);
          let tag = parts.tag, meta = shared ? "" : (q.meta || "");
          if (!tag && /^\S{1,6}$/.test(meta)) { tag = meta.toUpperCase(); meta = ""; }
          const row = el("div", {
            class: "nx-q" + (live ? "" : " nx-skel") + (audio ? " nx-audio" : "")
                   + (live && q.quality === "best" && !q.course ? " nx-best" : ""),
            role: live ? "button" : null,
            tabindex: live ? "0" : null,
            data: { url: q.url || "", quality: q.quality || "", name: q.name || g.name || "",
                    plurl: g.playlist ? (g.playlistUrl || "") : "",
                    siteurl: g.url || "", course: q.course ? "1" : "" }
          }, [
            tag || !live ? el("span", { class: "nx-tag", text: tag }) : null,
            el("span", { class: "nx-name", title: parts.name, text: parts.name }),
            meta ? el("span", { class: "nx-meta", text: meta }) : null,
            g.playlist && live
              ? el("span", { class: "nx-dl", text: "Download all" })
              : el("span", { class: "nx-go" }, [strokeIcon("arrow", 13)])
          ]);
          // Only wire a download click for real, selectable qualities.
          if (live) {
            const activate = () => {
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
                    closePanel();
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
                // Replace the CDN blob name with a real title (song / lecture). Keep the
                // file's own extension when it has one; Spotify previews are
                // extensionless MP3s, so fall back to a per-site default.
                let nice = "", defExt = "";
                if (isAppleMusicPage())   { nice = appleMusicName();      defExt = "m4a"; }
                else if (isSpotifyPage()) { nice = spotifyName();         defExt = "mp3"; }
                else if (isCoursera())    { nice = courseraLectureName(); defExt = "";    }
                if (nice) {
                  const ext = (/\.([a-z0-9]{1,5})(?:\?|#|$)/i.exec(row.dataset.url || "") || [])[1] || defExt;
                  msg.filename = ext ? `${nice}.${ext}` : nice;
                }
              }
              closePanel();
              toast("Sending to Nexa…");
              // Report the REAL handoff result. The background worker relays the
              // native-host reply, so a missing host / dead engine surfaces here
              // instead of a misleading success toast.
              sendMessageSafe(msg, (r) => {
                if (chrome.runtime.lastError || !r || r.ok === false) {
                  const why = (r && r.message) ||
                    (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
                    "engine unavailable";
                  toast("Nexa: " + why);
                } else {
                  toast("Sent to Nexa ✓");
                }
              });
            };
            row.addEventListener("click", activate);
            row.addEventListener("keydown", (e) => {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
            });
          }
          media.appendChild(row);
        });
      });
      frag.appendChild(media);
    });

    panel.replaceChildren(frag);
    placePanel();   // the content just changed height
  }

  // ---- poll the background worker for detected media count -------------
  // Warm the quality cache as soon as a public/YouTube video page is detected,
  // so opening the panel shows qualities instantly instead of "Loading qualities…".
  // The expensive yt-dlp -J probe runs in the background during page viewing; by
  // the time the user clicks, it's a cache hit (best case: O(1), instant).
  // Auth sites are skipped (their formats are login-gated and offered directly).
  // Deduped per URL and debounced so quickly skimming past videos doesn't fire a
  // burst of probes.
  function maybePrefetch() {
    if (!isSiteVideo() || isAuthSite()) return;
    const vurl = videoUrl();
    if (!vurl || vurl === prefetchedUrl || vurl === prefetchArmedUrl) return;
    prefetchArmedUrl = vurl;
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => {
      if (videoUrl() !== vurl) return;          // navigated away while waiting
      prefetchedUrl = vurl;
      sendMessageSafe({ type: "nexa-prefetch-formats", url: vurl },
                                 () => void chrome.runtime.lastError);
    }, 1200);
  }

  function poll() {
    if (nexaStopped || !extAlive()) { shutdown(); return; }
    // Button switched off in the options page, or this site is paused.
    if (!uiAllowed) {
      offer(false);
      syncPolling();
      return;
    }
    // YouTube & co: always offer the button (streams can't be sniffed). On a
    // dedicated playlist page there's no single video, but the playlist is still
    // downloadable, so offer it there too (parked in the corner: no player).
    if (showPill()) {
      offer(true, (isPlaylistPage() || playlistId()) ? "PL" : "", isPlaylistPage());
      maybePrefetch();   // warm the quality cache in the background
      syncPolling();
      return;
    }
    // Everything else: offer the button only when the worker has sniffed media,
    // with the count as its badge when there is more than one item to choose.
    sendMessageSafe({ type: "nexa-media-count" }, (info) => {
      if (chrome.runtime.lastError || !info) { syncPolling(); return; }
      const count = info.count || 0;
      offer(count > 0, count > 1 ? String(count) : "", true);
      // Refresh an open panel if the media set changed.
      const sig = info.signature || "";
      if (count > 0 && panelOpen() && sig !== lastSignature) {
        closePanel();   // force a clean re-open (re-render) regardless of toggle parity
        togglePanel();
      }
      lastSignature = sig;
      syncPolling();
    });
  }

  // ---- polling lifecycle --------------------------------------------------
  // The 2 s interval runs ONLY while a download is on offer on a visible tab —
  // that is the only time a media set or SPA URL can change under the user's
  // nose. Pages without media and background tabs cost nothing: the worker
  // pushes "nexa-media-changed" when it sniffs new media, the navigation hooks
  // below re-run poll() on URL changes, and visibilitychange resumes it.
  function syncPolling() {
    const want = !nexaStopped && uiAllowed && uiActive
                 && document.visibilityState === "visible";
    if (want && !pollTimer) {
      pollTimer = setInterval(() => { if (nexaStopped) return; onNav(); poll(); }, 2000);
    } else if (!want && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ---- settings (storage.local, written by the popup / options page) -----
  // showFloatingButton: the options switch for the button. disabledHosts:
  // "Pause on this site" list — exact host or any subdomain of an entry.
  function hostPaused(list) {
    const h = location.hostname.toLowerCase();
    return (Array.isArray(list) ? list : []).some((raw) => {
      let d = String(raw || "").trim().toLowerCase();
      if (/^[a-z][a-z0-9+.-]*:\/\//.test(d)) { try { d = new URL(d).hostname; } catch (_) { return false; } }
      else d = d.split(/[/?#]/)[0];
      d = d.replace(/^\*?\.+/, "").replace(/\.+$/, "").replace(/:\d+$/, "");
      return !!d && (h === d || h.endsWith("." + d));
    });
  }
  function refreshSettings(then) {
    if (nexaStopped || !extAlive()) { shutdown(); return; }
    try {
      chrome.storage.local.get({ showFloatingButton: true, disabledHosts: [] }, (v) => {
        if (!chrome.runtime.lastError && v)
          uiAllowed = v.showFloatingButton !== false && !hostPaused(v.disabledHosts);
        if (then) then();
      });
    } catch (_) { if (then) then(); }
  }
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || nexaStopped) return;
      if (changes.showFloatingButton || changes.disabledHosts) refreshSettings(poll);
    });
  } catch (_) {}

  // Links for the popup / context-menu grabber. The background dedupes, drops
  // non-http(s) URLs, caps the list and sends ONE `links` message to the app.
  const MAX_COLLECTED = 4000;
  function collectLinks(media) {
    const links = [];
    const seen = new Set();
    const push = (url, text, kind) => {
      if (links.length >= MAX_COLLECTED) return;
      const u = String(url || "");
      if (!/^https?:\/\//i.test(u) || seen.has(u)) return;
      seen.add(u);
      links.push({ url: u, text: String(text || "").replace(/\s+/g, " ").trim().slice(0, 200), kind });
    };
    if (!media) {
      for (const a of document.querySelectorAll("a[href]"))
        push(a.href, a.textContent || a.getAttribute("title") || a.getAttribute("aria-label") || "", "link");
    } else {
      for (const img of document.querySelectorAll("img"))
        push(img.currentSrc || img.src, img.alt || img.title || "", "image");
      for (const m of document.querySelectorAll("video, audio, video source, audio source"))
        push(m.currentSrc || m.src, m.title || "", "media");
    }
    return { pageUrl: location.href, pageTitle: document.title || "", links };
  }

  // Re-poll immediately whenever the URL changes (YouTube is a single-page app,
  // so navigating to a video never reloads the document or re-injects this
  // script). We watch three signals: YouTube's own navigation event, the
  // history API, and a cheap href diff on each interval tick.
  function onNav() {
    if (nexaStopped) return;
    if (location.href === lastHref) return;
    lastHref = location.href;
    closePanel();          // stale panel from the old video
    lastOfferKey = "";     // the new video gets its own introductory flash
    poll();
  }
  window.addEventListener("yt-navigate-finish", () => setTimeout(onNav, 0), true);
  document.addEventListener("yt-page-data-updated", () => setTimeout(onNav, 0), true);
  window.addEventListener("popstate", () => setTimeout(onNav, 0));
  // Patch history ONCE per page. The content script can be re-injected on SPA
  // navigations; without this guard the wrappers stack and onNav fires N times.
  if (!history.__nexaPatched) {
    history.__nexaPatched = true;
    for (const m of ["pushState", "replaceState"]) {
      const orig = history[m];
      history[m] = function () {
        const r = orig.apply(this, arguments);
        setTimeout(onNav, 0);
        return r;
      };
    }
  }

  // Messages from the background worker: link collection, media pushes and
  // renderer-owned (blob:/data:) downloads.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Only honour messages from our own extension (the background worker).
    if (!sender || sender.id !== chrome.runtime.id) return;
    if (msg.type === "nexa-collect-links") {
      sendResponse(collectLinks(msg.mode === "media"));
      return false;
    } else if (msg.type === "nexa-media-changed") {
      // The worker sniffed new media on this tab: show/update the button now
      // instead of waiting for a poll tick.
      if (!nexaStopped) poll();
      return false;
    } else if (msg.type === "nexa-browser-download") {
      const requested = String(msg.url || "");
      const sameUrl = (a) => {
        const raw = a.getAttribute("href") || "";
        return raw === requested || a.href === requested;
      };
      let anchor = Array.from(document.querySelectorAll("a[href]"))
        .find((a) => sameUrl(a));

      // blob:/data: objects are scoped to this renderer. If the context-menu
      // target is not wrapped in an anchor, create one here so Chrome/Firefox
      // still perform the download in the browser rather than sending the
      // unsupported scheme to the desktop process.
      if (!anchor && /^(?:blob|data):/i.test(requested)) {
        anchor = document.createElement("a");
        anchor.href = requested;
        anchor.download = sanitizeName(msg.filename) || "download";
        anchor.style.display = "none";
        document.documentElement.appendChild(anchor);
      }
      if (!anchor) {
        if (sendResponse)
          sendResponse({ ok: false, message: "the browser-owned file link is no longer on this page" });
        return;
      }
      if (sendResponse) sendResponse({ ok: true, browser: true });
      anchor.click();
      if (anchor.parentNode && /^(?:blob|data):/i.test(requested))
        setTimeout(() => anchor.remove(), 1000);
    }
    return true;
  });

  // A hidden tab never polls; coming back re-evaluates once and resumes if a
  // download is still on offer.
  document.addEventListener("visibilitychange", () => {
    if (nexaStopped) return;
    if (document.visibilityState === "visible") { onNav(); poll(); }
    else syncPolling();
  });

  refreshSettings(() => {
    poll();
    setTimeout(poll, 600);    // media sniffed while the page was still loading
    setTimeout(poll, 2000);   // a player that took its time to size itself
  });
})();
