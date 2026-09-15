#pragma once
#include <QObject>
#include <QString>

class QNetworkAccessManager;

namespace nexa {

// Update checker. GETs a small JSON document describing the latest release and,
// if that version is newer than the running one, tells the UI — which then
// downloads the installer through the normal engine (verifying the feed's
// SHA-256 when present) and launches it.
//
// Feed (served by the website at /api/releases/feed?os=<platform>):
//   { "version": "0.2.0", "url": "https://…/download/windows",
//     "notes": "what's new", "sha256": "<hex or empty>" }
//
// In a build configured with -DNEXA_DEV_BUILD=ON, $NEXA_UPDATE_URL overrides
// the feed URL and "off" disables checking entirely. A release build ignores
// the variable: the feed decides which installer this app downloads and runs,
// so it is never something the environment may redirect.
class UpdateChecker : public QObject {
    Q_OBJECT
public:
    explicit UpdateChecker(QObject *parent = nullptr);

    bool isConfigured() const;                  // false only for NEXA_UPDATE_URL=off (dev builds)
    QString feedUrl() const;                    // dev override, else the production feed
    void check(const QString &currentVersion);  // async; emits one signal below

    // "windows" | "linux" | "macos" — the feed's os selector for this build.
    static QString platformKey();

    // Public for unit-testing the comparison: true if `remote` > `current`
    // under dotted numeric semantics (1.10 > 1.9, trailing zeros ignored).
    static bool isNewer(const QString &remote, const QString &current);

signals:
    void updateAvailable(const QString &version, const QString &url,
                         const QString &notes, const QString &sha256);
    void upToDate();
    void checkFailed(const QString &reason);

private:
    QNetworkAccessManager *m_nam = nullptr;
};

} // namespace nexa
