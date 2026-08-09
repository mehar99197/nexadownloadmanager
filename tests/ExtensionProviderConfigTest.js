// Provider-registry tests for both browser extensions.
// Run with: node tests/ExtensionProviderConfigTest.js

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function listener() {
  return { addListener() {} };
}

function browserApi() {
  const noOpListener = listener();
  return {
    contextMenus: { create() {}, onClicked: noOpListener },
    cookies: { getAll: async () => [] },
    downloads: {
      onCreated: noOpListener,
      cancel: async () => {},
      erase: async () => {},
    },
    runtime: {
      id: "test-extension",
      lastError: null,
      onInstalled: noOpListener,
      onMessage: noOpListener,
      sendNativeMessage() {},
    },
    storage: {
      local: { get(defaults, callback) { callback(defaults); } },
      onChanged: noOpListener,
      session: {
        get: async () => ({}),
        set() {},
        remove() {},
      },
    },
    tabs: {
      onRemoved: noOpListener,
      onUpdated: noOpListener,
      query: async () => [],
      sendMessage: async () => ({ ok: true }),
    },
    webRequest: {
      onBeforeRequest: noOpListener,
      onBeforeSendHeaders: noOpListener,
      onHeadersReceived: noOpListener,
    },
  };
}

function loadExtension(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8") + `
globalThis.__nexaTest = { PROVIDER_CONFIG, providerFor, getProviderCookieInfo };
`;
  const sandbox = {
    chrome: browserApi(),
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

const expected = [
  ["files.claude.ai", "claude.ai"],
  ["assets.grok.com", "grok.com"],
  ["imagine-public.x.ai", "grok.com"],
  ["pplx-res.cloudinary.com", "perplexity.ai"],
  ["chat.mistral.ai", "mistral.ai"],
  ["chat.deepseek.com", "deepseek.com"],
  ["assets.poecdn.net", "poe.com"],
  ["characterai.io", "character.ai"],
  ["pi.ai", "pi.ai"],
  ["you.ai", "you.com"],
];

for (const relativePath of [
  "extension-chromium/background.js",
  "extension-firefox/background.js",
]) {
  const api = loadExtension(relativePath);
  for (const [host, authDomain] of expected) {
    assert.equal(api.providerFor(host)?.id, "ai", `${relativePath}: ${host} is routed to AI provider`);
    assert.equal(api.getProviderCookieInfo(`https://${host}/download`)?.domain,
                 authDomain, `${relativePath}: ${host} resolves to ${authDomain}`);
  }

  assert.equal(api.providerFor("evil-grok.com"), null,
               `${relativePath}: evil-grok.com must not inherit AI handling`);
  assert.equal(api.providerFor("evil-perplexity.ai"), null,
               `${relativePath}: evil-perplexity.ai must not inherit AI handling`);
}

console.log("Extension provider config tests passed");
