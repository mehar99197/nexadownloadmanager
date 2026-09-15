#include "core/UpdateChecker.h"
#include "license/LicenseToken.h"

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

// Must match updateFeedSigningPayload() in
// ndm-website/backend/src/utils/releaseFeed.js exactly, including the version
// prefix and the newline separators. Only the fields that decide what gets
// executed are covered; `notes` is cosmetic and excluded on purpose so editing
// a changelog does not invalidate a signature.
QByteArray feedSigningPayload(const QString &version, const QString &url, const QString &sha256)
{
    return QByteArrayLiteral("nexa-update-v1\n")
        + version.toUtf8() + '\n'
        + url.toUtf8() + '\n'
        + sha256.toUtf8();
}

// An absent signature is a failure, not a pass. A feed served by an older
// backend simply cannot be trusted to name an executable, so the update is
// refused rather than taken on faith.
bool feedSignatureValid(const QJsonObject &feed, const QString &version,
                        const QString &url, const QString &sha256)
{
    const QString encoded = feed.value(QStringLiteral("signature")).toString().trimmed();
    if (encoded.isEmpty())
        return false;
    const auto decoded = QByteArray::fromBase64Encoding(
        encoded.toLatin1(),
        QByteArray::Base64UrlEncoding | QByteArray::AbortOnBase64DecodingErrors);
    if (!decoded)
        return false;
    return licensetoken::verifyDetachedSignature(
        feedSigningPayload(version, url, sha256), *decoded);
}
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

// The feed URL is fixed at compile time in a shipped build.
//
// Redirecting it is worse than a lost sale: the feed supplies the installer URL
// *and* the SHA-256 it is verified against, so a feed an attacker controls
// passes the checksum test and the app then launches whatever it downloaded.
// A crack that told users to set $NEXA_UPDATE_URL would be a malware dropper.
// The variable is read in developer builds only — including its "off" value,
// which a shipped build also ignores (see isConfigured()).
QString UpdateChecker::feedUrl() const
{
#ifdef NEXA_DEV_BUILD
    // const char* name, not a QString — see the note in LicenseManager.cpp.
    const QString env = qEnvironmentVariable("NEXA_UPDATE_URL").trimmed();
    if (!env.isEmpty() && env.compare(QLatin1String("off"), Qt::CaseInsensitive) != 0)
        return env;
#endif
    return kDefaultFeed + platformKey();
}

bool UpdateChecker::isConfigured() const
{
#ifdef NEXA_DEV_BUILD
    return qEnvironmentVariable("NEXA_UPDATE_URL").trimmed().compare(QLatin1String("off"), Qt::CaseInsensitive) != 0;
#else
    // A shipped build always checks for updates. This used to read the same
    // environment variable as feedUrl() but WITHOUT its NEXA_DEV_BUILD guard,
    // so `NEXA_UPDATE_URL=off` silently disabled update checks in a release
    // binary — no debugger, no patching. That is the lever a cracked build
    // wants: it keeps an install from ever updating out of the cracked state,
    // and it keeps security fixes away from whoever installed it.
    return true;
#endif
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
        emit checkFailed(tr("Update checks are disabled"));
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

        // The feed decides which installer this app downloads and runs, and it
        // supplies the SHA-256 that installer is checked against. Both halves
        // come from the same response, so the checksum proves nothing on its
        // own — it only proves the download matches what the *feed* claimed.
        // The signature is what establishes the feed is genuinely ours, and it
        // is checked against the same key licence tokens use.
        if (!feedSignatureValid(obj, version, dlUrl, sha)) {
            emit checkFailed(QStringLiteral("update feed signature is missing or invalid"));
            return;
        }

        emit updateAvailable(version, dlUrl, obj.value(QStringLiteral("notes")).toString(), sha);
    });
}

} // namespace nexa
