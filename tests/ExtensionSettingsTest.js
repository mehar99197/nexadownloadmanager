// Settings + link-grabber tests for both browser extensions.
// Run with: node tests/ExtensionSettingsTest.js
//
// Loads each background.js in a vm sandbox with a stub browser API and reaches
// into its pure helpers (disabled-host matching, size gating, intercept-type
// matching, links payload building) plus the native-message plumbing for
// `ping` and `links`, and the right-click menu it installs.

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const MB = 1024 * 1024;

// Values built inside the vm sandbox carry that realm's Array/Object
// prototypes, which strict deepEqual rejects — compare structurally.
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const deepEq = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message);

function listener() {
  return { addListener() {} };
}

// Records every native message and answers with a canned reply. Context-menu
// items and the install / menu-click listeners are kept so tests can fire them.
function browserApi(native) {
  const noOp = listener();
  return {
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    commands: { onCommand: noOp },
    contextMenus: {
      create(item) { native.menus.push(item); },
      onClicked: { addListener(fn) { native.menuClicked.push(fn); } },
    },
    cookies: { getAll: async () => [] },
    downloads: { onCreated: noOp, cancel: async () => {}, erase: async () => {} },
    notifications: { create: async () => "id" },
    runtime: {
      id: "test-extension",
      lastError: null,
      onInstalled: { addListener(fn) { native.installed.push(fn); } },
      onStartup: noOp,
      onMessage: noOp,
      getURL: (p) => "chrome-extension://test-extension/" + p,
      getManifest: () => ({ version: "0.2.0" }),
      sendNativeMessage(host, payload, cb) {
        native.sent.push({ host, payload });
        cb(native.reply(payload));
      },
    },
    scripting: { executeScript: async () => [] },
    storage: {
      local: {
        get(defaults, cb) { cb(Object.assign({}, defaults, native.local)); },
        set(values, cb) { Object.assign(native.local, values); if (cb) cb(); },
      },
      onChanged: noOp,
      session: {
        get(_keys, cb) { if (cb) { cb({}); return undefined; } return Promise.resolve({}); },
        set(_values, cb) { if (cb) cb(); },
        remove() {},
      },
    },
    tabs: {
      onRemoved: noOp,
      onUpdated: noOp,
      query: async () => [],
      get: async () => null,
      sendMessage: async (_tabId, msg) => native.content(msg),
    },
    webRequest: {
      onBeforeRequest: noOp,
      onBeforeSendHeaders: noOp,
      onHeadersReceived: noOp,
    },
  };
}

function loadExtension(relativePath, native) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8") + `
globalThis.__nexaTest = {
  SETTINGS_DEFAULTS, DEFAULT_INTERCEPT_TYPES, MAX_LINKS,
  normalizeSettings, normalizeHostEntry, isHostDisabled,
  passesMinSize, downloadSizeOf, matchesInterceptType,
  buildLinksPayload, pingEngine, grabLinks,
};
`;
  const sandbox = {
    chrome: browserApi(native),
    console,
    URL,
    Map,
    Set,
    Object,
    Array,
    Date,
    Math,
    Number,
    Promise,
    String,
    RegExp,
    JSON,
    decodeURIComponent,
    navigator: { userAgent: "Nexa test" },
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(source, sandbox, { filename: relativePath });
  return sandbox.__nexaTest;
}

function testDisabledHosts(api, tag) {
  const { isHostDisabled, normalizeHostEntry, normalizeSettings } = api;
  const hosts = ["example.com", "Downloads.Corp.Net/", "https://cdn.site.org/x?y=1", ".dotted.io", "*.wild.dev"];
  const yes = [
    "example.com", "EXAMPLE.com", "https://example.com/file.zip", "sub.example.com",
    "https://deep.sub.example.com/", "https://example.com",           // origin form
    "downloads.corp.net", "a.downloads.corp.net",
    "cdn.site.org", "x.dotted.io", "wild.dev", "a.wild.dev",
  ];
  const no = [
    "evilexample.com", "example.com.evil.net", "corp.net",            // parent of an entry is NOT paused
    "site.org", "notdotted.io", "", "https://",
  ];
  for (const h of yes) assert.equal(isHostDisabled(h, hosts), true, `${tag}: ${h} must be paused`);
  for (const h of no) assert.equal(isHostDisabled(h, hosts), false, `${tag}: ${h} must NOT be paused`);
  assert.equal(isHostDisabled("example.com", []), false, `${tag}: empty list`);
  assert.equal(isHostDisabled("example.com", null), false, `${tag}: missing list`);
  assert.equal(isHostDisabled("example.com", ["", "   ", "bad host!"]), false, `${tag}: junk entries ignored`);

  assert.equal(normalizeHostEntry(" HTTPS://WWW.Example.COM:8443/path "), "www.example.com", tag);
  assert.equal(normalizeHostEntry("*.foo.bar"), "foo.bar", tag);
  assert.equal(normalizeHostEntry("foo.bar."), "foo.bar", tag);
  assert.equal(normalizeHostEntry("not a host"), "", tag);
  assert.equal(normalizeHostEntry(null), "", tag);
  deepEq(normalizeSettings({ disabledHosts: ["A.com", "a.com", "", "bad host", "b.org/p"] }).disabledHosts,
                   ["a.com", "b.org"], `${tag}: disabledHosts normalised + deduped`);
}

function testMinSize(api, tag) {
  const { passesMinSize, downloadSizeOf } = api;
  assert.equal(passesMinSize(1, 0), true, `${tag}: 0 = every size`);
  assert.equal(passesMinSize(-1, 0), true, tag);
  assert.equal(passesMinSize(5 * MB, 10), false, `${tag}: 5 MB < 10 MB stays in the browser`);
  assert.equal(passesMinSize(10 * MB, 10), true, `${tag}: exactly the minimum is taken over`);
  assert.equal(passesMinSize(10 * MB + 1, 10), true, tag);
  assert.equal(passesMinSize(-1, 10), true, `${tag}: unknown size (-1) is taken over`);
  assert.equal(passesMinSize(0, 10), true, `${tag}: unknown size (0) is taken over`);
  assert.equal(passesMinSize(NaN, 10), true, tag);
  assert.equal(passesMinSize(undefined, 10), true, tag);
  assert.equal(passesMinSize("20971520", "10"), true, `${tag}: numeric strings`);
  assert.equal(passesMinSize("1048576", "10"), false, tag);
  assert.equal(passesMinSize(5 * MB, "abc"), true, `${tag}: junk minimum = no gate`);
  assert.equal(passesMinSize(5 * MB, -3), true, tag);
  assert.equal(passesMinSize(0.6 * MB, 0.5), true, `${tag}: fractional MB`);

  assert.equal(downloadSizeOf({ fileSize: -1, totalBytes: 0 }), -1, `${tag}: Chrome's unknown-size item`);
  assert.equal(downloadSizeOf({ fileSize: 123 }), 123, tag);
  assert.equal(downloadSizeOf({ fileSize: -1, totalBytes: 456 }), 456, tag);
  assert.equal(downloadSizeOf({ fileSize: 999, totalBytes: 456 }), 999, tag);
  assert.equal(downloadSizeOf(null), -1, tag);
}

function testInterceptTypes(api, tag) {
  const { matchesInterceptType, DEFAULT_INTERCEPT_TYPES: D, SETTINGS_DEFAULTS, normalizeSettings } = api;
  for (const t of ["zip", "exe", "mp4", "mp3", "pdf", "iso", "apk", "torrent"])
    assert.ok(D.includes(t), `${tag}: default types include ${t}`);
  assert.ok(!D.includes("*"), `${tag}: default is a list, not "all"`);
  deepEq(SETTINGS_DEFAULTS.interceptTypes, D, tag);

  assert.equal(matchesInterceptType("https://h/x/FILE.ZIP", "", D), true, `${tag}: case-insensitive URL extension`);
  assert.equal(matchesInterceptType("https://h/x", "Setup.EXE", D), true, `${tag}: case-insensitive filename`);
  assert.equal(matchesInterceptType("https://h/x", "C:\\Users\\me\\Downloads\\Setup.Msi", D), true, `${tag}: full path`);
  assert.equal(matchesInterceptType("https://h/a.txt", "report.PDF", D), true, `${tag}: filename wins over URL`);
  assert.equal(matchesInterceptType("https://h/a.pdf", "notes.txt", D), false, `${tag}: filename wins over URL (negative)`);
  assert.equal(matchesInterceptType("https://h/page.html", "", D), false, `${tag}: html stays in the browser`);
  assert.equal(matchesInterceptType("https://h/download?id=7", "", D), true, `${tag}: no extension -> offered to Nexa`);
  assert.equal(matchesInterceptType("https://h/", "", D), true, tag);
  assert.equal(matchesInterceptType("https://h/archive.tar.gz?token=1", "", D), true, `${tag}: query ignored`);
  assert.equal(matchesInterceptType("https://h/File%20Name.MKV", "", D), true, `${tag}: percent-encoded path`);
  assert.equal(matchesInterceptType("https://h/page.html", "", ["*"]), true, `${tag}: "*" = all types`);
  assert.equal(matchesInterceptType("https://h/page.html", "", ["all"]), true, `${tag}: "all" alias`);
  assert.equal(matchesInterceptType("https://h/page.html", "", ["zip", "*"]), true, tag);
  assert.equal(matchesInterceptType("https://h/page.html", "", [".HTML"]), true, `${tag}: leading dot + case in list`);
  assert.equal(matchesInterceptType("https://h/x.zip", "", []), false, `${tag}: empty list takes nothing (with an extension)`);
  assert.equal(matchesInterceptType("https://h/x.zip", "", null), true, `${tag}: non-array -> defaults`);
  assert.equal(matchesInterceptType("https://h/x.zip", "", ["zi"]), false, `${tag}: prefix is not a match`);
  assert.equal(matchesInterceptType("https://h/x.zip", "", ["zipx"]), false, tag);

  const s = normalizeSettings({ interceptTypes: [" .ZIP", "Rar", "*", "bad ext", "zip", 7] });
  deepEq(s.interceptTypes, ["zip", "rar", "*", "7"], `${tag}: interceptTypes normalised`);
  deepEq(normalizeSettings({ interceptTypes: "zip" }).interceptTypes, D, `${tag}: non-array falls back to defaults`);
}

function testNormalizeSettings(api, tag) {
  const { normalizeSettings, SETTINGS_DEFAULTS, DEFAULT_INTERCEPT_TYPES: D } = api;
  deepEq(normalizeSettings({}), {
    enabled: true, minSizeMB: 0, interceptTypes: D, disabledHosts: [],
    askBeforeHandoff: false, showFloatingButton: true, notifyOnHandoff: true
  }, `${tag}: defaults`);
  deepEq(normalizeSettings(undefined), normalizeSettings(SETTINGS_DEFAULTS), tag);
  const junk = normalizeSettings({ enabled: "no", minSizeMB: "-4", interceptTypes: "zip", disabledHosts: "x.com",
                                   askBeforeHandoff: 1, showFloatingButton: 0, notifyOnHandoff: undefined });
  deepEq(junk, {
    enabled: true, minSizeMB: 0, interceptTypes: D, disabledHosts: [],
    askBeforeHandoff: false, showFloatingButton: true, notifyOnHandoff: true
  }, `${tag}: junk values coerced to defaults`);
  deepEq(normalizeSettings({ enabled: false, minSizeMB: "25", interceptTypes: ["mp4"], disabledHosts: ["Example.COM"],
                                       askBeforeHandoff: true, showFloatingButton: false, notifyOnHandoff: false }), {
    enabled: false, minSizeMB: 25, interceptTypes: ["mp4"], disabledHosts: ["example.com"],
    askBeforeHandoff: true, showFloatingButton: false, notifyOnHandoff: false
  }, `${tag}: explicit values kept`);
}

function testLinksPayload(api, tag) {
  const { buildLinksPayload, MAX_LINKS } = api;
  assert.equal(MAX_LINKS, 2000, tag);
  const many = [];
  for (let i = 0; i < 2500; i++) many.push({ url: `https://files.example.com/f${i}.bin`, text: `file ${i}` });
  const p = buildLinksPayload({
    pageUrl: "https://example.com/page",
    pageTitle: "  Big \n  page ",
    links: [
      { url: "https://a.com/x.zip", text: "  Zip \n file ", kind: "link" },
      { url: "https://a.com/x.zip#frag", text: "dup", kind: "link" },     // fragment dup
      "https://a.com/x.zip",                                             // bare-string dup
      { url: "HTTP://A.com/y.zip" },                                     // normalised
      { url: "ftp://a.com/z.zip" }, { url: "javascript:void(0)" }, { url: "mailto:x@y.z" },
      { url: "data:text/plain,hi" }, { url: "blob:https://a.com/uuid" }, { url: "not a url" }, {}, null,
      { url: "https://a.com/i.png", kind: "image" },
      { url: "https://a.com/v.mp4", kind: "media" },
      { url: "https://a.com/w", kind: "weird", text: "x".repeat(500) },
      ...many
    ],
    headers: [["Cookie", "a=1"], ["cookie", "dup"], ["user-agent", "UA"], ["bad\nname", "v"],
              ["x-ok", "line\nbreak"], ["", "v"], ["single"], "str", null, ["referer", "https://example.com/page"]]
  });
  assert.equal(p.type, "links", tag);
  assert.equal(p.pageUrl, "https://example.com/page", tag);
  assert.equal(p.pageTitle, "Big page", `${tag}: title whitespace collapsed`);
  assert.equal(p.links.length, 2000, `${tag}: capped at 2000`);
  deepEq(p.links[0], { url: "https://a.com/x.zip", text: "Zip file", kind: "link" }, tag);
  deepEq(p.links[1], { url: "http://a.com/y.zip", text: "", kind: "link" }, `${tag}: scheme/host lower-cased`);
  deepEq(p.links[2], { url: "https://a.com/i.png", text: "", kind: "image" }, tag);
  deepEq(p.links[3], { url: "https://a.com/v.mp4", text: "", kind: "media" }, tag);
  assert.equal(p.links[4].url, "https://a.com/w", tag);
  assert.equal(p.links[4].kind, "link", `${tag}: unknown kind -> link`);
  assert.equal(p.links[4].text.length, 200, `${tag}: text capped`);
  assert.equal(p.links[5].url, "https://files.example.com/f0.bin", tag);
  assert.equal(p.links[1999].url, "https://files.example.com/f1994.bin", tag);
  assert.ok(p.links.every((l) => /^https?:\/\//.test(l.url)), `${tag}: http(s) only`);
  assert.ok(p.links.every((l) => ["link", "image", "media"].includes(l.kind)), tag);
  assert.equal(new Set(p.links.map((l) => l.url)).size, p.links.length, `${tag}: deduped`);
  deepEq(p.headers, [["cookie", "a=1"], ["user-agent", "UA"], ["referer", "https://example.com/page"]],
                   `${tag}: header pairs validated, lower-cased, deduped`);
  deepEq(JSON.parse(JSON.stringify(p)), p, `${tag}: JSON-clean`);
  assert.equal(buildLinksPayload({ links: many }, 10).links.length, 10, `${tag}: custom cap`);
  deepEq(buildLinksPayload(null), { type: "links", pageUrl: "", pageTitle: "", links: [], headers: [] }, tag);
  deepEq(buildLinksPayload({ links: "nope", headers: "nope" }).links, [], tag);
}

async function testNativeMessages(api, native, tag) {
  // ping
  native.sent.length = 0;
  native.reply = () => ({ ok: true, version: "0.1.0", plan: "pro", active: 1, queued: 2 });
  const ping = await api.pingEngine();
  deepEq(native.sent.map((s) => s.payload), [{ type: "ping" }], `${tag}: ping payload`);
  assert.equal(native.sent[0].host, "com.nexa.host", tag);
  deepEq(ping, { ok: true, version: "0.1.0", plan: "pro", active: 1, queued: 2 }, tag);

  // links: the content script answers nexa-collect-links; ONE links message goes out.
  native.sent.length = 0;
  native.content = (msg) => {
    assert.equal(msg.type, "nexa-collect-links", tag);
    assert.equal(msg.mode, "links", tag);
    return {
      pageUrl: "https://example.com/dir/",
      pageTitle: "Dir listing",
      links: [
        { url: "https://example.com/a.zip", text: "A", kind: "link" },
        { url: "https://example.com/a.zip", text: "A again", kind: "link" },
        { url: "javascript:void(0)", text: "js", kind: "link" },
        { url: "https://example.com/b.iso", text: "B", kind: "link" },
      ]
    };
  };
  native.reply = (payload) => ({ ok: true, count: payload.links.length });
  const r = await api.grabLinks({ id: 7, url: "https://example.com/dir/", title: "Dir listing" }, "links");
  deepEq(r, { ok: true, count: 2 }, `${tag}: grabLinks reply`);
  assert.equal(native.sent.length, 1, `${tag}: exactly one native message (no per-URL loop)`);
  const sent = native.sent[0].payload;
  deepEq(sent, {
    type: "links",
    pageUrl: "https://example.com/dir/",
    pageTitle: "Dir listing",
    links: [
      { url: "https://example.com/a.zip", text: "A", kind: "link" },
      { url: "https://example.com/b.iso", text: "B", kind: "link" },
    ],
    headers: [["user-agent", "Nexa test"], ["referer", "https://example.com/dir/"]],
  }, `${tag}: links payload`);
  assert.equal(native.local.recent[0].ok, true, `${tag}: recorded in recent`);
  assert.match(native.local.recent[0].name, /^2 links from example\.com$/, tag);

  // links: engine unavailable -> error surfaced, nothing crashes.
  native.sent.length = 0;
  native.reply = () => ({ ok: false, message: "engine unavailable" });
  const bad = await api.grabLinks({ id: 7, url: "https://example.com/dir/" }, "links");
  deepEq(bad, { ok: false, message: "engine unavailable" }, tag);
  assert.equal(native.local.recent[0].ok, false, tag);
  assert.equal(native.local.lastErrors[0].context, "links", tag);

  // links: nothing on the page -> no native message at all.
  native.sent.length = 0;
  native.content = () => ({ pageUrl: "https://example.com/", pageTitle: "", links: [] });
  const empty = await api.grabLinks({ id: 7, url: "https://example.com/" }, "links");
  assert.equal(empty.ok, false, tag);
  assert.equal(empty.count, 0, tag);
  assert.equal(native.sent.length, 0, `${tag}: no native message for an empty page`);
}

// The right-click menu offers only handoffs that can work. There is no "whole
// course" entry: yt-dlp cannot read a whole Udemy course (the app reports
// "Udemy course download is not supported"), so that job always failed — and
// the entry sat on every page and every link, not only on Udemy.
async function testContextMenus(native, tag) {
  for (const onInstalled of native.installed) await onInstalled({ reason: "install" });
  deepEq(native.menus.map((m) => m.id), ["nexa-link", "nexa-media", "nexa-page"],
         `${tag}: context menu entries`);
  assert.ok(!native.menus.some((m) => /course/i.test(m.title)), `${tag}: no whole-course entry`);

  // Nor is anything left behind that would still start one as a playlist job.
  native.sent.length = 0;
  const lecture = "https://www.udemy.com/course/python-basics/learn/lecture/123456";
  for (const onClicked of native.menuClicked)
    await onClicked({ menuItemId: "nexa-course", pageUrl: lecture }, { id: 7, url: lecture });
  assert.equal(native.sent.length, 0, `${tag}: a "nexa-course" click sends nothing`);
}

(async () => {
  for (const relativePath of [
    "extension-chromium/background.js",
    "extension-firefox/background.js",
  ]) {
    const native = { sent: [], local: {}, reply: () => ({ ok: true }), content: async () => null,
                     menus: [], installed: [], menuClicked: [] };
    const api = loadExtension(relativePath, native);
    testDisabledHosts(api, relativePath);
    testMinSize(api, relativePath);
    testInterceptTypes(api, relativePath);
    testNormalizeSettings(api, relativePath);
    testLinksPayload(api, relativePath);
    await testNativeMessages(api, native, relativePath);
    await testContextMenus(native, relativePath);
  }
  console.log("Extension settings tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
