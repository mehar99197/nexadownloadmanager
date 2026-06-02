#pragma once
#include <QObject>
#include <QString>
#include <QJsonObject>
#include <functional>

class QNetworkAccessManager;

namespace nexa {

// Thin async client for the Anthropic Messages API, used for Nexa's AI helpers:
//   * suggestFilename() — propose a clean, human-readable filename for a download
//   * interpretCommand() — turn a natural-language request ("grab these tonight
//     at 2am") into a structured {downloads, schedule} object
//
// The API key is read from $ANTHROPIC_API_KEY (or set explicitly). When no key
// is configured isConfigured() is false and callers should skip AI features.
// The base URL and model are overridable via env for testing / customisation:
//   $NEXA_AI_BASE   (default https://api.anthropic.com)
//   $NEXA_AI_MODEL  (default claude-haiku-4-5)
class AiClient : public QObject {
    Q_OBJECT
public:
    explicit AiClient(QObject *parent = nullptr);

    bool isConfigured() const { return !m_key.isEmpty(); }

    void suggestFilename(const QString &currentName, const QString &url,
                         const QString &contentType,
                         std::function<void(QString)> callback);

    void interpretCommand(const QString &text,
                          std::function<void(QJsonObject)> callback);

private:
    // Sends one user message with a system prompt; delivers the model's text
    // (empty string on any failure) to onText. Retries transient failures
    // (network errors, HTTP 429/5xx) up to kMaxAttempts with exponential backoff;
    // `attempt` is the internal retry counter and should be left at its default.
    void send(const QString &systemPrompt, const QString &userMessage,
              int maxTokens, std::function<void(QString)> onText, int attempt = 0);

    static constexpr int kMaxAttempts = 3;   // initial try + 2 retries

    QNetworkAccessManager *m_nam = nullptr;
    QString                m_key;
    QString                m_base;
    QString                m_model;
};

} // namespace nexa
