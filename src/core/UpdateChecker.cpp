#include "core/UpdateChecker.h"

#include <QNetworkAccessManager>
#include <QNetworkRequest>
#include <QNetworkReply>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QUrl>

namespace nexa {

namespace {
const QString kDefaultFeed = QStringLiteral("https://nexadownloadmanager.com/api/releases/feed?os=");
constexpr int kMaxFeedBytes = 256 * 1024;
}

UpdateChecker::UpdateChecker(QObject *parent)
    : QObject(parent)
{
    m_nam = new QNetworkAccessManager(this);
}

QString UpdateChecker::platformKey()
{
#if defined(Q_OS_WIN)
    return QStringLiteral("windows");
#elif defined(Q_OS_MACOS)
    return QStringLiteral("macos");
#else
    return QStringLiteral("linux");
#endif
}

QString UpdateChecker::feedUrl() const
{
    const QString env = qEnvironmentVariable("NEXA_UPDATE_URL").trimmed();
    if (!env.isEmpty())
        return env;
    return kDefaultFeed + platformKey();
}

bool UpdateChecker::isConfigured() const
{
    return qEnvironmentVariable("NEXA_UPDATE_URL").trimmed().compare(QLatin1String("off"), Qt::CaseInsensitive) != 0;
}

bool UpdateChecker::isNewer(const QString &remote, const QString &current)
{
    const QStringList a = remote.split(QLatin1Char('.'), Qt::SkipEmptyParts);
    const QStringList b = current.split(QLatin1Char('.'), Qt::SkipEmptyParts);
    const int n = qMax(a.size(), b.size());
    for (int i = 0; i < n; ++i) {
        // Strip any non-numeric suffix (e.g. "1-rc") so it compares cleanly.
        const int av = (i < a.size()) ? a.at(i).section(QRegularExpression(QStringLiteral("\\D")), 0, 0).toInt() : 0;
        const int bv = (i < b.size()) ? b.at(i).section(QRegularExpression(QStringLiteral("\\D")), 0, 0).toInt() : 0;
        if (av != bv)
            return av > bv;
    }
    return false;   // equal
}

void UpdateChecker::check(const QString &currentVersion)
{
    if (!isConfigured()) {
        emit checkFailed(QStringLiteral("update checks are disabled (NEXA_UPDATE_URL=off)"));
        return;
    }
    const QUrl url(feedUrl());
    if (!url.isValid() || (url.scheme() != QLatin1String("https") && url.host() != QLatin1String("localhost")
                           && url.host() != QLatin1String("127.0.0.1"))) {
        emit checkFailed(QStringLiteral("update feed must be an https URL"));
        return;
    }

    QNetworkRequest req{url};
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                     QNetworkRequest::NoLessSafeRedirectPolicy);
    req.setHeader(QNetworkRequest::UserAgentHeader,
                  QStringLiteral("Nexa updater/%1 (%2)").arg(currentVersion, platformKey()));
    req.setTransferTimeout(15000);

    QNetworkReply *reply = m_nam->get(req);
    connect(reply, &QNetworkReply::finished, this, [this, reply, currentVersion]() {
        reply->deleteLater();
        if (reply->error() != QNetworkReply::NoError) {
            emit checkFailed(reply->errorString());
            return;
        }
        const QByteArray body = reply->read(kMaxFeedBytes + 1);
        if (body.size() > kMaxFeedBytes) {
            emit checkFailed(QStringLiteral("update feed is too large"));
            return;
        }
        const QJsonObject obj = QJsonDocument::fromJson(body).object();
        const QString version = obj.value(QStringLiteral("version")).toString().trimmed();
        if (version.isEmpty()) {
            emit checkFailed(QStringLiteral("update feed had no \"version\" field"));
            return;
        }
        if (!isNewer(version, currentVersion)) {
            emit upToDate();
            return;
        }
        // Only ever hand the UI an https installer URL and a well-formed hash.
        const QUrl dl(obj.value(QStringLiteral("url")).toString());
        const QString dlUrl = (dl.isValid() && dl.scheme() == QLatin1String("https")) ? dl.toString() : QString();
        static const QRegularExpression hexRe(QStringLiteral("\\A[0-9a-fA-F]{64}\\z"));
        QString sha = obj.value(QStringLiteral("sha256")).toString().trimmed().toLower();
        if (!hexRe.match(sha).hasMatch())
            sha.clear();
        emit updateAvailable(version, dlUrl, obj.value(QStringLiteral("notes")).toString(), sha);
    });
}

} // namespace nexa
