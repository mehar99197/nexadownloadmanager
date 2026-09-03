#include "ai/AiClient.h"

#include "license/LicenseManager.h"

#include <QCoreApplication>
#include <QNetworkAccessManager>
#include <QNetworkRequest>
#include <QNetworkReply>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QFileInfo>
#include <QRegularExpression>
#include <QTimer>
#include <QUrl>

namespace nexa {

namespace {
// Pinned at compile time for the same reason as the licence and ads endpoints:
// an environment variable here would let anyone point the AI calls — and the
// licence token they carry — at a server of their choosing.
constexpr auto kProductionAiApi = "https://nexadownloadmanager.com/api/ai";
}

AiClient::AiClient(LicenseManager *license, QObject *parent)
    : QObject(parent)
    , m_nam(new QNetworkAccessManager(this))
    , m_license(license)
{
}

// A licence token is the only credential these endpoints accept, so holding one
// is what "configured" means. Free installs never have one.
bool AiClient::isConfigured() const
{
    return m_license && !m_license->licenseToken().isEmpty();
}

QUrl AiClient::endpoint(const QString &path) const
{
#ifdef NEXA_DEV_BUILD
    const QString base = qEnvironmentVariable("NEXA_AI_API_URL",
                                              QString::fromLatin1(kProductionAiApi));
#else
    const QString base = QString::fromLatin1(kProductionAiApi);
#endif
    QUrl url(base + path);
#ifdef NEXA_DEV_BUILD
    const bool insecureDevelopment =
        qEnvironmentVariableIntValue("NEXA_ALLOW_INSECURE_LICENSE_API") == 1 &&
        (url.host() == QLatin1String("localhost") || url.host() == QLatin1String("127.0.0.1"));
#else
    constexpr bool insecureDevelopment = false;
#endif
    if (!url.isValid() || (url.scheme() != QLatin1String("https") && !insecureDevelopment))
        return QUrl();
    return url;
}

void AiClient::post(const QString &path, const QJsonObject &body,
                    std::function<void(QJsonObject)> onData, int attempt)
{
    const QUrl url = endpoint(path);
    const QString token = m_license ? m_license->licenseToken() : QString();
    if (!url.isValid() || token.isEmpty()) {
        onData(QJsonObject());
        return;
    }

    QNetworkRequest request(url);
    request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    request.setHeader(QNetworkRequest::UserAgentHeader,
                      QStringLiteral("Nexa/%1").arg(QCoreApplication::applicationVersion()));
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                         QNetworkRequest::NoLessSafeRedirectPolicy);
    request.setTransferTimeout(20000);
    request.setRawHeader("Authorization", QByteArray("Bearer ") + token.toUtf8());

    QNetworkReply *reply = m_nam->post(request, QJsonDocument(body).toJson(QJsonDocument::Compact));
    connect(reply, &QNetworkReply::finished, this,
            [this, reply, path, body, onData, attempt]() {
        reply->deleteLater();
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const QNetworkReply::NetworkError networkError = reply->error();

        if (networkError != QNetworkReply::NoError) {
            // Retry only what might succeed next time. A 403 means this licence
            // does not include AI and a 503 means the server has no key
            // configured — neither improves by asking again.
            const bool retryable =
                status == 429 || status == 408 || (status >= 500 && status != 503) ||
                networkError == QNetworkReply::TimeoutError ||
                networkError == QNetworkReply::TemporaryNetworkFailureError ||
                networkError == QNetworkReply::ConnectionRefusedError ||
                networkError == QNetworkReply::RemoteHostClosedError ||
                networkError == QNetworkReply::HostNotFoundError ||
                networkError == QNetworkReply::UnknownNetworkError;
            if (retryable && attempt + 1 < kMaxAttempts) {
                const int backoffMs = 600 * (1 << attempt);   // 600 ms, then 1200 ms
                QTimer::singleShot(backoffMs, this, [this, path, body, onData, attempt]() {
                    post(path, body, onData, attempt + 1);
                });
                return;
            }
            onData(QJsonObject());
            return;
        }

        const QByteArray payload = reply->read(kMaxResponseBytes + 1);
        if (payload.size() > kMaxResponseBytes) {
            onData(QJsonObject());
            return;
        }
        const QJsonObject root = QJsonDocument::fromJson(payload).object();
        if (!root.value(QStringLiteral("ok")).toBool()) {
            onData(QJsonObject());
            return;
        }
        onData(root.value(QStringLiteral("data")).toObject());
    });
}

void AiClient::suggestFilename(const QString &currentName, const QString &url,
                               const QString &contentType,
                               std::function<void(QString)> callback)
{
    if (!isConfigured()) {
        callback(currentName);
        return;
    }
    const QString suffix = QFileInfo(currentName).suffix();

    post(QStringLiteral("/rename"), QJsonObject{
             {QStringLiteral("filename"), currentName},
             {QStringLiteral("url"), url},
             {QStringLiteral("contentType"), contentType},
         },
         [callback, currentName, suffix](const QJsonObject &data) {
        QString name = data.value(QStringLiteral("name")).toString().trimmed();
        // Sanitised on the server too. Doing it again here is not redundancy
        // for its own sake: this string becomes a path on the user's disk, and
        // the server's answer is still just bytes off the network.
        name = name.section('\n', 0, 0).trimmed();
        name.remove(QLatin1Char('"')).remove(QLatin1Char('`'));
        name = QFileInfo(name).fileName();              // drop any path
        name.replace(QRegularExpression(QStringLiteral("[\\\\/:*?\"<>|]")), QString());
        if (name.isEmpty() || name.length() > 200) {
            callback(currentName);
            return;
        }
        if (!suffix.isEmpty() && !name.endsWith(QStringLiteral(".") + suffix, Qt::CaseInsensitive))
            name += QStringLiteral(".") + suffix;
        callback(name);
    });
}

void AiClient::interpretCommand(const QString &text,
                                std::function<void(QJsonObject)> callback)
{
    if (!isConfigured()) {
        callback(QJsonObject());
        return;
    }
    // The server returns the {downloads, schedule} object already parsed and
    // bounded, so there is no prose or fence to dig it out of any more. Callers
    // still validate every URL's scheme — a model's output never gets to name a
    // file:// target.
    post(QStringLiteral("/command"), QJsonObject{{QStringLiteral("text"), text}},
         [callback](const QJsonObject &data) { callback(data); });
}

} // namespace nexa
