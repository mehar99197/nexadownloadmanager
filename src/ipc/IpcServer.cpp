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
#include <QHash>
#include <QUrl>
#include <QRegularExpression>
#include <QAbstractSocket>
#include <QDebug>
#include <QPointer>
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
    // Only clear the socket file if it is truly STALE (no live peer answers). If
    // a real instance is already listening, return false so the caller forwards
    // its work to that instance and exits instead of stealing the socket and
    // opening a duplicate window.
    {
        QLocalSocket probe;
        probe.connectToServer(name);
        const bool alive = probe.waitForConnected(200);
        probe.abort();
        if (alive)
            return false;                    // a real instance owns it
    }
    // Restrict the socket to the current user so another local account can't
    // inject downloads (incl. file:// reads) through our IPC channel.
    m_server->setSocketOptions(QLocalServer::UserAccessOption);
    // Try to bind. Only remove the socket file when it's CONFIRMED stale (no live
    // peer) — blindly removeServer()-then-listen could delete a socket a
    // concurrently-starting instance just bound (probe/bind race).
    if (!m_server->listen(name)) {
        if (m_server->serverError() != QAbstractSocket::AddressInUseError) {
            qWarning() << "Nexa IPC listen failed:" << m_server->errorString();
            return false;
        }
        QLocalSocket probe2;
        probe2.connectToServer(name);
        if (probe2.waitForConnected(200)) {   // someone won the race — yield to them
            probe2.abort();
            return false;
        }
        probe2.abort();
        QLocalServer::removeServer(name);     // confirmed stale file from a crash
        if (!m_server->listen(name)) {
            qWarning() << "Nexa IPC listen failed:" << m_server->errorString();
            return false;
        }
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

    // Frames are [4-byte LE length][JSON]. Consume EVERY whole frame already
    // buffered (peers may coalesce several), and reject an absurd length up front
    // so a bogus/hostile prefix can't trigger a multi-gigabyte read (the old
    // `4 + len` check also overflowed for len near UINT32_MAX).
    static constexpr quint32 kMaxFrame = 8u * 1024 * 1024;   // 8 MB ceiling
    for (;;) {
        const QByteArray buf = sock->peek(sock->bytesAvailable());
        if (buf.size() < 4)
            return;
        const quint32 len = quint32((quint8)buf[0]) | (quint32((quint8)buf[1]) << 8) |
                            (quint32((quint8)buf[2]) << 16) | (quint32((quint8)buf[3]) << 24);
        if (len > kMaxFrame) {               // refuse and drop the peer
            sock->abort();
            return;
        }
        if (quint64(buf.size()) < quint64(len) + 4)   // 64-bit math: no overflow
            return;                                    // whole frame not here yet
        sock->read(4);                                 // consume length prefix
        const QByteArray json = sock->read(len);
        handlePayload(sock, json);
    }
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

    // "show": a peer (a second `nexa` launch, or the browser popup's Open-app
    // action) asks the running instance to surface its window. No URL required.
    if (type == QStringLiteral("show")) {
        emit showWindowRequested();
        sendReply(QJsonObject{{"ok", true}});
        return;
    }

    const QUrl url = QUrl::fromUserInput(obj.value(QStringLiteral("url")).toString());
    // Require an explicit, allowlisted scheme — never file:// (local-file read) or
    // other schemes that QUrl::fromUserInput would happily accept — AND a real
    // host for http(s), so its heuristics can't upgrade a bare/relative token into
    // an unintended target.
    static const QSet<QString> kAllowedSchemes = {
        QStringLiteral("http"), QStringLiteral("https"), QStringLiteral("magnet")};
    const QString scheme = url.scheme().toLower();
    if (!url.isValid() || scheme.isEmpty()) {
        sendReply(QJsonObject{{"ok", false}, {"message", "invalid url"}});
        return;
    }
    if (!kAllowedSchemes.contains(scheme)) {
        sendReply(QJsonObject{{"ok", false}, {"message", "unsupported url scheme"}});
        return;
    }
    if ((scheme == QStringLiteral("http") || scheme == QStringLiteral("https"))
        && url.host().isEmpty()) {
        sendReply(QJsonObject{{"ok", false}, {"message", "invalid url host"}});
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
            // Validate the domain is a plain hostname (no path/scheme/wildcard) so
            // a local peer can't poison the auth store for an arbitrary scope.
            static const QRegularExpression domRe(QStringLiteral("\\A[A-Za-z0-9.-]{1,253}\\z"));
            if (!domRe.match(authDomain).hasMatch() || authDomain.startsWith(QLatin1Char('.'))) {
                sendReply(QJsonObject{{"ok", false}, {"message", "invalid auth domain"}});
                return;
            }
            AuthResult ar = AuthResult::success();
            // Only cookie TEXT or a bearer token are accepted from this untrusted
            // channel. We deliberately do NOT accept an authCookiesFile path — that
            // would let any local peer make Nexa read an arbitrary file (~/.ssh/…).
            const QString cookiesText = obj.value(QStringLiteral("authCookiesText")).toString();
            const QString bearer      = obj.value(QStringLiteral("bearer")).toString();
            if (!cookiesText.isEmpty()) {
                ar = am->registerCookieData(authDomain, cookiesText);
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

    // Reject header names/values carrying any control char (incl. TAB) or DEL so
    // an untrusted extension can't smuggle extra headers via injection.
    auto headerSafe = [](const QString &s) {
        for (const QChar c : s)
            if (c < QChar(0x20) || c == QChar(0x7f))
                return false;
        return true;
    };
    // Headers a remote peer must never set on our request (request smuggling /
    // framing). The injection guard above blocks CR/LF; this blocks misuse of
    // otherwise-valid header names.
    static const QSet<QString> kDeniedHeaders = {
        QStringLiteral("host"), QStringLiteral("content-length"),
        QStringLiteral("transfer-encoding"), QStringLiteral("connection")};

    // Assemble the headers the extension captured for this request — every value
    // goes through the same CR/LF injection guard (cookies/UA/referrer included).
    HeaderList headers;
    const QString cookies   = obj.value(QStringLiteral("cookies")).toString();
    const QString userAgent = obj.value(QStringLiteral("userAgent")).toString();
    const QString referrer  = obj.value(QStringLiteral("referrer")).toString();
    if (!cookies.isEmpty()   && headerSafe(cookies))   headers.append({QByteArrayLiteral("Cookie"),     cookies.toUtf8()});
    if (!userAgent.isEmpty() && headerSafe(userAgent)) headers.append({QByteArrayLiteral("User-Agent"), userAgent.toUtf8()});
    if (!referrer.isEmpty()  && headerSafe(referrer))  headers.append({QByteArrayLiteral("Referer"),    referrer.toUtf8()});

    const QJsonObject extra = obj.value(QStringLiteral("headers")).toObject();
    for (auto it = extra.begin(); it != extra.end(); ++it) {
        const QString v = it.value().toString();
        if (kDeniedHeaders.contains(it.key().toLower()))
            continue;   // never let a peer set Host/Content-Length/etc.
        if (headerSafe(it.key()) && headerSafe(v))
            headers.append({it.key().toUtf8(), v.toUtf8()});
    }

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
    auto out = std::make_shared<QByteArray>();
    // The peer can disconnect during the multi-second `yt-dlp -J`; a raw sock would
    // dangle. A QPointer goes null on delete so the finished callback can bail.
    QPointer<QLocalSocket> safeSock(sock);
    connect(proc, &QProcess::readyReadStandardOutput, this,
            [proc, out]() {
        if (out->size() < 8 * 1024 * 1024)   // cap at 8 MB (M8 fix)
            out->append(proc->readAllStandardOutput());
    });
    connect(proc, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished), this,
            [this, safeSock, proc, out](int, QProcess::ExitStatus) {
        if (!safeSock) { proc->deleteLater(); return; }
        QLocalSocket *sock = safeSock;
        // Collect EVERY distinct video height yt-dlp reports (audio is muxed in
        // separately, so a video-only DASH format like 2160p still counts). For
        // each height keep the highest frame-rate seen so a quality can be
        // labelled like YouTube's own menu — "2160p60", "1080p60".
        const QJsonObject info = QJsonDocument::fromJson(*out).object();
        const QJsonArray formats = info.value(QStringLiteral("formats")).toArray();
        QHash<int, int> heightFps;     // video height -> max fps
        bool hasAudio = false;
        // audio-only formats: key = "ext:abr", value = abr (keep highest per key)
        QMap<QString, int> audioMap;
        for (const QJsonValue &fv : formats) {
            const QJsonObject f = fv.toObject();
            const QString vcodec = f.value(QStringLiteral("vcodec")).toString();
            const QString acodec = f.value(QStringLiteral("acodec")).toString();
            const int h = f.value(QStringLiteral("height")).toInt();
            const int fps = int(f.value(QStringLiteral("fps")).toDouble() + 0.5);
            if (acodec != QLatin1String("none") && !acodec.isEmpty())
                hasAudio = true;
            if (vcodec != QLatin1String("none") && !vcodec.isEmpty() && h > 0) {
                heightFps[h] = qMax(heightFps.value(h, 0), fps);
            } else if (acodec != QLatin1String("none") && !acodec.isEmpty()) {
                // audio-only format
                const QString ext = f.value(QStringLiteral("ext")).toString();
                const int abr = int(f.value(QStringLiteral("abr")).toDouble() + 0.5);
                if (!ext.isEmpty() && abr > 0) {
                    const QString key = ext + QLatin1Char(':') + QString::number(abr);
                    audioMap[key] = abr;
                }
            }
        }
        QList<int> sorted = heightFps.keys();
        std::sort(sorted.begin(), sorted.end(), std::greater<int>());

        QJsonArray quals;
        for (int h : sorted) {
            const int fps = heightFps.value(h);
            QString label = QStringLiteral("%1p").arg(h);
            if (fps >= 50)                       // annotate high frame-rates only
                label += QString::number(fps);   // e.g. "1080p60"
            const QString note = h >= 2160 ? QStringLiteral("4K")
                               : h >= 1080 ? QStringLiteral("HD")
                                           : QString();
            quals.append(QJsonObject{{"height", h}, {"fps", fps},
                                     {"label", label}, {"note", note}});
        }

        // Build audio format list — m4a only (webm/opus excluded: less compatible,
        // confusing to users, and yt-dlp selects best m4a automatically).
        struct AudioEntry { QString ext; int abr; };
        QList<AudioEntry> audioList;
        for (auto it = audioMap.cbegin(); it != audioMap.cend(); ++it) {
            const QStringList parts = it.key().split(QLatin1Char(':'));
            if (parts.size() == 2 && parts[0] == QStringLiteral("m4a"))
                audioList.append({parts[0], parts[1].toInt()});
        }
        std::sort(audioList.begin(), audioList.end(),
                  [](const AudioEntry &a, const AudioEntry &b) {
            return a.abr != b.abr ? a.abr > b.abr : a.ext < b.ext;
        });
        QJsonArray audioQuals;
        for (const AudioEntry &ae : audioList) {
            audioQuals.append(QJsonObject{
                {"ext",     ae.ext},
                {"abr",     ae.abr},
                {"label",   QStringLiteral("Audio only (m4a) · %1k").arg(ae.abr)},
                {"quality", QStringLiteral("audio:%1:%2").arg(ae.ext).arg(ae.abr)}
            });
        }

        sendFramed(sock, QJsonObject{{"ok", true},
                                     {"hasAudio", hasAudio},
                                     {"title", info.value(QStringLiteral("title")).toString()},
                                     {"qualities", quals},
                                     {"audioFormats", audioQuals}});
        proc->deleteLater();
    });
    // -J extraction is network-bound (a few seconds); the host waits for us.
    // `--` ends option parsing so a URL starting with '-' can't be read as a flag.
    QStringList args = {QStringLiteral("-J"), QStringLiteral("--no-warnings"),
                        QStringLiteral("--no-playlist")};
    // Forward domain-scoped auth so login-gated sites (Udemy, etc.) return real
    // qualities instead of the fallback list. Without this the -J probe has no
    // session and the server returns an error / empty formats.
    if (AuthenticationManager *am = m_engine->auth())
        args << am->ytDlpArgs(url);
    args << QStringLiteral("--") << url.toString();
    proc->start(QStringLiteral("yt-dlp"), args);
    proc->closeWriteChannel();   // EOF stdin — prevents interactive-prompt hang
    if (!proc->waitForStarted(3000)) {
        sendFramed(sock, QJsonObject{{"ok", false}, {"message", "yt-dlp not available"}});
        proc->deleteLater();
    }
}

} // namespace nexa
