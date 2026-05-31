#pragma once
#include <QObject>
#include <QString>

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

    bool start(const QString &name = QStringLiteral("nexa-ipc"));

private slots:
    void onNewConnection();
    void onReadyRead();

private:
    void handlePayload(QLocalSocket *sock, const QByteArray &json);

    DownloadEngine *m_engine;
    QLocalServer   *m_server = nullptr;
};

} // namespace nexa
