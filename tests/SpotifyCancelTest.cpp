// Pausing or removing a Spotify download while one of its fetches is out.
//
// SpotifyGrabber::cancel() — what DownloadEngine::pause() and remove() call,
// and what the destructor runs — aborted its replies without detaching their
// handlers. abort() emits finished() synchronously, so each handler ran inside
// cancel(): it took its member, set it to null and handled the cancellation as
// a failure ("could not fetch Spotify metadata: Operation canceled" on a
// download the user had just paused), or, for the cover art, as "no art", and
// went on to tag and file the half-finished track. cancel() then called
// deleteLater() through the null member and took the app down.
//
// Drives the real SpotifyGrabber against a fake server that holds the embed
// page, the preview or the cover art open. The grabber asks open.spotify.com,
// p.scdn.co and i.scdn.co by name, so the test hands it a network manager that
// sends every request to the fake server with its path intact; the grabber
// takes its manager from the engine, so no seam in the grabber was needed.
//
// Pass one case's name (embed, preview, art, destroyed) to run only that one.

#include "site/SpotifyGrabber.h"

#include <QCoreApplication>
#include <QDebug>
#include <QDir>
#include <QElapsedTimer>
#include <QEventLoop>
#include <QHash>
#include <QHostAddress>
#include <QNetworkAccessManager>
#include <QNetworkRequest>
#include <QPointer>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTemporaryDir>
#include <QTimer>
#include <functional>

using namespace nexa;

static int g_failures = 0;
#define CHECK(cond, msg) do { if (!(cond)) { qWarning() << "FAIL:" << msg; ++g_failures; } } while (0)

// ---------------------------------------------------------------------------
// The three things a preview download fetches, by path: the embed page, the
// 30-second preview and the cover art. Any of them can be held open until
// release(kind). Counts each kind.
// ---------------------------------------------------------------------------

// A one-track embed page, shaped like open.spotify.com's: the metadata is JSON
// in a __NEXT_DATA__ script, and names the preview and the cover by URL.
static const char kEmbedPage[] =
    "<html><body><script id=\"__NEXT_DATA__\" type=\"application/json\">"
    "{\"props\":{\"pageProps\":{\"state\":{\"data\":{\"entity\":{"
    "\"uri\":\"spotify:track:4uLU6hMCjMI75M1A2tKUQC\",\"name\":\"A Song\","
    "\"artists\":[{\"name\":\"An Artist\"}],"
    "\"audioPreview\":{\"url\":\"https://p.scdn.co/mp3-preview/abc\"},"
    "\"visualIdentity\":{\"image\":[{\"url\":\"https://i.scdn.co/image/abc\",\"maxHeight\":640}]},"
    "\"duration\":{\"totalMilliseconds\":30000}}}}}}}"
    "</script></body></html>";

class FakeSpotify : public QObject {
public:
    QHash<QString, int> requests;     // "embed", "preview", "art"
    QString hold;                     // the kind held open until release()

    int count(const char *kind) const { return requests.value(QLatin1String(kind)); }

    void release()
    {
        const QList<QPointer<QTcpSocket>> held = m_held;
        m_held.clear();
        for (const QPointer<QTcpSocket> &socket : held) {
            if (socket)
                answer(socket, m_heldKind);
        }
    }

    bool listen()
    {
        connect(&m_server, &QTcpServer::newConnection, this, [this]() {
            QTcpSocket *socket = m_server.nextPendingConnection();
            connect(socket, &QTcpSocket::readyRead, this, [this, socket]() {
                m_buffers[socket] += socket->readAll();
                const QByteArray &buffer = m_buffers[socket];
                const int headerEnd = buffer.indexOf("\r\n\r\n");
                if (headerEnd < 0)
                    return;
                // "GET /mp3-preview/abc HTTP/1.1" -> "preview"
                const QByteArray path = buffer.left(buffer.indexOf("\r\n")).split(' ').value(1);
                m_buffers.remove(socket);
                const QString kind = path.startsWith("/embed/")       ? QStringLiteral("embed")
                                   : path.startsWith("/mp3-preview/") ? QStringLiteral("preview")
                                   : path.startsWith("/image/")       ? QStringLiteral("art")
                                   : QString::fromLatin1(path);
                ++requests[kind];
                if (kind == hold) {
                    m_heldKind = kind;
                    m_held.append(socket);
                } else {
                    answer(socket, kind);
                }
            });
            connect(socket, &QTcpSocket::disconnected, socket, [this, socket]() {
                m_buffers.remove(socket);
                socket->deleteLater();
            });
        });
        return m_server.listen(QHostAddress::LocalHost, 0);
    }

    quint16 port() const { return m_server.serverPort(); }

private:
    static void answer(QTcpSocket *socket, const QString &kind)
    {
        QByteArray type = "text/html; charset=utf-8";
        QByteArray payload = kEmbedPage;
        if (kind == QLatin1String("preview")) {
            type = "audio/mpeg";
            payload = QByteArray(4096, 'a');
        } else if (kind == QLatin1String("art")) {
            type = "image/jpeg";
            payload = QByteArray(2048, 'i');
        }
        QByteArray response = "HTTP/1.1 200 OK\r\n";
        response += "Content-Type: " + type + "\r\n";
        response += "Content-Length: " + QByteArray::number(payload.size()) + "\r\n";
        response += "Connection: close\r\n\r\n";
        response += payload;
        socket->write(response);
        socket->flush();
        socket->disconnectFromHost();
    }

    QTcpServer m_server;
    QHash<QTcpSocket *, QByteArray> m_buffers;
    QList<QPointer<QTcpSocket>> m_held;
    QString m_heldKind;
};

// Sends every request to the fake server, keeping its path and query.
class LocalNetwork : public QNetworkAccessManager {
public:
    explicit LocalNetwork(quint16 port) : m_port(port) {}

protected:
    QNetworkReply *createRequest(Operation op, const QNetworkRequest &request,
                                 QIODevice *outgoingData) override
    {
        QUrl url = request.url();
        url.setScheme(QStringLiteral("http"));
        url.setHost(QStringLiteral("127.0.0.1"));
        url.setPort(m_port);
        QNetworkRequest local(request);
        local.setUrl(url);
        return QNetworkAccessManager::createRequest(op, local, outgoingData);
    }

private:
    quint16 m_port;
};

// ---------------------------------------------------------------------------

// Run the event loop until `done` or the timeout lapses.
static void pump(const std::function<bool()> &done, int timeoutMs = 8000)
{
    QEventLoop loop;
    QTimer tick;
    QElapsedTimer elapsed;
    elapsed.start();
    QObject::connect(&tick, &QTimer::timeout, &loop, [&]() {
        if (done() || elapsed.elapsed() > timeoutMs)
            loop.quit();
    });
    tick.start(20);
    loop.exec();
}

// Long enough for anything a cancelled download should not do to have happened.
static void settle() { pump([] { return false; }, 300); }

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    const QString only = argc > 1 ? QString::fromLocal8Bit(argv[1]) : QString();
    auto wanted = [&](const char *name) { return only.isEmpty() || only == QLatin1String(name); };

    FakeSpotify server;
    if (!server.listen()) {
        qWarning() << "FAIL: could not start the fake server";
        return 1;
    }
    LocalNetwork network(server.port());
    const QUrl track(QStringLiteral("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"));
    int nextId = 1;

    // A preview download started with `kind` held open, stopped the way pause()
    // and remove() stop it — or, with `destroy`, by deleting the grabber, as the
    // engine does after remove() and at exit. Whatever the grabber says from
    // that moment on is recorded: a download the user stopped reports nothing.
    auto stopMidFetch = [&](const char *kind, bool destroy, const QString &label) {
        QTemporaryDir saveDir;
        server.requests.clear();
        server.hold = QLatin1String(kind);

        auto *grabber = new SpotifyGrabber(nextId++, track, saveDir.path(), &network);
        grabber->setMode(QStringLiteral("preview"));     // no yt-dlp: the fetches are the point
        bool stopping = false;
        QStringList saidAfterStop;
        // Logged as it happens too: on the old code the crash came before any
        // check could report it.
        auto record = [&](const QString &what) {
            if (!stopping)
                return;
            saidAfterStop << what;
            qWarning().noquote() << label << "- said after it was stopped:" << what;
        };
        QObject::connect(grabber, &SpotifyGrabber::stateChanged, &app,
                         [&](int, DownloadState state, const QString &detail) {
            record(stateToString(state) + QStringLiteral(": ") + detail);
        });
        QObject::connect(grabber, &SpotifyGrabber::finished, &app,
                         [&](int) { record(QStringLiteral("finished")); });
        QObject::connect(grabber, &SpotifyGrabber::progress, &app,
                         [&](int, qint64 done, qint64 total, double) {
            record(QStringLiteral("progress %1/%2").arg(done).arg(total));
        });

        grabber->start();
        pump([&]() { return server.count(kind) == 1; });
        CHECK(server.count(kind) == 1, label + ": the fetch is out when the download is stopped");

        stopping = true;
        if (destroy)
            delete grabber;
        else
            grabber->cancel();
        server.release();                // what it was waiting for, too late
        settle();

        CHECK(saidAfterStop.isEmpty(),
              label + ": a stopped download reports nothing, got " + saidAfterStop.join(QStringLiteral(" | ")));
        CHECK(QDir(saveDir.path()).entryList(QDir::Files).isEmpty(),
              label + ": no half-finished track is filed in the download folder");
        if (!destroy)
            delete grabber;
    };

    if (wanted("embed"))
        stopMidFetch("embed", false, QStringLiteral("embed (paused while reading the metadata)"));
    if (wanted("preview"))
        stopMidFetch("preview", false, QStringLiteral("preview (paused while fetching the preview)"));
    if (wanted("art"))
        stopMidFetch("art", false, QStringLiteral("art (paused while fetching the cover)"));
    if (wanted("destroyed"))
        stopMidFetch("embed", true, QStringLiteral("destroyed (deleted while reading the metadata)"));

    if (g_failures == 0)
        qInfo() << "SpotifyCancel: all checks passed";
    return g_failures == 0 ? 0 : 1;
}
