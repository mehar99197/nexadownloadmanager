#pragma once
#include <QString>
#include <QStringList>
#include <QVector>
#include <QDateTime>
#include <QJsonObject>
#include <QUrl>

namespace nexa {

struct CloudProvider {
    QString id;
    QString label;
    QString authDomain;
    QString cookieDomain;
    QStringList hosts;
    QStringList credentialSiblings;
    bool normalizeUrl = false;
    bool hasConfirmPage = false;
    bool usesYtDlp = false;
    bool routesThroughYtDlp = false;
    bool isSiteVideo = false;
    bool isAuthSite = false;
    bool handlesDriveViaHttp = false;
    QString confirmParser;          // "drive", "generic", or empty
    QStringList driveDownloadHosts;
    QStringList driveCDNHosts;

    static CloudProvider fromJson(const QJsonObject &obj);
};

class CloudProviders {
public:
    bool load();

    int  providerForHost(const QString &host) const;
    int  providerById(const QString &id) const;
    const CloudProvider &provider(int index) const { return m_providers[index]; }
    int  count() const { return m_providers.size(); }
    const QVector<CloudProvider> &all() const { return m_providers; }

    bool sameCredentialScope(const QString &host1, const QString &host2) const;

    bool isGoogleDriveHost(const QUrl &url) const;
    bool isOneDriveHost(const QUrl &url) const;
    bool isDropboxHost(const QUrl &url) const;
    bool isConfirmPageHost(const QUrl &url) const;
    bool isSiteVideoUrl(const QUrl &url) const;
    bool isDirectFileUrl(const QUrl &url) const;
    // True for Google Drive file links that can be handled by the native HTTP
    // downloader. Google Photos remains on the yt-dlp path.
    bool isGoogleDriveFileUrl(const QUrl &url) const;
    bool handlesDriveViaHttp(const QUrl &url) const;

    QStringList allHosts() const;
    QStringList allAuthDomains() const;
    QStringList allSiblings() const;
    QStringList authSites() const;
    QStringList siteVideoHosts() const;

    // Extension-specific: providers that need cookie forwarding.
    QStringList extensionAuthSites() const;

    // Provider for a host (index) or -1. Exposed for extension code generation.
    int providerForGoogleDrive() const;

private:
    QString registrableDomain(const QString &host) const;
    QVector<CloudProvider> m_providers;
};

} // namespace nexa
