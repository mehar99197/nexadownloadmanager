#pragma once
#include <QObject>
#include <QString>

class QNetworkAccessManager;

namespace nexa {

// A lightweight update *checker* (not an auto-installer). It GETs a small JSON
// document describing the latest release and, if that version is newer than the
// running one, tells the UI so it can point the user at the download.
//
// The endpoint is configured via $NEXA_UPDATE_URL and must return:
//   { "version": "0.2.0", "url": "https://…/download", "notes": "what's new" }
//
// Auto-applying an update is intentionally out of scope: it's platform-specific
// (.deb / NSIS / AppImage) and security-sensitive (signature verification), so
// Nexa surfaces the new version and link and lets the user update via their
// normal channel. Disabled (no network call) when $NEXA_UPDATE_URL is unset.
class UpdateChecker : public QObject {
    Q_OBJECT
public:
    explicit UpdateChecker(QObject *parent = nullptr);

    bool isConfigured() const;                  // is $NEXA_UPDATE_URL set?
    void check(const QString &currentVersion);  // async; emits one signal below

    // Public for unit-testing the comparison: true if `remote` > `current`
    // under dotted numeric semantics (1.10 > 1.9, trailing zeros ignored).
    static bool isNewer(const QString &remote, const QString &current);

signals:
    void updateAvailable(const QString &version, const QString &url, const QString &notes);
    void upToDate();
    void checkFailed(const QString &reason);

private:
    QNetworkAccessManager *m_nam = nullptr;
};

} // namespace nexa
