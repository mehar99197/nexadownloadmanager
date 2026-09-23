#include "auth/CloudProviders.h"

#include <QFile>
#include <QJsonDocument>
#include <QJsonArray>
#include <QJsonObject>
#include <QUrl>
#include <QUrlQuery>
#include <QRegularExpression>
#include <QDebug>

namespace nexa {

CloudProvider CloudProvider::fromJson(const QJsonObject &obj)
{
    CloudProvider p;
    p.id = obj.value(QStringLiteral("id")).toString();
    p.label = obj.value(QStringLiteral("label")).toString();
    p.authDomain = obj.value(QStringLiteral("authDomain")).toString();
    p.cookieDomain = obj.value(QStringLiteral("cookieDomain")).toString();
    p.normalizeUrl = obj.value(QStringLiteral("normalizeUrl")).toBool(false);
    p.hasConfirmPage = obj.value(QStringLiteral("hasConfirmPage")).toBool(false);
    p.usesYtDlp = obj.value(QStringLiteral("usesYtDlp")).toBool(false);
    p.routesThroughYtDlp = obj.value(QStringLiteral("routesThroughYtDlp")).toBool(false);
    p.isSiteVideo = obj.value(QStringLiteral("isSiteVideo")).toBool(false);
    p.isAuthSite = obj.value(QStringLiteral("isAuthSite")).toBool(false);
    p.proOnly = obj.value(QStringLiteral("proOnly")).toBool(false);
    p.handlesDriveViaHttp = obj.value(QStringLiteral("handlesDriveViaHttp")).toBool(false);
    p.confirmParser = obj.value(QStringLiteral("confirmParser")).toString();

    const auto readList = [&](const char *key) {
        QStringList out;
        for (const auto &v : obj.value(QString::fromLatin1(key)).toArray())
            out.append(v.toString());
        return out;
    };
    p.hosts = readList("hosts");
    p.credentialSiblings = readList("credentialSiblings");
    p.driveDownloadHosts = readList("driveDownloadHosts");
    p.driveCDNHosts = readList("driveCDNHosts");
    p.proOnlyPaths = readList("proOnlyPaths");

    return p;
}

bool CloudProviders::load()
{
    QFile f(QStringLiteral(":/cloud_providers.json"));
    if (!f.open(QIODevice::ReadOnly)) {
        qWarning() << "CloudProviders: cannot open resource" << f.errorString();
        return false;
    }

    const QJsonDocument doc = QJsonDocument::fromJson(f.readAll());
    if (!doc.isObject()) {
        qWarning() << "CloudProviders: JSON root is not an object";
        return false;
    }

    const QJsonObject root = doc.object();
    const QJsonArray arr = root.value(QStringLiteral("providers")).toArray();
    m_providers.reserve(arr.size());
    for (const auto &v : arr) {
        if (!v.isObject())
            continue;
        m_providers.append(CloudProvider::fromJson(v.toObject()));
    }
    return !m_providers.isEmpty();
}

int CloudProviders::providerForHost(const QString &host) const
{
    const QString h = host.toLower();
    for (int i = 0; i < m_providers.size(); ++i) {
        for (const QString &ph : m_providers[i].hosts) {
            if (h == ph || h.endsWith(QLatin1Char('.') + ph))
                return i;
        }
    }
    return -1;
}

int CloudProviders::providerById(const QString &id) const
{
    for (int i = 0; i < m_providers.size(); ++i) {
        if (m_providers[i].id == id)
            return i;
    }
    return -1;
}

bool CloudProviders::sameCredentialScope(const QString &host1, const QString &host2) const
{
    if (host1.isEmpty() || host2.isEmpty())
        return false;
    if (host1.compare(host2, Qt::CaseInsensitive) == 0)
        return true;

    // Do not infer trust from a naive last-two-label "registrable domain": shared
    // hosting domains can contain unrelated tenants. Trust only hosts explicitly
    // listed by the provider registry (including their subdomains).
    const auto matchesListed = [](const QString &host, const QStringList &listed) {
        const QString h = host.toLower();
        for (const QString &entry : listed) {
            const QString s = entry.toLower();
            if (h == s || h.endsWith(QLatin1Char('.') + s))
                return true;
        }
        return false;
    };

    for (const auto &p : m_providers) {
        QStringList listed = p.hosts;
        listed += p.credentialSiblings;
        if (!p.authDomain.isEmpty())
            listed.append(p.authDomain);
        if (matchesListed(host1, listed) && matchesListed(host2, listed))
            return true;
    }
    return false;
}

bool CloudProviders::isGoogleDriveHost(const QUrl &url) const
{
    // Do not use providerForHost() here: the generic `google` entry also
    // matches accounts.google.com, which is a login page, not a Drive/Photos
    // download host. Only the specialised Google file providers count.
    const QString host = url.host().toLower();
    for (const CloudProvider &p : m_providers) {
        if (p.id != QStringLiteral("google_drive") &&
            p.id != QStringLiteral("google_photos"))
            continue;
        for (const QString &configuredHost : p.hosts) {
            if (host == configuredHost || host.endsWith(QLatin1Char('.') + configuredHost))
                return true;
        }
    }
    return false;
}

bool CloudProviders::isOneDriveHost(const QUrl &url) const
{
    const int idx = providerForHost(url.host());
    if (idx < 0) return false;
    return m_providers[idx].id == QStringLiteral("microsoft");
}

bool CloudProviders::isDropboxHost(const QUrl &url) const
{
    const int idx = providerForHost(url.host());
    if (idx < 0) return false;
    return m_providers[idx].id == QStringLiteral("dropbox");
}

bool CloudProviders::isConfirmPageHost(const QUrl &url) const
{
    const int idx = providerForHost(url.host());
    if (idx < 0) return false;
    return m_providers[idx].hasConfirmPage
        || m_providers[idx].confirmParser == QStringLiteral("drive")
        || m_providers[idx].confirmParser == QStringLiteral("generic");
}

bool CloudProviders::isSiteVideoUrl(const QUrl &url) const
{
    // Provider host lists may intentionally overlap. For example, YouTube is
    // also a Google host, but it must route through yt-dlp rather than the plain
    // HTTP downloader. Do not let the first generic provider mask a more
    // specific routing provider later in the registry.
    const QString host = url.host().toLower();
    for (const CloudProvider &p : m_providers) {
        bool matches = false;
        for (const QString &ph : p.hosts) {
            if (host == ph || host.endsWith(QLatin1Char('.') + ph)) {
                matches = true;
                break;
            }
        }
        if (!matches || (!p.isSiteVideo && !p.routesThroughYtDlp))
            continue;

        if (p.id == QStringLiteral("youtube"))
            return !url.path().contains(QStringLiteral("/videoplayback"));
        return true;
    }
    return false;
}

bool CloudProviders::isDirectFileUrl(const QUrl &url) const
{
    const QString host = url.host().toLower();

    // Google has overlapping registry entries: the generic `google` provider
    // also lists Drive/Photos hosts, while `google_drive` and `google_photos`
    // carry the actual direct-file rules. Scan all matching providers instead of
    // stopping at the first generic entry, otherwise Drive/Photos URLs would be
    // misclassified as ordinary web pages.
    for (const CloudProvider &p : m_providers) {
        bool matches = false;
        for (const QString &ph : p.hosts) {
            if (host == ph || host.endsWith(QLatin1Char('.') + ph)) {
                matches = true;
                break;
            }
        }
        if (!matches)
            continue;

        if (p.id == QStringLiteral("google_drive") ||
            p.id == QStringLiteral("google_photos")) {
            static const QRegularExpression idRe(QStringLiteral("/file/d/[A-Za-z0-9_-]+"));
            if (idRe.match(url.path()).hasMatch() ||
                QUrlQuery(url).hasQueryItem(QStringLiteral("id")))
                return true;

            const QString path = url.path();
            if (host.contains(QStringLiteral("photos")) ||
                host.contains(QStringLiteral("video.google"))) {
                if (path.contains(QStringLiteral("/photo/")) ||
                    path.contains(QStringLiteral("/share/")) ||
                    path.contains(QStringLiteral("/album/")))
                    return true;
            }
        }

        // MEGA is deliberately not a direct file. Its files are AES-encrypted
        // with a key that only exists in the link's fragment, and MegaGrabber
        // is what decrypts them and checks their MAC. Answering true here sent
        // every MEGA link to yt-dlp whenever yt-dlp was installed.
    }

    return false;
}

bool CloudProviders::requiresPro(const QUrl &url) const
{
    const QString host = url.host().toLower();
    if (host.isEmpty())
        return false;

    for (const CloudProvider &p : m_providers) {
        if (!p.proOnly)
            continue;
        bool onHost = false;
        for (const QString &ph : p.hosts) {
            if (host == ph || host.endsWith(QLatin1Char('.') + ph)) {
                onHost = true;
                break;
            }
        }
        if (!onHost)
            continue;
        // LinkedIn is one host for the feed and for Learning; only Learning is
        // a course site.
        if (p.proOnlyPaths.isEmpty())
            return true;
        for (const QString &prefix : p.proOnlyPaths) {
            if (url.path().startsWith(prefix, Qt::CaseInsensitive))
                return true;
        }
    }
    return false;
}

bool CloudProviders::isGoogleDriveFileUrl(const QUrl &url) const
{
    const int idx = providerById(QStringLiteral("google_drive"));
    if (idx < 0)
        return false;

    const CloudProvider &drive = m_providers[idx];
    const QString host = url.host().toLower();
    bool hostMatches = false;
    for (const QString &configuredHost : drive.hosts) {
        if (host == configuredHost || host.endsWith(QLatin1Char('.') + configuredHost)) {
            hostMatches = true;
            break;
        }
    }
    if (!hostMatches)
        return false;

    static const QRegularExpression idRe(QStringLiteral("/file/d/[A-Za-z0-9_-]+"));
    return idRe.match(url.path()).hasMatch()
        || QUrlQuery(url).hasQueryItem(QStringLiteral("id"));
}

bool CloudProviders::handlesDriveViaHttp(const QUrl &url) const
{
    // Host lists intentionally overlap (the generic Google entry also covers
    // Drive). Scan all matching entries and let the specific provider's routing
    // flag win instead of allowing the generic entry to mask it.
    const QString host = url.host().toLower();
    for (const CloudProvider &p : m_providers) {
        for (const QString &configuredHost : p.hosts) {
            if (host == configuredHost || host.endsWith(QLatin1Char('.') + configuredHost)) {
                if (p.handlesDriveViaHttp)
                    return true;
                break;
            }
        }
    }
    return false;
}

QStringList CloudProviders::allHosts() const
{
    QSet<QString> seen;
    QStringList out;
    for (const auto &p : m_providers) {
        for (const QString &h : p.hosts) {
            if (!seen.contains(h)) {
                seen.insert(h);
                out.append(h);
            }
        }
    }
    return out;
}

QStringList CloudProviders::allAuthDomains() const
{
    QSet<QString> seen;
    QStringList out;
    for (const auto &p : m_providers) {
        const QString d = p.authDomain;
        if (!d.isEmpty() && !seen.contains(d)) {
            seen.insert(d);
            out.append(d);
        }
    }
    return out;
}

QStringList CloudProviders::allSiblings() const
{
    QSet<QString> seen;
    QStringList out;
    for (const auto &p : m_providers) {
        for (const QString &s : p.credentialSiblings) {
            if (!seen.contains(s)) {
                seen.insert(s);
                out.append(s);
            }
        }
    }
    return out;
}

QStringList CloudProviders::authSites() const
{
    QSet<QString> seen;
    QStringList out;
    for (const auto &p : m_providers) {
        if (p.isAuthSite && !p.authDomain.isEmpty() && !seen.contains(p.authDomain)) {
            seen.insert(p.authDomain);
            out.append(p.authDomain);
        }
    }
    return out;
}

QStringList CloudProviders::siteVideoHosts() const
{
    QSet<QString> seen;
    QStringList out;
    for (const auto &p : m_providers) {
        if (p.isSiteVideo || p.routesThroughYtDlp) {
            for (const QString &h : p.hosts) {
                if (!seen.contains(h)) {
                    seen.insert(h);
                    out.append(h);
                }
            }
        }
    }
    return out;
}

QStringList CloudProviders::extensionAuthSites() const
{
    QSet<QString> seen;
    QStringList out;
    for (const auto &p : m_providers) {
        const QString d = p.authDomain;
        if (!d.isEmpty() && !seen.contains(d)) {
            seen.insert(d);
            out.append(d);
        }
    }
    return out;
}

int CloudProviders::providerForGoogleDrive() const
{
    return providerForHost(QStringLiteral("drive.google.com"));
}

} // namespace nexa
