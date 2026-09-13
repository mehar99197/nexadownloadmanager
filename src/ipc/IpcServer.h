#pragma once
#include <QObject>
#include <QString>
#include <QVector>
#include "core/Types.h"

class QLocalServer;
class QLocalSocket;

namespace nexa {

class DownloadEngine;

// Listens on a local socket for framed-JSON messages from nexa-host (the native
// messaging bridge) and turns them into downloads. Protocol mirrors the host:
// [4-byte LE length][UTF-8 JSON].
class IpcServer : public QObject {
    Q_OBJECT
public:
    explicit IpcServer(DownloadEngine *engine, QObject *parent = nullptr);
    ~IpcServer() override;

    // Returns true on success. Returns false if another live instance already
    // owns the socket (the caller should then forward its work and exit rather
    // than opening a second window).
    bool start(const QString &name = QStringLiteral("nexa-ipc"));

signals:
    // Emitted when a peer sends {"type":"show"} (e.g. a second `nexa` launch, or
    // the browser popup) asking the running instance to surface its window.
    void showWindowRequested();
    // Emitted when the extension sends {"type":"links"} — a page's harvested links
    // (already validated: http(s), public hosts, de-duplicated, capped) for the UI
    // to present in the link-grabber dialog.
    void linksReceived(const QString &pageUrl, const QString &pageTitle,
                       const QVector<nexa::LinkItem> &links, const nexa::HeaderList &headers);

private slots:
    void onNewConnection();
    void onReadyRead();

private:
    void handlePayload(QLocalSocket *sock, const QByteArray &json);
    void sendFramed(QLocalSocket *sock, const QJsonObject &obj) const;
    void listFormats(QLocalSocket *sock, const QUrl &url);   // async yt-dlp -J

    DownloadEngine *m_engine;
    QLocalServer   *m_server = nullptr;

    // `yt-dlp -J` probes currently running. Each is a process that lives for
    // seconds, so the count is capped: the socket is user-scoped, but any code
    // running as this user (a compromised extension included) can send as many
    // list-formats messages as it likes.
    int             m_formatProbes = 0;
    static constexpr int kMaxFormatProbes      = 4;
    static constexpr int kFormatProbeTimeoutMs = 45000;   // frees a hung slot
};

} // namespace nexa
