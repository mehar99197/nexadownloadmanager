// Nexa content script: injects a floating "Download with Nexa" button when the
// page has media, and can collect every link on the page for batch download.

(function () {
  let panel = null;

  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = "nexa-panel";
    panel.style.cssText = [
      "position:fixed", "right:18px", "bottom:18px", "z-index:2147483647",
      "background:#1e293b", "color:#fff", "font:13px/1.4 system-ui,sans-serif",
      "border-radius:10px", "box-shadow:0 6px 24px rgba(0,0,0,.35)",
      "padding:10px 12px", "max-width:320px", "display:none"
    ].join(";");
    document.documentElement.appendChild(panel);
    return panel;
  }

  function showMedia(items) {
    if (!items || !items.length) return;
    const p = ensurePanel();
    p.innerHTML =
      '<div style="font-weight:600;margin-bottom:6px;">⬇ Nexa — media found</div>';
    items.slice(0, 8).forEach((m) => {
      const row = document.createElement("button");
      row.textContent = `${m.type}  ·  download`;
      row.style.cssText =
        "display:block;width:100%;text-align:left;margin:4px 0;padding:6px 8px;" +
        "background:#3b82f6;color:#fff;border:0;border-radius:6px;cursor:pointer;";
      row.onclick = () =>
        chrome.runtime.sendMessage({ type: "nexa-download", url: m.url });
      p.appendChild(row);
    });
    p.style.display = "block";
  }

  // Poll the background worker for media it sniffed on this tab.
  function poll() {
    chrome.runtime.sendMessage({ type: "nexa-get-media" }, (items) => {
      if (chrome.runtime.lastError) return;
      if (items && items.length) showMedia(items);
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "nexa-collect-links") {
      const urls = Array.from(document.querySelectorAll("a[href]"))
        .map((a) => a.href)
        .filter((h) => /^https?:/i.test(h));
      chrome.runtime.sendMessage({ type: "nexa-download-list", urls: [...new Set(urls)] });
    }
  });

  setInterval(poll, 2500);
  setTimeout(poll, 1500);
})();
