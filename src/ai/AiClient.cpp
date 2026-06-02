#include "ai/AiClient.h"

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

AiClient::AiClient(QObject *parent)
    : QObject(parent)
{
    m_nam = new QNetworkAccessManager(this);
    m_key = qEnvironmentVariable("ANTHROPIC_API_KEY");
    m_base = qEnvironmentVariable("NEXA_AI_BASE", QStringLiteral("https://api.anthropic.com"));
    m_model = qEnvironmentVariable("NEXA_AI_MODEL", QStringLiteral("claude-haiku-4-5"));
}

void AiClient::send(const QString &systemPrompt, const QString &userMessage,
                    int maxTokens, std::function<void(QString)> onText, int attempt)
{
    if (!isConfigured()) {
        onText(QString());
        return;
    }

    QNetworkRequest req{QUrl(m_base + QStringLiteral("/v1/messages"))};
    req.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    req.setRawHeader("x-api-key", m_key.toUtf8());
    req.setRawHeader("anthropic-version", "2023-06-01");

    QJsonObject body{
        {QStringLiteral("model"), m_model},
        {QStringLiteral("max_tokens"), maxTokens},
        {QStringLiteral("system"), systemPrompt},
        {QStringLiteral("messages"),
         QJsonArray{QJsonObject{{QStringLiteral("role"), QStringLiteral("user")},
                                {QStringLiteral("content"), userMessage}}}}};

    QNetworkReply *reply = m_nam->post(req, QJsonDocument(body).toJson(QJsonDocument::Compact));
    connect(reply, &QNetworkReply::finished, this,
            [this, reply, onText, systemPrompt, userMessage, maxTokens, attempt]() {
        reply->deleteLater();
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const QNetworkReply::NetworkError netErr = reply->error();

        if (netErr != QNetworkReply::NoError) {
            // Retry only transient failures: rate limits (429), request timeout
            // (408), any 5xx, and connection-level errors. Client errors like
            // 401 (bad key) / 400 (bad request) won't fix themselves — give up.
            const bool retryable =
                status == 429 || status == 408 || status >= 500 ||
                netErr == QNetworkReply::TimeoutError ||
                netErr == QNetworkReply::TemporaryNetworkFailureError ||
                netErr == QNetworkReply::ConnectionRefusedError ||
                netErr == QNetworkReply::RemoteHostClosedError ||
                netErr == QNetworkReply::HostNotFoundError ||
                netErr == QNetworkReply::UnknownNetworkError;
            if (retryable && attempt + 1 < kMaxAttempts) {
                const int backoffMs = 600 * (1 << attempt);   // 600 ms, then 1200 ms
                QTimer::singleShot(backoffMs, this,
                    [this, systemPrompt, userMessage, maxTokens, onText, attempt]() {
                        send(systemPrompt, userMessage, maxTokens, onText, attempt + 1);
                    });
                return;
            }
            onText(QString());
            return;
        }

        // Anthropic shape: { "content": [ { "type": "text", "text": "..." } ] }.
        // A 200 with an error envelope or no text blocks yields an empty string
        // so callers fall back to their default behaviour instead of crashing.
        const QJsonObject obj = QJsonDocument::fromJson(reply->readAll()).object();
        if (obj.value(QStringLiteral("type")).toString() == QLatin1String("error")) {
            onText(QString());
            return;
        }
        const QJsonArray content = obj.value(QStringLiteral("content")).toArray();
        QString text;
        for (const QJsonValue &block : content) {
            if (block.toObject().value(QStringLiteral("type")).toString() == QLatin1String("text"))
                text += block.toObject().value(QStringLiteral("text")).toString();
        }
        onText(text.trimmed());
    });
}

void AiClient::suggestFilename(const QString &currentName, const QString &url,
                               const QString &contentType,
                               std::function<void(QString)> callback)
{
    const QString suffix = QFileInfo(currentName).suffix();
    const QString system = QStringLiteral(
        "You rename downloaded files to clean, descriptive, human-readable names. "
        "Rules: keep the original file extension; use spaces or hyphens, no slashes "
        "or illegal filename characters; be concise; reply with ONLY the new "
        "filename and nothing else.");
    const QString user = QStringLiteral(
        "Original filename: %1\nSource URL: %2\nContent-Type: %3\n"
        "Give a better filename (keep the .%4 extension).")
        .arg(currentName, url, contentType.isEmpty() ? QStringLiteral("unknown") : contentType, suffix);

    send(system, user, 64, [callback, currentName, suffix](const QString &text) {
        QString name = text.trimmed();
        // Take the first line, strip quotes/backticks/paths, sanitise.
        name = name.section('\n', 0, 0).trimmed();
        name.remove(QLatin1Char('"')).remove(QLatin1Char('`'));
        name = QFileInfo(name).fileName();              // drop any path the model added
        name.replace(QRegularExpression(QStringLiteral("[\\\\/:*?\"<>|]")), QString());
        // Guard: must be sane and keep the extension; otherwise keep the original.
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
    const QString system = QStringLiteral(
        "You convert a user's download request into strict JSON with this shape: "
        "{\"downloads\":[{\"url\":\"...\"}],\"schedule\":{\"atIso\":\"<ISO8601 or empty>\","
        "\"recurrence\":\"<none|daily|weekly>\"}}. "
        "Extract every URL or magnet link. If the user names a time, set atIso to an "
        "absolute ISO-8601 timestamp; otherwise leave it empty. Reply with ONLY the JSON.");

    send(system, text, 512, [callback](const QString &out) {
        // The model may wrap JSON in prose/fences; extract the outermost object.
        const int a = out.indexOf('{');
        const int b = out.lastIndexOf('}');
        QJsonObject obj;
        if (a >= 0 && b > a)
            obj = QJsonDocument::fromJson(out.mid(a, b - a + 1).toUtf8()).object();
        callback(obj);
    });
}

} // namespace nexa
