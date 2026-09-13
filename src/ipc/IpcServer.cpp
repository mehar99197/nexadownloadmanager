#include "ipc/IpcServer.h"
#include "ipc/IpcProtocol.h"
#include "core/DownloadEngine.h"
#include "core/ExternalTools.h"
#include "auth/AuthenticationManager.h"
#include "auth/CloudProviders.h"
#include "web/PublicUrlPolicy.h"
#include "site/YtDlpGrabber.h"

#include <QLocalServer>
#include <QLocalSocket>
#include <QJsonDocument>
#include <QJsonObject>
#include <QCoreApplication>
#include <QJsonValue>
#include <QJsonArray>
#include <QProcess>
#include <QSet>
#include <QHash>
#include <QUrl>
#include <QRegularExpression>
#include <QAbstractSocket>
#include <QTimer>
#include <QDebug>
#include <QPointer>
#include <algorithm>
#include <memory>

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
    // Idempotent: a second call must not strand the listener the first one
    // created (it stays parented to us and keeps accepting connections).
    if (m_server && m_server->isListening())
        return true;

    // Only clear the socket file if it is truly STALE (no live peer answers). If
    // a real instance is already listening, return false so the caller forwards
    // its work to that instance and exits instead of stealing the socket and
    // opening a duplicate window. Probe BEFORE allocating, so the common
    // "another instance owns it" path allocates nothing at all.
    {
        QLocalSocket probe;
        probe.connectToServer(name);
        const bool alive = probe.waitForConnected(200);
        probe.abort();
        if (alive)
            return false;                    // a real instance owns it
    }

    delete m_server;                          // no-op when null; clears a failed attempt
    m_server = new QLocalServer(this);
    // Restrict the socket to the current user so another local account can't
    // inject downloads (incl. file:// reads) through our IPC channel.
    m_server->setSocketOptions(QLocalServer::UserAccessOption);
    // Try to bind. Only remove the socket file when it's CONFIRMED stale (no live
    // peer) — blindly removeServer()-then-listen could delete a socket a
    // concurrently-starting instance just bound (probe/bind race).
    if (!m_server->listen(name)) {
        if (m_server->serverError() != QAbstractSocket::AddressInUseError) {
            qWarning() << "Nexa IPC listen failed:" << m_server->errorString();
            delete m_server;
            m_server = nullptr;
            return false;
        }
        QLocalSocket probe2;
        probe2.connectToServer(name);
        if (probe2.waitForConnected(200)) {   // someone won the race — yield to them
            probe2.abort();
            delete m_server;
            m_server = nullptr;
            return false;
        }
        probe2.abort();
        QLocalServer::removeServer(name);     // confirmed stale file from a crash
        if (!m_server->listen(name)) {
            qWarning() << "Nexa IPC listen failed:" << m_server->errorString();
            delete m_server;
            m_server = nullptr;
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
    for (;;) {
        const QByteArray buf = sock->peek(sock->bytesAvailable());
        if (buf.size() < 4)
            return;
        const quint32 len = quint32((quint8)buf[0]) | (quint32((quint8)buf[1]) << 8) |
                            (quint32((quint8)buf[2]) << 16) | (quint32((quint8)buf[3]) << 24);
        if (len == 0 || len > kMaxIpcFrameBytes) { // refuse and drop the peer
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

namespace {

// Assemble the headers a peer captured for a request — cookies, UA, referrer and
// any extra "headers" (object {name:value} or array [[name,value],…]). Every
// value goes through the same control-char guard so an untrusted extension
// can't smuggle/inject headers, and framing headers are never accepted.
HeaderList headersFromPayload(const QJsonObject &obj)
{
    auto headerSafe = [](const QString &s) {
        for (const QChar c : s)
            if (c < QChar(0x20) || c == QChar(0x7f))
                return false;
        return true;
    };
    static const QSet<QString> kDeniedHeaders = {
        QStringLiteral("host"), QStringLiteral("content-length"),
        QStringLiteral("transfer-encoding"), QStringLiteral("connection")};

    HeaderList headers;
    const QString cookies   = obj.value(QStringLiteral("cookies")).toString();
    const QString userAgent = obj.value(QStringLiteral("userAgent")).toString();
    const QString referrer  = obj.value(QStringLiteral("referrer")).toString();
    if (!cookies.isEmpty()   && headerSafe(cookies))   headers.append({QByteArrayLiteral("Cookie"),     cookies.toUtf8()});
    if (!userAgent.isEmpty() && headerSafe(userAgent)) headers.append({QByteArrayLiteral("User-Agent"), userAgent.toUtf8()});
    if (!referrer.isEmpty()  && headerSafe(referrer))  headers.append({QByteArrayLiteral("Referer"),    referrer.toUtf8()});

    auto add = [&](const QString &name, const QString &value) {
        if (name.isEmpty() || kDeniedHeaders.contains(name.toLower()))
            return;   // never let a peer set Host/Content-Length/etc.
        if (headerSafe(name) && headerSafe(value))
            headers.append({name.toUtf8(), value.toUtf8()});
    };
    const QJsonValue extra = obj.value(QStringLiteral("headers"));
    if (extra.isObject()) {
        const QJsonObject o = extra.toObject();
        for (auto it = o.begin(); it != o.end(); ++it)
            add(it.key(), it.value().toString());
    } else if (extra.isArray()) {
        const QJsonArray a = extra.toArray();
        for (const QJsonValue &v : a) {
            const QJsonArray pair = v.toArray();
            if (pair.size() == 2)
                add(pair.at(0).toString(), pair.at(1).toString());
        }
    }
    return headers;
}

} // namespace

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

    // "ping": the extension popup asks whether the app is alive and what it's
    // doing. (Reaching this code at all proves the host + app are installed.)
    if (type == QStringLiteral("ping")) {
        int active = 0, queued = 0;
        for (const auto &snap : m_engine->snapshot()) {
            if (snap.state == DownloadState::Downloading || snap.state == DownloadState::Probing)
                ++active;
            else if (snap.state == DownloadState::Queued)
                ++queued;
        }
        sendReply(QJsonObject{{"ok", true},
                              {"version", QCoreApplication::applicationVersion()},
                              {"plan", m_engine->licensePlan()},
                              {"active", active},
                              {"queued", queued}});
        return;
    }

    // "links": a page's harvested links for the link-grabber dialog. Validated
    // exactly like a single download target (scheme allowlist, real host, public
    // network only), de-duplicated and capped so a hostile page can't flood us.
    if (type == QStringLiteral("links")) {
        constexpr int kMaxLinks = 2000;
        const QUrl pageUrl = QUrl::fromUserInput(obj.value(QStringLiteral("pageUrl")).toString());
        const QString pageTitle = obj.value(QStringLiteral("pageTitle")).toString().simplified().left(200);
        const QJsonArray arr = obj.value(QStringLiteral("links")).toArray();
        QVector<LinkItem> items;
        QSet<QString> seen;
        for (const QJsonValue &v : arr) {
            if (items.size() >= kMaxLinks)
                break;
            const QJsonObject o = v.toObject();
            const QUrl u = QUrl::fromUserInput(o.value(QStringLiteral("url")).toString().trimmed());
            const QString sch = u.scheme().toLower();
            if (!u.isValid() || (sch != QLatin1String("http") && sch != QLatin1String("https"))
                || u.host().isEmpty() || !isPublicHttpUrl(u))
                continue;
            const QString key = u.toString();
            if (seen.contains(key))
                continue;
            seen.insert(key);
            QString kind = o.value(QStringLiteral("kind")).toString();
            if (kind != QLatin1String("image") && kind != QLatin1String("media"))
                kind = QStringLiteral("link");
            items.append({key, o.value(QStringLiteral("text")).toString().simplified().left(200), kind});
        }
        if (items.isEmpty()) {
            sendReply(QJsonObject{{"ok", false}, {"message", "no downloadable links on this page"}});
            return;
        }
        const QString page = (pageUrl.isValid() && !pageUrl.host().isEmpty()) ? pageUrl.toString() : QString();
        emit linksReceived(page, pageTitle, items, headersFromPayload(obj));
        sendReply(QJsonObject{{"ok", true}, {"count", items.size()}});
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
    // Browser/native requests are untrusted entry points. Keep private-network
    // targets available to the explicit desktop UI, but do not let a web page
    // turn Nexa into a localhost/LAN/cloud-metadata fetch primitive.
    if ((scheme == QStringLiteral("http") || scheme == QStringLiteral("https"))
        && !isPublicHttpUrl(url)) {
        sendReply(QJsonObject{{"ok", false}, {"message", "private network target rejected"}});
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
            const QString host = url.host().toLower();
            const QString domain = authDomain.toLower();
            const bool sameDomain = host == domain || host.endsWith(QLatin1Char('.') + domain);
            const bool approvedSibling = m_engine->providers()
                && m_engine->providers()->sameCredentialScope(host, domain);
            if (!sameDomain && !approvedSibling) {
                sendReply(QJsonObject{{"ok", false}, {"message", "auth domain does not match URL"}});
                return;
            }
            AuthResult ar = AuthResult::success();
            // Only cookie TEXT or a bearer token are accepted from this untrusted
            // channel. We deliberately do NOT accept an authCookiesFile path — that
            // would let any local peer make Nexa read an arbitrary file (~/.ssh/…).
            const QString cookiesText = obj.value(QStringLiteral("authCookiesText")).toString();
            const QString bearer      = obj.value(QStringLiteral("bearer")).toString();
            if (!bearer.isEmpty() && scheme != QStringLiteral("https")) {
                sendReply(QJsonObject{{"ok", false},
                                      {"message", "bearer credentials require HTTPS"}});
                return;
            }
            // For yt-dlp auth sites (Udemy, Vimeo, Coursera, etc.), the engine
            // registered --cookies-from-browser at startup via
            // autoEnableBrowserLogins(): yt-dlp then reads the browser's LIVE
            // jar on every run, which stays correct for the whole session,
            // whereas the extension's export is a snapshot. So on Linux/macOS
            // keep the browser credential when one exists — registering the
            // export would replace it for the session (refreshBrowserLoginFor
            // never overrides a cookies.txt) and later pasted URLs would run
            // on stale cookies. Windows is the exception: Chrome / Edge / Brave
            // 127+ App-Bound Encryption makes the store unreadable to yt-dlp,
            // browserlogin::detectBrowser() therefore never registers a
            // Chromium credential there, and the export — from the very
            // browser the user clicked in — is the one that works. A Firefox
            // credential on Windows is readable but may be the wrong browser
            // for this click, so the export still wins there.
            // Use YtDlpGrabber::isSiteVideoUrl — its hardcoded fallback means
            // this still works when CloudProviders fails to load at startup.
#ifdef Q_OS_WIN
            const bool keepBrowserCookies = false;
#else
            const bool keepBrowserCookies = YtDlpGrabber::isSiteVideoUrl(url)
                && am->resolve(url).kind == DomainAuth::Kind::BrowserCookies;
#endif
            if (!cookiesText.isEmpty() && !keepBrowserCookies) {
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

    const HeaderList headers = headersFromPayload(obj);

    const QString suggestedName = obj.value(QStringLiteral("filename")).toString();
    const QString quality = obj.value(QStringLiteral("quality")).toString();   // YouTube etc.
    const bool playlist = obj.value(QStringLiteral("playlist")).toBool(false);  // whole playlist?
    // A browser handoff can opt out of Nexa's second confirmation dialog when
    // the user has already clicked the browser's download action. Keep the
    // protocol default false so older/local callers retain the normal setting.
    // The extension's "ask before handing off" option sends ask:true — treat the
    // handoff as not-yet-confirmed so the app's confirm prompt (when enabled) runs.
    const bool ask = obj.value(QStringLiteral("ask")).toBool(false);
    const bool userInitiated = obj.value(QStringLiteral("userInitiated")).toBool(false) && !ask;
    const int id = m_engine->addDownload(url, QString(), headers, suggestedName, quality,
                                         playlist, userInitiated, QString(), true);
    if (id < 0) {
        // Say WHY when the engine can. A bare "rejected" sent Udemy users
        // hunting for a broken extension when the answer was the plan gate.
        const QString why = m_engine->blockReason(url);
        sendReply(QJsonObject{{"ok", false},
                              {"message", why.isEmpty() ? QStringLiteral("rejected") : why}});
    } else {
        sendReply(QJsonObject{{"ok", true}, {"id", id}});
    }
}

void IpcServer::listFormats(QLocalSocket *sock, const QUrl &url)
{
    if (m_formatProbes >= kMaxFormatProbes) {
        sendFramed(sock, QJsonObject{{"ok", false},
                                     {"message", "too many quality probes in flight; try again"}});
        return;
    }
    ++m_formatProbes;

    auto *proc = new QProcess(this);
    auto out = std::make_shared<QByteArray>();
    // The peer can disconnect during the multi-second `yt-dlp -J`; a raw sock would
    // dangle. A QPointer goes null on delete so the finished callback can bail.
    QPointer<QLocalSocket> safeSock(sock);
    // finished() and errorOccurred() can BOTH fire for one process (a crash
    // reports an error and then finishes), and a process that never starts fires
    // only the second. One shared latch keeps the reply, the slot release and
    // the deletion to exactly once, whichever path gets there first.
    auto settled = std::make_shared<bool>(false);
    auto settle = [this, settled, proc, safeSock](const QJsonObject &reply) {
        if (*settled)
            return;
        *settled = true;
        --m_formatProbes;
        if (safeSock)
            sendFramed(safeSock, reply);
        if (proc->state() != QProcess::NotRunning)
            proc->kill();
        proc->deleteLater();
    };
    // A hung probe must not hold its slot — or the peer's reply — forever.
    // Parented to `proc`, so settling early cancels it.
    QTimer::singleShot(kFormatProbeTimeoutMs, proc, [settle]() {
        settle(QJsonObject{{"ok", false}, {"message", "quality probe timed out"}});
    });
    connect(proc, &QProcess::errorOccurred, this, [settle](QProcess::ProcessError error) {
        // Only the never-started case is terminal here; a crash also reaches
        // finished(), which reports it with its exit status.
        if (error == QProcess::FailedToStart)
            settle(QJsonObject{{"ok", false}, {"message", "yt-dlp not available"}});
    });
    connect(proc, &QProcess::readyReadStandardOutput, this,
            [proc, out]() {
        if (out->size() < 8 * 1024 * 1024)   // cap at 8 MB (M8 fix)
            out->append(proc->readAllStandardOutput());
    });
    connect(proc, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished), this,
            [settle, out](int exitCode, QProcess::ExitStatus status) {
        if (status != QProcess::NormalExit || exitCode != 0) {
            // A failed probe is NOT "this video has no formats". Replying ok
            // with an empty list made every yt-dlp failure — an unsupported
            // site, an expired session, a missing JS runtime — look to the
            // extension like a video with nothing to download.
            settle(QJsonObject{{"ok", false},
                               {"message", "yt-dlp could not read this video's formats"}});
            return;
        }
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
            // Consumer resolution tiers, tested high -> low so the FIRST match
            // wins. The previous `h >= 2160 -> "4K"` test had no 4320 arm, so
            // every 8K stream was labelled "4320p60 4K"; likewise 1440p was
            // labelled "HD", a name that properly belongs to 720p.
            const QString note = h >= 4320 ? QStringLiteral("8K")
                               : h >= 2880 ? QStringLiteral("5K")
                               : h >= 2160 ? QStringLiteral("4K")
                               : h >= 1440 ? QStringLiteral("2K")
                               : h >= 1080 ? QStringLiteral("FHD")
                               : h >= 720  ? QStringLiteral("HD")
                                           : QStringLiteral("SD");
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

        settle(QJsonObject{{"ok", true},
                           {"hasAudio", hasAudio},
                           {"title", info.value(QStringLiteral("title")).toString()},
                           {"qualities", quals},
                           {"audioFormats", audioQuals}});
    });
    // -J extraction is network-bound (a few seconds); the host waits for us.
    // `--` ends option parsing so a URL starting with '-' can't be read as a flag.
    // yt-dlp needs a JS runtime for YouTube n-sig/po-token challenges; without it
    // the -J probe returns no (or stale) formats for modern YouTube. Pass every
    // common runtime and let yt-dlp pick the first available.
    QStringList args = {QStringLiteral("-J"), QStringLiteral("--no-warnings"),
                        QStringLiteral("--no-playlist"),
                        QStringLiteral("--js-runtimes"),
                        QStringLiteral("node"),
                        QStringLiteral("--js-runtimes"),
                        QStringLiteral("deno"),
                        QStringLiteral("--js-runtimes"),
                        QStringLiteral("bun"),
                        QStringLiteral("--remote-components"),
                        QStringLiteral("ejs:github")};
    // Forward domain-scoped auth so login-gated sites (Udemy, etc.) return real
    // qualities instead of the fallback list. Without this the -J probe has no
    // session and the server returns an error / empty formats.
    if (AuthenticationManager *am = m_engine->auth())
        args << am->ytDlpArgs(url);
    args << QStringLiteral("--") << url.toString();
    // Bundled yt-dlp sits beside the app, which isn't on PATH on Windows — resolve
    // the absolute path so the qualities probe works there too.
    proc->start(resolveTool(QStringLiteral("yt-dlp")), args);
    proc->closeWriteChannel();   // EOF stdin — prevents interactive-prompt hang
    // No waitForStarted() here. It blocked the GUI thread for up to three
    // seconds — every download, timer and repaint in this single-threaded app
    // stopped with it — on the exact machines where exec is slowest (cold cache,
    // on-access antivirus). The errorOccurred handler above reports a failed
    // start asynchronously instead.
}

} // namespace nexa
