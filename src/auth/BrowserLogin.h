#pragma once
#include <QString>
#include <QStringList>
#include <QHash>

namespace nexa::browserlogin {

// Helpers for "use my logged-in browser" auth (yt-dlp --cookies-from-browser):
// detect which browser/profile holds a site's session, WITHOUT decrypting any
// cookie value (only the plaintext host_key/last_access are read). Shared by the
// Site Logins dialog and the engine's startup auto-login, so the two never drift.

// The auth-gated sites that work via browser login. Kept in sync with the
// extension's NEXA_AUTH_SITES and YtDlpGrabber's kAuthSites. Apple Music is
// deliberately excluded — it's DRM and can't be downloaded regardless of login.
QStringList authSites();

// Most-recently-used browser whose cookie store exists on disk, as a yt-dlp
// browser name (chrome/brave/chromium/edge/vivaldi/opera/firefox). Empty if none.
QString detectBrowser();

// For a Chromium-family browser, the profile DIR most recently logged into
// `domain` (e.g. "Profile 2"), or empty to mean the browser's default profile.
QString bestProfileForDomain(const QString &browser, const QString &domain);

// Same, for many domains in ONE pass (one cookie-DB copy per profile instead of
// per domain). Returns domain -> best profile dir (absent/"" = default profile).
// Used at startup to auto-pick the right profile for every auth site at once.
QHash<QString, QString> bestProfiles(const QString &browser, const QStringList &domains);

} // namespace nexa::browserlogin
