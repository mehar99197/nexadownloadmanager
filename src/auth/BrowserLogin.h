#pragma once
#include <QString>
#include <QStringList>
#include <QHash>

namespace nexa {

class CloudProviders;

namespace browserlogin {

// Data-driven cloud provider registry (shared, owned by the engine).
// When set, authSites() is driven entirely by cloud_providers.json.
void setCloudProviders(const CloudProviders *p);

// The auth-gated sites that work via browser login. Kept in sync with the
// extension's NEXA_AUTH_SITES and YtDlpGrabber's kAuthSites. Apple Music is
// deliberately excluded — it's DRM and can't be downloaded regardless of login.
QStringList authSites();

// Most-recently-used browser whose cookie store exists on disk, as a yt-dlp
// browser name (chrome/brave/chromium/edge/vivaldi/opera/firefox). Empty if none.
// On Windows only Firefox is ever returned: Chromium browsers keep their cookies
// under App-Bound Encryption there, which yt-dlp cannot decrypt, so a Chrome /
// Edge / Brave credential would only guarantee a login failure — the extension's
// cookie export is the Chromium path on Windows (see IpcServer).
QString detectBrowser();

// For a Chromium-family browser, the profile DIR most recently logged into
// `domain` (e.g. "Profile 2"), or empty to mean the browser's default profile.
QString bestProfileForDomain(const QString &browser, const QString &domain);

// Same, for many domains in ONE pass (one cookie-DB copy per profile instead of
// per domain). Returns domain -> best profile dir (absent/"" = default profile).
// Used at startup to auto-pick the right profile for every auth site at once.
QHash<QString, QString> bestProfiles(const QString &browser, const QStringList &domains);

} // namespace browserlogin
} // namespace nexa
