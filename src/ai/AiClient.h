#pragma once
#include <QObject>
#include <QString>
#include <QJsonObject>
#include <functional>

class QNetworkAccessManager;

namespace nexa {

class LicenseManager;

// Thin async client for Nexa's AI helpers:
//   * suggestFilename() — propose a clean, human-readable filename
//   * interpretCommand() — turn "grab these tonight at 2am" into a structured
//     {downloads, schedule} object
//
// These used to call api.anthropic.com directly with a key from
// $ANTHROPIC_API_KEY. They now go through Nexa's own API instead, which is
// what makes the `aiRename` entitlement real: the old arrangement gated a
// feature the client could reach entirely on its own, so flipping one boolean
// in a patched binary was enough to have it. The privileged call now happens
// on a server that independently checks the licence token, and the prompts
// live there too — this class sends structured fields, never a prompt, so a
// stolen token cannot turn the endpoint into a general-purpose model API.
//
// isConfigured() therefore means "this install holds a licence token", not
// "an API key is present". A Free install has no token and skips AI entirely,
// exactly as an install with no key used to.
class AiClient : public QObject {
    Q_OBJECT
public:
    // `license` supplies the bearer token; AiClient does not own it.
    explicit AiClient(LicenseManager *license, QObject *parent = nullptr);

    bool isConfigured() const;

    void suggestFilename(const QString &currentName, const QString &url,
                         const QString &contentType,
                         std::function<void(QString)> callback);

    void interpretCommand(const QString &text,
                          std::function<void(QJsonObject)> callback);

private:
    // POSTs `body` to <api>/<path> with the licence token attached and hands
    // the parsed `data` object to `onData` — an empty object on any failure,
    // so callers fall back to their default behaviour rather than erroring.
    // Retries transient failures (network errors, HTTP 429/5xx) up to
    // kMaxAttempts with exponential backoff.
    void post(const QString &path, const QJsonObject &body,
              std::function<void(QJsonObject)> onData, int attempt = 0);

    QUrl endpoint(const QString &path) const;

    static constexpr int kMaxAttempts = 3;   // initial try + 2 retries
    // A hostile or broken server must not be able to hand us an unbounded body.
    static constexpr int kMaxResponseBytes = 64 * 1024;

    QNetworkAccessManager *m_nam = nullptr;
    LicenseManager        *m_license = nullptr;
};

} // namespace nexa
