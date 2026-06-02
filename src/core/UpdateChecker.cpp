#include "core/UpdateChecker.h"

#include <QNetworkAccessManager>
#include <QNetworkRequest>
#include <QNetworkReply>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QUrl>

namespace nexa {

UpdateChecker::UpdateChecker(QObject *parent)
    : QObject(parent)
{
    m_nam = new QNetworkAccessManager(this);
}

bool UpdateChecker::isConfigured() const
{
    return !qEnvironmentVariable("NEXA_UPDATE_URL").isEmpty();
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
    const QString url = qEnvironmentVariable("NEXA_UPDATE_URL");
    if (url.isEmpty()) {
        emit checkFailed(QStringLiteral("no update URL configured (set NEXA_UPDATE_URL)"));
        return;
    }

    QNetworkRequest req{QUrl(url)};
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                     QNetworkRequest::NoLessSafeRedirectPolicy);
    req.setHeader(QNetworkRequest::UserAgentHeader, QStringLiteral("Nexa updater"));

    QNetworkReply *reply = m_nam->get(req);
    connect(reply, &QNetworkReply::finished, this, [this, reply, currentVersion]() {
        reply->deleteLater();
        if (reply->error() != QNetworkReply::NoError) {
            emit checkFailed(reply->errorString());
            return;
        }
        const QJsonObject obj = QJsonDocument::fromJson(reply->readAll()).object();
        const QString version = obj.value(QStringLiteral("version")).toString().trimmed();
        if (version.isEmpty()) {
            emit checkFailed(QStringLiteral("update feed had no \"version\" field"));
            return;
        }
        if (isNewer(version, currentVersion)) {
            emit updateAvailable(version,
                                 obj.value(QStringLiteral("url")).toString(),
                                 obj.value(QStringLiteral("notes")).toString());
        } else {
            emit upToDate();
        }
    });
}

} // namespace nexa
