#include "ipc/IpcServer.h"
#include "core/DownloadEngine.h"
#include "auth/AuthenticationManager.h"

#include <QLocalServer>
#include <QLocalSocket>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QJsonArray>
#include <QProcess>
#include <QSet>
#include <QUrl>
#include <QDebug>
#include <algorithm>

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

void IpcServer::sendFramed(QLocalSocket *sock, const QJsonObject &o) const
{
    if (!sock)
        return;
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
}

void IpcServer::handlePayload(QLocalSocket *sock, const QByteArray &json)
{
    auto sendReply = [this, sock](const QJsonObject &o) { sendFramed(sock, o); };

    const QJsonDocument doc = QJsonDocument::fromJson(json);
    if (!doc.isObject()) {
        sendReply(QJsonObject{{"ok", false}, {"message", "bad json"}});
        return;
    }
    const QJsonObject obj = doc.object();
    const QString type = obj.value(QStringLiteral("type")).toString(QStringLiteral("download"));

    const QUrl url = QUrl::fromUserInput(obj.value(QStringLiteral("url")).toString());
    if (!url.isValid()) {
        sendReply(QJsonObject{{"ok", false}, {"message", "invalid url"}});
        return;
    }

    // The extension asks for a video's real, available qualities before showing
    // the quality menu. Runs yt-dlp -J and replies asynchronously.
    if (type == QStringLiteral("list-formats")) {
        listFormats(sock, url);
        return;
    }
    if (type != QStringLiteral("download")) {
        sendReply(QJsonObject{{"ok", false}, {"message", "unknown type"}});
        return;
    }

    // Optional: the extension may hand us domain-scoped auth (a cookies.txt path
    // or a bearer token) to register before downloading. Validate eagerly so the
    // user hears "all cookies expired — re-login" now, not via a silent 403 later.
    if (AuthenticationManager *am = m_engine->auth()) {
        const QString authDomain = obj.value(QStringLiteral("authDomain")).toString();
        if (!authDomain.isEmpty()) {
            AuthResult ar = AuthResult::success();
            const QString cookiesFile = obj.value(QStringLiteral("authCookiesFile")).toString();
            const QString bearer      = obj.value(QStringLiteral("bearer")).toString();
            if (!cookiesFile.isEmpty()) {
                ar = am->registerCookieFile(authDomain, cookiesFile);
            } else if (!bearer.isEmpty()) {
                const qint64 exp = qint64(obj.value(QStringLiteral("bearerExpiresAt")).toDouble(0));
                ar = am->registerBearerToken(authDomain, bearer, exp);
            }
            if (!ar.ok) {
                sendReply(QJsonObject{{"ok", false}, {"message", ar.detail}});
                return;
            }
        }
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

    const QString suggestedName = obj.value(QStringLiteral("filename")).toString();
    const QString quality = obj.value(QStringLiteral("quality")).toString();   // YouTube etc.
    const bool playlist = obj.value(QStringLiteral("playlist")).toBool(false);  // whole playlist?
    const int id = m_engine->addDownload(url, QString(), headers, suggestedName, quality, playlist);
    if (id < 0)
        sendReply(QJsonObject{{"ok", false}, {"message", "rejected"}});
    else
        sendReply(QJsonObject{{"ok", true}, {"id", id}});
}

void IpcServer::listFormats(QLocalSocket *sock, const QUrl &url)
{
    auto *proc = new QProcess(this);
    auto *out = new QByteArray;
    connect(proc, &QProcess::readyReadStandardOutput, this,
            [proc, out]() { out->append(proc->readAllStandardOutput()); });
    connect(proc, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished), this,
            [this, sock, proc, out](int, QProcess::ExitStatus) {
        // Collect the distinct video heights that have audio available so every
        // listed quality can be delivered as video+audio.
        const QJsonObject info = QJsonDocument::fromJson(*out).object();
        const QJsonArray formats = info.value(QStringLiteral("formats")).toArray();
        QSet<int> heights;
        bool hasAudio = false;
        for (const QJsonValue &fv : formats) {
            const QJsonObject f = fv.toObject();
            const QString vcodec = f.value(QStringLiteral("vcodec")).toString();
            const QString acodec = f.value(QStringLiteral("acodec")).toString();
            const int h = f.value(QStringLiteral("height")).toInt();
            if (acodec != QLatin1String("none") && !acodec.isEmpty())
                hasAudio = true;
            if (vcodec != QLatin1String("none") && !vcodec.isEmpty() && h > 0)
                heights.insert(h);
        }
        QList<int> sorted = heights.values();
        std::sort(sorted.begin(), sorted.end(), std::greater<int>());

        QJsonArray quals;
        for (int h : sorted)
            quals.append(QJsonObject{{"height", h}, {"label", QStringLiteral("%1p").arg(h)}});

        sendFramed(sock, QJsonObject{{"ok", true},
                                     {"hasAudio", hasAudio},
                                     {"title", info.value(QStringLiteral("title")).toString()},
                                     {"qualities", quals}});
        proc->deleteLater();
        delete out;
    });
    // -J extraction is network-bound (a few seconds); the host waits for us.
    proc->start(QStringLiteral("yt-dlp"),
                {QStringLiteral("-J"), QStringLiteral("--no-warnings"),
                 QStringLiteral("--no-playlist"), url.toString()});
    if (!proc->waitForStarted(3000)) {
        sendFramed(sock, QJsonObject{{"ok", false}, {"message", "yt-dlp not available"}});
        proc->deleteLater();
        delete out;
    }
}

} // namespace nexa
