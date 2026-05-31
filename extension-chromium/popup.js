// Popup UI: manual URL add, integration toggle, and a list of media Nexa
// sniffed on the current tab.

const $ = (id) => document.getElementById(id);

$("add").addEventListener("click", () => {
  const url = $("url").value.trim();
  if (!url) return;
  chrome.runtime.sendMessage({ type: "nexa-download", url }, () => {
    $("url").value = "";
    window.close();
  });
});

$("url").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("add").click();
});

// Integration toggle persisted in storage and read by the service worker.
chrome.storage.local.get({ enabled: true }, (v) => ($("enabled").checked = v.enabled));
$("enabled").addEventListener("change", (e) => {
  chrome.storage.local.set({ enabled: e.target.checked });
});

// Show media found on the current tab.
chrome.runtime.sendMessage({ type: "nexa-get-media" }, (items) => {
  if (chrome.runtime.lastError || !items || !items.length) return;
  const box = $("media");
  const title = document.createElement("div");
  title.className = "muted";
  title.textContent = `Media on this page (${items.length})`;
  box.appendChild(title);
  items.forEach((m) => {
    const el = document.createElement("div");
    el.className = "media-item";
    el.textContent = `${m.type} · download`;
    el.onclick = () =>
      chrome.runtime.sendMessage({ type: "nexa-download", url: m.url }, () => window.close());
    box.appendChild(el);
  });
});
