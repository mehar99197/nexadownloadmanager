// End-to-end DownloadTask against a tiny Range-capable HTTP server:
// probe -> worker-thread preallocation -> 8 segmented connections -> Completed.
//
// Guards the download-start path that froze the window on Windows (segment
// workers writing at high offsets into a freshly sized NTFS file, which
// zero-fills up to its valid-data-length inside the first such write) and the
// asynchronous continuation that replaced the synchronous preallocation: the
// state must pass through "allocating … on disk" before "8 connection(s)", the
// bytes must land exactly, and on Windows the file must really be sparse.
#include "core/DownloadTask.h"

#include <QCoreApplication>
#include <QFile>
#include <QHostAddress>
#include <QNetworkAccessManager>
#include <QRegularExpression>
#include <QStringList>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTemporaryDir>
#include <QTimer>
#include <cstdio>
#include <memory>

#ifdef Q_OS_WIN
#include <windows.h>
#endif

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

    // 3 MiB: DownloadTask::preferredSegmentCount() splits that 8 ways, so the
    // highest segment writes at ~2.6 MiB while the file's first bytes are still
    // unwritten — the exact zero-fill trigger.
    QByteArray body(3 * 1024 * 1024, Qt::Uninitialized);
    for (int i = 0; i < body.size(); ++i)
        body[i] = char((i * 7 + (i >> 10)) & 0xff);

    QTcpServer server;
    CHECK(server.listen(QHostAddress::LocalHost), "test server did not start");
    if (!server.isListening())
        return 1;

    // Minimal HTTP/1.1: honours "Range: bytes=a-b" with a 206 + Content-Range
    // (the probe asks for bytes=0-0 to learn the size), answers anything else
    // with the whole object, and closes after each response.
    QObject::connect(&server, &QTcpServer::newConnection, [&]() {
        while (server.hasPendingConnections()) {
            QTcpSocket *socket = server.nextPendingConnection();
            auto request = std::make_shared<QByteArray>();
            QObject::connect(socket, &QTcpSocket::readyRead, socket, [socket, request, &body]() {
                request->append(socket->readAll());
                if (!request->contains("\r\n\r\n"))
                    return;
                static const QRegularExpression rangeRe(
                    QStringLiteral("Range:\\s*bytes=(\\d+)-(\\d+)"),
                    QRegularExpression::CaseInsensitiveOption);
                const auto m = rangeRe.match(QString::fromLatin1(*request));
                QByteArray head;
                QByteArray payload;
                if (m.hasMatch()) {
                    const qint64 from = m.captured(1).toLongLong();
                    const qint64 to = qMin<qint64>(m.captured(2).toLongLong(), body.size() - 1);
                    payload = body.mid(int(from), int(to - from + 1));
                    head = "HTTP/1.1 206 Partial Content\r\n"
                           "Content-Range: bytes " + QByteArray::number(from) + "-"
                           + QByteArray::number(to) + "/" + QByteArray::number(body.size()) + "\r\n";
                } else {
                    payload = body;
                    head = "HTTP/1.1 200 OK\r\n";
                }
                head += "Content-Length: " + QByteArray::number(payload.size()) + "\r\n"
                        "Accept-Ranges: bytes\r\nETag: \"v1\"\r\n"
                        "Content-Type: application/octet-stream\r\n"
                        "Connection: close\r\n\r\n";
                socket->write(head);
                socket->write(payload);
                socket->disconnectFromHost();
            });
            QObject::connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
        }
    });

    QTemporaryDir temp;
    CHECK(temp.isValid(), "temporary directory unavailable");
    if (!temp.isValid())
        return 1;
    const QString output = temp.filePath(QStringLiteral("big.bin"));

    QNetworkAccessManager nam;
    nexa::DownloadTask task(
        1, QUrl(QStringLiteral("http://127.0.0.1:%1/big.bin").arg(server.serverPort())),
        output, &nam, nullptr);

    QStringList details;
    nexa::DownloadState finalState = nexa::DownloadState::Queued;
    QObject::connect(&task, &nexa::DownloadTask::stateChanged,
                     [&](int, nexa::DownloadState state, const QString &detail) {
        details << detail;
        if (state == nexa::DownloadState::Completed || state == nexa::DownloadState::Error) {
            finalState = state;
            QTimer::singleShot(0, &app, &QCoreApplication::quit);
        }
    });
    QTimer::singleShot(20000, &app, &QCoreApplication::quit);   // hung test, not a hung app
    task.start();
    app.exec();

    CHECK(finalState == nexa::DownloadState::Completed, "download did not complete");
    if (finalState != nexa::DownloadState::Completed)
        std::fprintf(stderr, "  last state detail: %s\n", qPrintable(details.value(details.size() - 1)));

    const int allocAt = details.indexOf(QRegularExpression(QStringLiteral("^allocating .* on disk$")));
    const int connsAt = details.indexOf(QStringLiteral("8 connection(s)"));
    CHECK(allocAt >= 0, "no 'allocating … on disk' state: preallocation did not run off-thread");
    CHECK(connsAt >= 0, "file was not split into 8 connections");
    CHECK(allocAt < connsAt, "segments started before the file was allocated");

    CHECK(task.totalBytes() == body.size(), "probe did not learn the size");
    CHECK(task.rangesSupported(), "206 probe did not mark ranges as supported");

    QFile result(output);
    CHECK(result.open(QIODevice::ReadOnly), "output file missing");
    CHECK(result.size() == body.size(), "output size differs from the served object");
    CHECK(result.readAll() == body, "output bytes differ from the served object");
    result.close();

#ifdef Q_OS_WIN
    const DWORD attrs = GetFileAttributesW(reinterpret_cast<const wchar_t *>(output.utf16()));
    CHECK(attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_SPARSE_FILE),
          "destination was not marked sparse (NTFS zero-fill freeze would be back)");
#endif

    if (g_failures)
        std::fprintf(stderr, "%d failure(s)\n", g_failures);
    else
        std::printf("download task test ok\n");
    return g_failures ? 1 : 0;
}
