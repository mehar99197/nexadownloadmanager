#include "core/SegmentDownloader.h"

#include <QCoreApplication>
#include <QFile>
#include <QHostAddress>
#include <QTimer>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTemporaryDir>
#include <cstdio>
#include <memory>

static int g_failures = 0;

#define CHECK(expr, message) do { \
    if (!(expr)) { \
        std::fprintf(stderr, "FAIL: %s\n", message); \
        ++g_failures; \
    } \
} while (false)

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    QTcpServer server;
    CHECK(server.listen(QHostAddress::LocalHost), "test server did not start");
    if (!server.isListening())
        return 1;

    const QByteArray body = QByteArrayLiteral("0123456789");
    QObject::connect(&server, &QTcpServer::newConnection, [&]() {
        while (server.hasPendingConnections()) {
            QTcpSocket *socket = server.nextPendingConnection();
            QObject::connect(socket, &QTcpSocket::readyRead, socket, [socket, body]() {
                if (!socket->readAll().contains("\r\n\r\n"))
                    return;
                // Deliberately ignore the requested non-zero Range and return a
                // whole-object 200 response. The downloader must reject it.
                socket->write("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n"
                              "Connection: close\r\n\r\n");
                socket->write(body);
                socket->disconnectFromHost();
            });
        }
    });

    QTemporaryDir temp;
    CHECK(temp.isValid(), "temporary directory unavailable");
    if (!temp.isValid())
        return 1;
    const QString output = temp.filePath(QStringLiteral("range.bin"));

    nexa::SegmentInfo segment;
    segment.index = 0;
    segment.start = 10;
    segment.end = 19;
    nexa::SegmentDownloader worker(
        segment,
        QUrl(QStringLiteral("http://127.0.0.1:%1/file").arg(server.serverPort())),
        output, {}, nullptr);

    bool failed = false;
    QObject::connect(&worker, &nexa::SegmentDownloader::failed,
                     [&](int, const QString &reason) {
        failed = reason.contains(QStringLiteral("range"), Qt::CaseInsensitive);
        app.quit();
    });
    QObject::connect(&worker, &nexa::SegmentDownloader::completed,
                     [&](int) { app.quit(); });
    QTimer::singleShot(3000, &app, &QCoreApplication::quit);
    worker.start();
    app.exec();

    CHECK(failed, "range-ignoring 200 response was accepted");
    QFile result(output);
    CHECK(!result.exists() || result.size() == 0,
          "range-ignoring response wrote bytes before rejection");

    // ---- A non-2xx body must never reach the output file ------------------
    // responseValidationError() defers every status >= 300 to onFinished(), so
    // nothing aborts the reply while its body streams in. Before the guard in
    // pump(), that body (a 403 auth page, a 3xx redirect page, a 5xx error page)
    // was written AT THE SEGMENT'S OFFSET and counted as progress — silent
    // corruption of the output, and of any later resume from the saved offset.
    QTcpServer errServer;
    CHECK(errServer.listen(QHostAddress::LocalHost), "error test server did not start");
    const QByteArray errPage = QByteArrayLiteral(
        "<html><body>403 Forbidden - please sign in</body></html>");
    QObject::connect(&errServer, &QTcpServer::newConnection, [&]() {
        while (errServer.hasPendingConnections()) {
            QTcpSocket *socket = errServer.nextPendingConnection();
            QObject::connect(socket, &QTcpSocket::readyRead, socket, [socket, errPage]() {
                if (!socket->readAll().contains("\r\n\r\n"))
                    return;
                socket->write("HTTP/1.1 403 Forbidden\r\nContent-Length: "
                              + QByteArray::number(errPage.size())
                              + "\r\nConnection: close\r\n\r\n");
                socket->write(errPage);
                socket->disconnectFromHost();
            });
        }
    });

    const QString errOutput = temp.filePath(QStringLiteral("forbidden.bin"));
    nexa::SegmentInfo errSeg;
    errSeg.index = 0;
    errSeg.start = 0;
    errSeg.end   = 99;
    nexa::SegmentDownloader errWorker(
        errSeg,
        QUrl(QStringLiteral("http://127.0.0.1:%1/file").arg(errServer.serverPort())),
        errOutput, {}, nullptr);

    bool errFailed = false;
    qint64 progressBytes = 0;
    QObject::connect(&errWorker, &nexa::SegmentDownloader::progressed,
                     [&](int, qint64 n) { progressBytes += n; });
    QObject::connect(&errWorker, &nexa::SegmentDownloader::failed,
                     [&](int, const QString &) { errFailed = true; app.quit(); });
    QObject::connect(&errWorker, &nexa::SegmentDownloader::completed,
                     [&](int) { app.quit(); });
    QTimer::singleShot(3000, &app, &QCoreApplication::quit);
    errWorker.start();
    app.exec();

    CHECK(errFailed, "403 response did not fail the segment");
    CHECK(progressBytes == 0, "403 error page was counted as download progress");
    QFile errResult(errOutput);
    CHECK(!errResult.exists() || errResult.size() == 0,
          "403 error page body was written into the output file");

    // ---- An open-ended segment must ACCEPT a 206 that reveals the real size --
    // A download whose size the probe could not establish becomes ONE segment
    // with a sentinel end (DownloadTask::buildSegments uses 1<<62), so the
    // worker asks for "bytes=0-4611686018427387904". A server that honours Range
    // answers 206 carrying the real total. responseValidationError() compared
    // that total against the sentinel — a test that is true for EVERY real file
    // size — so every such download was rejected as "out-of-bounds", and the
    // sizeDiscovered()/onSizeDiscovered() path that exists precisely for these
    // links (chunked, redirected or auth-gated responses whose length only the
    // live transfer reveals) could never run.
    QTcpServer openServer;
    CHECK(openServer.listen(QHostAddress::LocalHost), "open-ended test server did not start");
    QObject::connect(&openServer, &QTcpServer::newConnection, [&]() {
        while (openServer.hasPendingConnections()) {
            QTcpSocket *socket = openServer.nextPendingConnection();
            auto request = std::make_shared<QByteArray>();
            QObject::connect(socket, &QTcpSocket::readyRead, socket, [socket, body, request]() {
                request->append(socket->readAll());
                if (!request->contains("\r\n\r\n"))
                    return;
                CHECK(request->contains("Range: bytes=0-"),
                      "open-ended segment sent no Range header");
                // Honour the range, clamping the sentinel end to the real last
                // byte — what any conforming server does with an over-long end.
                socket->write("HTTP/1.1 206 Partial Content\r\n"
                              "Content-Range: bytes 0-9/10\r\n"
                              "Content-Length: 10\r\n"
                              "Accept-Ranges: bytes\r\n"
                              "Connection: close\r\n\r\n");
                socket->write(body);
                socket->disconnectFromHost();
            });
        }
    });

    const QString openOutput = temp.filePath(QStringLiteral("openended.bin"));
    nexa::SegmentInfo openSeg;
    openSeg.index = 0;
    openSeg.start = 0;
    openSeg.end   = qint64(1) << 62;   // the unknown-size sentinel
    nexa::SegmentDownloader openWorker(
        openSeg,
        QUrl(QStringLiteral("http://127.0.0.1:%1/file").arg(openServer.serverPort())),
        openOutput, {}, nullptr);

    bool openFailed = false, openCompleted = false, openShort = false, sizeSeen = false;
    qint64 discoveredTotal = -1;
    bool discoveredRanges = false;
    QObject::connect(&openWorker, &nexa::SegmentDownloader::sizeDiscovered,
                     [&](qint64 total, bool rangesSupported) {
        sizeSeen = true;
        discoveredTotal = total;
        discoveredRanges = rangesSupported;
        // Mirror DownloadTask::onSizeDiscovered: clamp the open-ended segment to
        // the real last byte so it finishes at EOF rather than relying on the
        // server to close the connection.
        openWorker.setEnd(total - 1);
    });
    QObject::connect(&openWorker, &nexa::SegmentDownloader::failed,
                     [&](int, const QString &reason) {
        openFailed = true;
        std::fprintf(stderr, "  open-ended segment failed: %s\n", qPrintable(reason));
        app.quit();
    });
    QObject::connect(&openWorker, &nexa::SegmentDownloader::completed,
                     [&](int) { openCompleted = true; app.quit(); });
    QObject::connect(&openWorker, &nexa::SegmentDownloader::shortFinish,
                     [&](int, qint64) { openShort = true; app.quit(); });
    QTimer::singleShot(3000, &app, &QCoreApplication::quit);
    openWorker.start();
    app.exec();

    CHECK(!openFailed, "a 206 revealing the real size was rejected on an open-ended segment");
    CHECK(openCompleted, "open-ended segment did not complete on a well-formed 206");
    CHECK(!openShort, "a fully-received open-ended segment was reported as a short finish");
    CHECK(sizeSeen && discoveredTotal == body.size(),
          "the live 206 did not report the real file size");
    CHECK(discoveredRanges, "a 206 on the live transfer did not report Range support");
    QFile openResult(openOutput);
    CHECK(openResult.exists() && openResult.size() == body.size(),
          "open-ended segment wrote the wrong number of bytes");
    if (openResult.open(QIODevice::ReadOnly))
        CHECK(openResult.readAll() == body, "open-ended segment wrote the wrong bytes");

    return g_failures == 0 ? 0 : 1;
}
