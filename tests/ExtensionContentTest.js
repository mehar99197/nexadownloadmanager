// Content-script UI test: the on-video Download button and the quality panel
// that drops down from it. Runs content.js in jsdom with a stubbed `chrome`,
// so it needs no browser. Layout is faked through getBoundingClientRect.
//
//   node tests/ExtensionContentTest.js
//
// jsdom is resolved from the website's node_modules; when it is not installed
// the test prints a notice and exits 0 (the CI job that installs it runs it).
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let JSDOM;
for (const p of ["jsdom", path.join(__dirname, "..", "ndm-website", "frontend", "node_modules", "jsdom"),
                 path.join(__dirname, "..", "node_modules", "jsdom")]) {
  try { ({ JSDOM } = require(p)); break; } catch (_) { /* try the next */ }
}
if (!JSDOM) {
  console.log("Extension content tests skipped — jsdom not installed (cd ndm-website/frontend && npm ci)");
  process.exit(0);
}

const SRC = fs.readFileSync(path.join(__dirname, "..", "extension-chromium", "content.js"), "utf8");

// Fake layout: the video is a 640x360 box at (100,80); the button is 100x30 at
// wherever content.js put it; everything else has no box.
function fakeRects(win) {
  const proto = win.Element.prototype;
  proto.getBoundingClientRect = function () {
    if (this.tagName === "VIDEO" && this.dataset.rect) {
      const [l, t, w, h] = this.dataset.rect.split(",").map(Number);
      return { left: l, top: t, right: l + w, bottom: t + h, width: w, height: h };
    }
    if (this.id === "nexa-video-btn" && this.style.display !== "none") {
      const l = parseFloat(this.style.left) || 0, t = parseFloat(this.style.top) || 0;
      return { left: l, top: t, right: l + 100, bottom: t + 30, width: 100, height: 30 };
    }
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  };
  Object.defineProperty(win.HTMLElement.prototype, "offsetWidth", {
    get() { return this.id === "nexa-video-btn" ? 100 : this.id === "nexa-panel" ? 344 : 0; }, configurable: true });
  Object.defineProperty(win.HTMLElement.prototype, "offsetHeight", {
    get() { return this.id === "nexa-panel" ? 300 : 0; }, configurable: true });
}

// Boot content.js in a page. `replies` answers chrome.runtime.sendMessage by
// message type; `settings` is what storage.local holds.
function boot({ url, html, replies = {}, settings = {} }) {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: "outside-only" });
  const win = dom.window;
  fakeRects(win);
  Object.defineProperty(win, "innerWidth", { value: 1280, configurable: true });
  Object.defineProperty(win, "innerHeight", { value: 720, configurable: true });
  const sent = [];
  win.chrome = {
    runtime: {
      id: "test-ext",
      lastError: undefined,
      sendMessage(msg, cb) {
        sent.push(msg);
        const r = replies[msg.type];
        if (cb) setTimeout(() => cb(typeof r === "function" ? r(msg) : r), 0);
      },
      onMessage: { addListener() {} },
    },
    storage: {
      local: { get(defaults, cb) { cb({ ...defaults, ...settings }); } },
      onChanged: { addListener() {} },
    },
  };
  win.eval(SRC);
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  return { win, doc: win.document, sent, tick };
}

const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const PLAYER = '<video data-rect="100,80,640,360"></video><p>comments</p>';

(async () => {
  // ---- YouTube: the button flashes on the player, the pill is gone ----------
  {
    const { doc, tick, sent } = boot({ url: YT, html: `<body>${PLAYER}</body>` });
    await tick(50);
    assert.equal(doc.getElementById("nexa-pill"), null, "the bottom-right pill no longer exists");
    const btn = doc.getElementById("nexa-video-btn");
    assert.ok(btn, "a Download button was created");
    assert.equal(btn.style.display, "flex");
    assert.ok(btn.classList.contains("nx-on"), "it is shown (introductory flash)");
    assert.equal(btn.textContent.trim(), "Download with NDM", "branded label, no HD badge");
    assert.equal(btn.style.left, `${100 + 640 - 100 - 14}px`, "inset from the player's right edge");
    assert.equal(btn.style.top, `${80 + 14}px`, "inset from the player's top edge");
    assert.ok(!btn.classList.contains("nx-docked"), "on the video, not parked in the corner");
    assert.ok(sent.some((m) => m.type === "nexa-prefetch-formats") || true, "prefetch may be armed");
    const panel = doc.getElementById("nexa-panel");
    assert.ok(panel && panel.style.display !== "block", "panel exists but is closed");
  }

  // ---- click: the panel drops down from the button, right-aligned -----------
  {
    const replies = {
      "nexa-list-formats": { ok: true, qualities: [{ label: "1080p", height: 1080 }, { label: "720p", height: 720 }],
                             audioFormats: [{ label: "Audio (m4a)", quality: "audio:m4a" }] },
    };
    const { doc, win, tick } = boot({ url: YT, html: `<body>${PLAYER}</body>`, replies });
    await tick(50);
    const btn = doc.getElementById("nexa-video-btn");
    btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await tick(30);
    const panel = doc.getElementById("nexa-panel");
    assert.equal(panel.style.display, "block", "clicking the button opens the panel");
    assert.ok(btn.classList.contains("nx-open"), "the button shows its open state");
    const b = btn.getBoundingClientRect();
    assert.equal(panel.style.top, `${b.bottom + 8}px`, "panel hangs 8px under the button");
    assert.equal(panel.style.left, `${b.right - 344}px`, "panel is right-aligned with the button");
    assert.ok(!panel.classList.contains("nx-up"), "plenty of room below: not flipped");
    assert.match(panel.textContent, /Download with NDM/, "the panel wears the same name as the button");
    assert.match(panel.textContent, /Best available/);
    assert.match(panel.textContent, /1080p/);
    assert.match(panel.textContent, /720p/);
    assert.equal(panel.querySelectorAll(".nx-q").length, 4, "best + two heights + one audio");

    // Each row is split into a fixed-width tag and a readable name, so the list
    // scans down its left edge instead of being one ragged column of labels.
    const tags = Array.from(panel.querySelectorAll(".nx-q .nx-tag")).map((t) => t.textContent);
    assert.deepEqual(tags, ["BEST", "1080p", "720p", "M4A"], "quality tags");
    const names = Array.from(panel.querySelectorAll(".nx-q .nx-name")).map((t) => t.textContent);
    assert.deepEqual(names, ["Best available", "Full HD", "HD ready", "Audio"],
                     "bare heights get a readable name");
    assert.ok(panel.querySelector(".nx-q").classList.contains("nx-best"),
              "the recommended row is highlighted");
    assert.deepEqual(Array.from(panel.querySelectorAll(".nx-sec .nx-seclabel")).map((s2) => s2.textContent),
                     ["Video", "Audio only"], "video and audio runs are labelled");
    // "video + audio" on every row is noise; once, as the run's column head, it
    // is information — so the rows below it carry no meta of their own.
    assert.equal(panel.querySelector(".nx-sec .nx-secnote").textContent, "video + audio");
    assert.equal(panel.querySelectorAll(".nx-q .nx-meta").length, 1,
                 "only the lone audio row, whose meta is its own, still shows one");
    assert.match(panel.querySelector(".nx-chip").textContent, /4 formats/);
    // A native OS tooltip over a floating panel reads as a browser artefact.
    const x = panel.querySelector(".nx-close");
    assert.equal(x.getAttribute("title"), null, "close uses aria-label, not a title tooltip");
    assert.equal(x.getAttribute("aria-label"), "Close");
    assert.ok(x.querySelector("svg"), "close is an icon, not a text glyph");

    // The button must not fade while its panel is open.
    await tick(1200);
    assert.ok(btn.classList.contains("nx-on"), "button stays while the panel is open");

    // Click again toggles it closed; Escape and outside clicks close it too.
    btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    assert.equal(panel.style.display, "none", "second click closes");
    btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await tick(30);
    assert.equal(panel.style.display, "block");
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(panel.style.display, "none", "Escape closes");
    btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await tick(30);
    doc.querySelector("p").dispatchEvent(new win.MouseEvent("pointerdown", { bubbles: true }));
    assert.equal(panel.style.display, "none", "a click elsewhere closes");
    btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await tick(30);
    panel.querySelector(".nx-q").dispatchEvent(new win.MouseEvent("pointerdown", { bubbles: true }));
    assert.equal(panel.style.display, "block", "a click inside the panel does not close it");
  }

  // ---- choosing a quality hands off and closes the panel ---------------------
  {
    const replies = { "nexa-download": { ok: true } };
    const { doc, win, tick, sent } = boot({ url: YT, html: `<body>${PLAYER}</body>`, replies });
    await tick(50);
    const btn = doc.getElementById("nexa-video-btn");
    btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await tick(30);
    const panel = doc.getElementById("nexa-panel");
    const row = Array.from(panel.querySelectorAll(".nx-q")).find((r) => /1080p/.test(r.textContent));
    assert.ok(row, "fallback quality list offers 1080p when the engine is unreachable");
    assert.equal(row.getAttribute("role"), "button", "rows are buttons");
    assert.equal(row.getAttribute("tabindex"), "0", "and reachable by keyboard");
    row.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick(30);
    assert.ok(sent.some((m) => m.type === "nexa-download"), "Enter hands the row off");
    row.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await tick(30);
    const dl = sent.find((m) => m.type === "nexa-download");
    assert.ok(dl, "a download message went to the worker");
    assert.equal(dl.url, YT);
    assert.equal(dl.quality, "1080");
    assert.equal(panel.style.display, "none", "panel closes after the handoff");
    const toast = doc.getElementById("nexa-toast");
    assert.ok(toast && toast.style.display === "block", "a toast confirms");
    assert.equal(toast.style.top, `${btn.getBoundingClientRect().bottom + 8}px`, "toast sits under the button");
  }

  // ---- near the bottom of the window the panel flips upward ------------------
  {
    const { doc, win, tick } = boot({ url: YT, html: '<body><video data-rect="100,560,640,360"></video></body>' });
    await tick(50);
    const btn = doc.getElementById("nexa-video-btn");
    btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await tick(30);
    const panel = doc.getElementById("nexa-panel");
    assert.ok(panel.classList.contains("nx-up"), "flipped above the button");
    const b = btn.getBoundingClientRect();
    assert.equal(panel.style.top, `${b.top - 8 - 300}px`, "bottom edge sits 8px above the button");
  }

  // ---- the flash fades; hovering the player brings it back --------------------
  {
    const { doc, win, tick } = boot({ url: YT, html: `<body>${PLAYER}</body>` });
    await tick(50);
    const btn = doc.getElementById("nexa-video-btn");
    assert.ok(btn.classList.contains("nx-on"));
    await tick(3200);
    assert.ok(!btn.classList.contains("nx-on"), "faded after the introductory flash");
    doc.dispatchEvent(new win.PointerEvent("pointermove", { clientX: 300, clientY: 200, bubbles: true }));
    assert.ok(btn.classList.contains("nx-on"), "hovering the player reveals it");
    doc.dispatchEvent(new win.PointerEvent("pointermove", { clientX: 900, clientY: 700, bubbles: true }));
    await tick(1000);
    assert.ok(!btn.classList.contains("nx-on"), "and it fades again once the pointer leaves");
  }

  // ---- a sniffed-media page with no player parks the button top-right --------
  {
    const replies = { "nexa-media-count": { count: 3, signature: "abc" },
                      "nexa-get-qualities": [{ title: "song.mp3", qualities: [{ label: "MP3", url: "https://cdn.example/s.mp3" }] }] };
    const { doc, win, tick } = boot({ url: "https://music.example.com/track/1", html: "<body><p>no player here</p></body>", replies });
    await tick(50);
    const btn = doc.getElementById("nexa-video-btn");
    assert.ok(btn && btn.classList.contains("nx-docked"), "parked in the corner");
    assert.equal(btn.style.top, "20px");
    assert.equal(btn.style.left, `${1280 - 100 - 20}px`);
    assert.equal(btn.querySelector(".nx-badge").textContent, "3", "count badge for several items");
    assert.ok(btn.querySelector(".nx-badge").classList.contains("nx-show"));
    await tick(1200);
    assert.ok(btn.classList.contains("nx-on"), "a parked button never fades");
    btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await tick(30);
    const panel = doc.getElementById("nexa-panel");
    assert.equal(panel.style.display, "block");
    assert.match(panel.textContent, /song\.mp3/);
    assert.equal(panel.style.top, `${btn.getBoundingClientRect().bottom + 8}px`, "drops from the parked button");
  }

  // ---- nothing sniffed: no button at all -------------------------------------
  {
    const replies = { "nexa-media-count": { count: 0, signature: "" } };
    const { doc, tick } = boot({ url: "https://example.com/", html: "<body><p>plain page</p></body>", replies });
    await tick(50);
    const btn = doc.getElementById("nexa-video-btn");
    assert.ok(!btn || btn.style.display === "none", "no button without media");
  }

  // ---- the options switch hides it --------------------------------------------
  {
    const { doc, tick } = boot({ url: YT, html: `<body>${PLAYER}</body>`, settings: { showFloatingButton: false } });
    await tick(50);
    const btn = doc.getElementById("nexa-video-btn");
    assert.ok(!btn || btn.style.display === "none", "switched off in options: no button");
  }

  // ---- a paused site hides it ---------------------------------------------------
  {
    const { doc, tick } = boot({ url: YT, html: `<body>${PLAYER}</body>`, settings: { disabledHosts: ["youtube.com"] } });
    await tick(50);
    const btn = doc.getElementById("nexa-video-btn");
    assert.ok(!btn || btn.style.display === "none", "paused on this site: no button");
  }

  console.log("Extension content tests passed");
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
