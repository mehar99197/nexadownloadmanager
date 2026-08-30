#pragma once

#include <QString>

class QNetworkProxy;

namespace nexa {

// User-configured network proxy, shared by every part of Nexa that talks to the
// network: Qt's own stack (segmented HTTP, HLS, MEGA, licensing, updates) via
// QNetworkProxy::setApplicationProxy(), and the external tools (yt-dlp, aria2c)
// via a proxy URL passed on their command lines.
//
// Modes:
//   "none"   — direct connection (default)
//   "system" — whatever the OS/desktop is configured to use
//   "http"   — an explicit HTTP CONNECT proxy
//   "socks5" — an explicit SOCKS5 proxy
namespace proxyconfig {

// Read the persisted settings and install the result as the application proxy.
// Safe to call repeatedly (e.g. after the user saves Settings).
void applyFromSettings();

// The proxy as a URL for a child process, e.g. "socks5://user:pw@host:1080".
// Empty when no explicit proxy is configured — callers then pass nothing and
// the tool follows its own environment (http_proxy/https_proxy).
QString toolProxyUrl();

// One-line human summary for the Settings dialog ("SOCKS5 · 127.0.0.1:9050").
QString describe();

} // namespace proxyconfig
} // namespace nexa
