#include "ipc/IpcServer.h"
#include "core/DownloadEngine.h"

#include <QLocalServer>
#include <QLocalSocket>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QUrl>
#include <QDebug>

namespace nexa {

IpcServer::IpcServer(DownloadEngine *engine, QObject *parent)
    : QObject(parent), m_engine(engine)
{
}

IpcServer::~IpcServer()
{
    if (m_server) {
        m_server->close();
        delete m_server;
    }
}

bool IpcServer::start(const QString &name)
{
    m_server = new QLocalServer(this);
    // Clear any stale socket left by a previous crash.
    QLocalServer::removeServer(name);
    if (!m_server->listen(name)) {
        qWarning() << "Nexa IPC listen failed:" << m_server->errorString();
        return false;
    }
    connect(m_server, &QLocalServer::newConnection, this, &IpcServer::onNewConnection);
    return true;
}

void IpcServer::onNewConnection()
{
    while (m_server->hasPendingConnections()) {
        QLocalSocket *sock = m_server->nextPendingConnection();
        connect(sock, &QLocalSocket::readyRead, this, &IpcServer::onReadyRead);
        connect(sock, &QLocalSocket::disconnected, sock, &QObject::deleteLater);
    }
}

void IpcServer::onReadyRead()
{
    auto *sock = qobject_cast<QLocalSocket*>(sender());
    if (!sock)
        return;

    // Expect [4-byte LE length][JSON]. Wait until the whole frame has arrived.
    const QByteArray buf = sock->peek(sock->bytesAvailable());
    if (buf.size() < 4)
        return;
    const quint32 len = quint32((quint8)buf[0]) | (quint32((quint8)buf[1]) << 8) |
                        (quint32((quint8)buf[2]) << 16) | (quint32((quint8)buf[3]) << 24);
    if (quint32(buf.size()) < 4 + len)
        return;

    sock->read(4);                         // consume length prefix
    const QByteArray json = sock->read(len);
    handlePayload(sock, json);
}

void IpcServer::handlePayload(QLocalSocket *sock, const QByteArray &json)
{
    auto sendReply = [sock](const QJsonObject &o) {
        const QByteArray body = QJsonDocument(o).toJson(QJsonDocument::Compact);
        const quint32 len = quint32(body.size());
        QByteArray framed;
        framed.append(char(len & 0xFF));
        framed.append(char((len >> 8) & 0xFF));
        framed.append(char((len >> 16) & 0xFF));
        framed.append(char((len >> 24) & 0xFF));
        framed.append(body);
        sock->write(framed);
        sock->flush();
    };

    const QJsonDocument doc = QJsonDocument::fromJson(json);
    if (!doc.isObject()) {
        sendReply(QJsonObject{{"ok", false}, {"message", "bad json"}});
        return;
    }
    const QJsonObject obj = doc.object();
    const QString type = obj.value(QStringLiteral("type")).toString(QStringLiteral("download"));
    if (type != QStringLiteral("download")) {
        sendReply(QJsonObject{{"ok", false}, {"message", "unknown type"}});
        return;
    }

    const QUrl url = QUrl::fromUserInput(obj.value(QStringLiteral("url")).toString());
    if (!url.isValid()) {
        sendReply(QJsonObject{{"ok", false}, {"message", "invalid url"}});
        return;
    }

    // Assemble the headers the extension captured for this request.
    HeaderList headers;
    const QString cookies   = obj.value(QStringLiteral("cookies")).toString();
    const QString userAgent = obj.value(QStringLiteral("userAgent")).toString();
    const QString referrer  = obj.value(QStringLiteral("referrer")).toString();
    if (!cookies.isEmpty())   headers.append({QByteArrayLiteral("Cookie"),     cookies.toUtf8()});
    if (!userAgent.isEmpty()) headers.append({QByteArrayLiteral("User-Agent"), userAgent.toUtf8()});
    if (!referrer.isEmpty())  headers.append({QByteArrayLiteral("Referer"),    referrer.toUtf8()});

    const QJsonObject extra = obj.value(QStringLiteral("headers")).toObject();
    for (auto it = extra.begin(); it != extra.end(); ++it)
        headers.append({it.key().toUtf8(), it.value().toString().toUtf8()});

    const int id = m_engine->addDownload(url, QString(), headers);
    if (id < 0)
        sendReply(QJsonObject{{"ok", false}, {"message", "rejected"}});
    else
        sendReply(QJsonObject{{"ok", true}, {"id", id}});
}

} // namespace nexa
