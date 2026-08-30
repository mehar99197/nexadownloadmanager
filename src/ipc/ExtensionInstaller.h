#pragma once

// ExtensionInstaller — "fresh install → every browser on this machine gets the
// Nexa extension".
//
// Each browser family has ONE sanctioned way for a native installer to add an
// extension, and both fetch the extension from the browser's own store:
//   * Chromium family (Chrome, Chromium, Edge, Brave, Vivaldi): an "external
//     extension" entry — a registry value on Windows, a JSON file on macOS/Linux
//     — naming the store id. The browser installs it on its next start and asks
//     the user once to enable it. This is what IDM and 7-Zip-style integrations
//     use; it does NOT mark the browser "managed by your organization".
//     Brave, Edge and Vivaldi on Linux document no external-extension directory,
//     so there the managed-policy directory is used with installation_mode
//     "normal_installed" — installed automatically, still removable by the user.
//   * Firefox: an ExtensionSettings policy ("normal_installed" + install_url of
//     a signed .xpi). Firefox has no non-policy route since sideloading was
//     removed in 74.
//
// Nothing here can install an UNPUBLISHED extension: Chrome/Edge on Windows and
// macOS refuse off-store external entries, and Firefox refuses unsigned files.
// The ids live in packaging/extension-ids.env (bundled) and are empty until the
// store listings are approved; a browser whose id is empty is reported as
// WaitingForStore so the setup guide can say so instead of pretending.
//
// Scope: the app writes what the current user may write (Windows HKCU, macOS
// ~/Library). Linux hooks are all system-wide, so the .deb postinst runs
// packaging/register-browser-extensions as root; at runtime the app only
// verifies they are in place. Everything is idempotent — safe on every launch.

#include <QString>
#include <QStringList>
#include <QVector>

namespace nexa::extinstall {

struct Ids {
    QString chromeStoreId;    // Chrome Web Store id — Chrome, Chromium, Brave, Vivaldi
    QString edgeStoreId;      // Edge Add-ons id; empty → Edge installs the Chrome Web Store copy
    QString firefoxXpiUrl;    // AMO-signed .xpi URL
    QString firefoxExtId;     // gecko id (extension-firefox/manifest.json)
};
// packaging/extension-ids.env, then NEXA_* environment variables, then the
// QSettings group "extension/" — so a freshly approved id can be tried on one
// machine before the next release bakes it in.
Ids ids();
Ids parseIdsEnv(const QByteArray &envFile);

enum class Family { Chromium, Firefox };

struct Browser {
    QString key;        // chrome | chromium | edge | brave | vivaldi | firefox
    QString name;       // shown to the user
    Family  family = Family::Chromium;
    bool    sandboxed = false;   // snap / flatpak: reads none of the system hooks
};
QVector<Browser> installedBrowsers();

// One concrete write.
struct Target {
    QString browser;
    QString path;              // file path, or "HKEY_CURRENT_USER\\..." on Windows
    QString valueName;         // registry value name (Windows only)
    QByteArray payload;        // file content, or the registry string
    bool    mergeFirefoxPolicy = false;   // policies.json: merge our entry, keep theirs
    QString firefoxExtId;                 // key inside ExtensionSettings when merging
};
// Pure planning. systemRoot is prepended to system-wide paths (tests point it
// at a temp dir). Browsers with no id yield no targets.
QVector<Target> plan(const QVector<Browser> &browsers, const Ids &ids,
                     const QString &systemRoot = QString());

enum class Status { Registered, WaitingForStore, Manual, Failed };
struct Entry {
    QString browser;
    Status  status;
    QString detail;            // one sentence for the setup guide
};
struct Report {
    QVector<Entry> entries;
    bool anyRegistered() const;
};

bool applyTarget(const Target &t);      // true if in place afterwards (writes only on change)
bool targetInPlace(const Target &t);    // already exactly as we would write it
bool removeTarget(const Target &t);

// detect → plan → apply, and explain per browser. systemRoot as in plan().
Report apply(const QVector<Browser> &browsers, const Ids &ids,
             const QString &systemRoot = QString());

// Startup entry point; remembers the result for the setup guide.
Report registerExtensions();
const Report &lastReport();

} // namespace nexa::extinstall
