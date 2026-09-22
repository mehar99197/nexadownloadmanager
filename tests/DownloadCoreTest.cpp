// White-box tests for the HTTP download core: DownloadTask + SegmentDownloader
// + RateLimiter + Database, driven end to end against tiny local HTTP servers
// whose behaviour each case controls (throttling, dropped connections, chunked
// bodies, changing ETags). Every case exercises a path the happy-path
// DownloadTaskTest does not: pause/resume through the database, the per-segment
// retry budget, unknown-length downloads, validator changes between sessions,
// dynamic re-segmentation, and the schema migration of an old database.
#include "core/DownloadTask.h"
#include "core/Database.h"
#include "core/RateLimiter.h"

#include <QCoreApplication>
#include <QElapsedTimer>
#include <QEventLoop>
#include <QFile>
#include <QHostAddress>
#include <QNetworkAccessManager>
#include <QRegularExpression>
#include <QSet>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTemporaryDir>
#include <QTimer>
#include <cstdio>
#include <functional>
#include <memory>

using namespace nexa;

static int g_failures = 0;

#define CHECK(expr, message) do { \
    if (!(expr)) { \
        std::fprintf(stderr, "FAIL: %s\n", message); \
        ++g_failures; \
    } \
} while (false)

// Spin the event loop until `cond` holds or `timeoutMs` passes.
static bool waitUntil(const std::function<bool()> &cond, int timeoutMs)
{
    if (cond())
        return true;
    QEventLoop loop;
    bool ok = false;
    QTimer poll;
    poll.setInterval(10);
    QObject::connect(&poll, &QTimer::timeout, &loop, [&]() {
        if (cond()) { ok = true; loop.quit(); }
    });
    QTimer::singleShot(timeoutMs, &loop, &QEventLoop::quit);
    poll.start();
    loop.exec();
    return ok || cond();
}

static QByteArray patternBody(int size, int seed)
{
    QByteArray body(size, Qt::Uninitialized);
    for (int i = 0; i < size; ++i)
        body[i] = char((i * 7 + (i >> 10) + seed) & 0xff);
    return body;
}

// ---- A minimal HTTP/1.1 server whose response is decided per request ------
struct Request {
    QByteArray raw;
    bool   hasRange = false;
    qint64 from = 0;
    qint64 to = -1;          // -1 = open-ended ("bytes=N-")
    bool   isProbe() const { return hasRange && from == 0 && to == 0; }
    QByteArray header(const QByteArray &name) const {
        static const QRegularExpression lineRe(QStringLiteral("(?m)^([^:\\r\\n]+):[ \\t]*([^\\r\\n]*)\\r?$"));
        auto it = lineRe.globalMatch(QString::fromLatin1(raw));
        while (it.hasNext()) {
            const auto m = it.next();
            if (m.captured(1).compare(QString::fromLatin1(name), Qt::CaseInsensitive) == 0)
                return m.captured(2).toLatin1();
        }
        return QByteArray();
    }
};

class TestServer : public QObject {
public:
    using Handler = std::function<void(QTcpSocket *, const Request &)>;

    explicit TestServer(Handler handler) : m_handler(std::move(handler))
    {
        m_server.listen(QHostAddress::LocalHost);
        connect(&m_server, &QTcpServer::newConnection, this, [this]() {
            while (m_server.hasPendingConnections()) {
                QTcpSocket *socket = m_server.nextPendingConnection();
                auto buffer = std::make_shared<QByteArray>();
                connect(socket, &QTcpSocket::readyRead, socket, [this, socket, buffer]() {
                    buffer->append(socket->readAll());
                    if (!buffer->contains("\r\n\r\n") || buffer->startsWith("HANDLED"))
                        return;
                    Request req;
                    req.raw = *buffer;
                    buffer->prepend("HANDLED");   // one response per connection
                    static const QRegularExpression rangeRe(
                        QStringLiteral("Range:\\s*bytes=(\\d+)-(\\d*)"),
                        QRegularExpression::CaseInsensitiveOption);
                    const auto m = rangeRe.match(QString::fromLatin1(req.raw));
                    if (m.hasMatch()) {
                        req.hasRange = true;
                        req.from = m.captured(1).toLongLong();
                        req.to = m.captured(2).isEmpty() ? -1 : m.captured(2).toLongLong();
                    }
                    ++requests;
                    m_handler(socket, req);
                });
                connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
            }
        });
    }
    bool listening() const { return m_server.isListening(); }
    QString url(const QString &path) const
    { return QStringLiteral("http://127.0.0.1:%1/%2").arg(m_server.serverPort()).arg(path); }

    int requests = 0;

private:
    QTcpServer m_server;
    Handler    m_handler;
};

// Write `payload` in `chunk`-byte pieces every `intervalMs` (0 = all at once),
// after an initial `delayMs`, then close.
static void streamPayload(QTcpSocket *s, const QByteArray &payload, int chunk = 0,
                          int intervalMs = 0, int delayMs = 0)
{
    if (chunk <= 0 && delayMs <= 0) {
        s->write(payload);
        s->disconnectFromHost();
        return;
    }
    auto pos = std::make_shared<int>(0);
    const int step = chunk <= 0 ? payload.size() : chunk;
    auto *t = new QTimer(s);
    t->setInterval(qMax(1, intervalMs));
    QObject::connect(t, &QTimer::timeout, s, [s, payload, step, pos, t]() {
        if (s->state() != QAbstractSocket::ConnectedState) { t->stop(); return; }
        const int n = qMin(step, payload.size() - *pos);
        if (n <= 0) { t->stop(); s->disconnectFromHost(); return; }
        s->write(payload.constData() + *pos, n);
        *pos += n;
    });
    QTimer::singleShot(delayMs, t, [t]() { t->start(); });
}

// A Range-honouring 206 (or a whole-object 200 without a Range header).
static void sendRanged(QTcpSocket *s, const QByteArray &body, const Request &req,
                       const QByteArray &extraHeaders = QByteArray(),
                       int chunk = 0, int intervalMs = 0, int delayMs = 0)
{
    QByteArray head, payload;
    if (req.hasRange) {
        const qint64 from = req.from;
        const qint64 to = req.to < 0 ? body.size() - 1 : qMin<qint64>(req.to, body.size() - 1);
        payload = body.mid(int(from), int(to - from + 1));
        head = "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes "
             + QByteArray::number(from) + "-" + QByteArray::number(to) + "/"
             + QByteArray::number(body.size()) + "\r\n";
    } else {
        payload = body;
        head = "HTTP/1.1 200 OK\r\n";
    }
    head += "Content-Length: " + QByteArray::number(payload.size()) + "\r\n"
            "Accept-Ranges: bytes\r\nContent-Type: application/octet-stream\r\n"
          + extraHeaders + "Connection: close\r\n\r\n";
    s->write(head);
    streamPayload(s, payload, chunk, intervalMs, delayMs);
}

static QByteArray readFile(const QString &path)
{
    QFile f(path);
    return f.open(QIODevice::ReadOnly) ? f.readAll() : QByteArray();
}

// Runs a task to a terminal state, collecting every state detail.
struct Run {
    QStringList details;
    DownloadState last = DownloadState::Queued;
    QStringList renames;
};
static void observe(DownloadTask &task, Run &run)
{
    QObject::connect(&task, &DownloadTask::stateChanged, &task,
                     [&run](int, DownloadState s, const QString &d) { run.last = s; run.details << d; });
    QObject::connect(&task, &DownloadTask::renamedTo, &task,
                     [&run](const QString &n) { run.renames << n; });
}
static bool terminal(const Run &run)
{ return run.last == DownloadState::Completed || run.last == DownloadState::Error; }

// ---------------------------------------------------------------------------
static void testPureHelpers()
{
    CHECK(DownloadTask::preferredSegmentCount(0) == 1, "0 bytes -> 1 segment");
    CHECK(DownloadTask::preferredSegmentCount(-1) == 1, "unknown size -> 1 segment");
    CHECK(DownloadTask::preferredSegmentCount(1024 * 1024 - 1) == 1, "< 1 MB -> 1 segment");
    CHECK(DownloadTask::preferredSegmentCount(1024 * 1024) == 8, "1 MB -> 8 segments");
    CHECK(DownloadTask::preferredSegmentCount(10 * 1024 * 1024) == 16, "10 MB -> 16 segments");
    CHECK(DownloadTask::preferredSegmentCount(100 * 1024 * 1024) == 32, "100 MB -> 32 segments");

    // The licence ceiling (Entitlements::maxConnectionsPerFile) clamps the
    // ladder above without changing its shape: a paid plan reaches 32, Free
    // stops at 16, and a file too small to be worth splitting is still not
    // split on either. The clamp must never turn a 1-segment answer into more.
    CHECK(DownloadTask::preferredSegmentCount(100 * 1024 * 1024, 32) == 32, "paid ceiling -> 32");
    CHECK(DownloadTask::preferredSegmentCount(100 * 1024 * 1024, 16) == 16, "free ceiling caps 32 -> 16");
    CHECK(DownloadTask::preferredSegmentCount(10 * 1024 * 1024, 16) == 16, "10 MB unaffected by a 16 ceiling");
    CHECK(DownloadTask::preferredSegmentCount(1024 * 1024, 16) == 8, "1 MB stays 8 under a 16 ceiling");
    CHECK(DownloadTask::preferredSegmentCount(1024 * 1024, 4) == 4, "a lower ceiling also caps the 8 rung");
    CHECK(DownloadTask::preferredSegmentCount(1024 * 1024 - 1, 32) == 1, "< 1 MB is never split, ceiling or not");
    CHECK(DownloadTask::preferredSegmentCount(0, 32) == 1, "0 bytes stays 1 whatever the ceiling");
    // Defensive: a garbage/absent ceiling must not disable downloading.
    CHECK(DownloadTask::preferredSegmentCount(100 * 1024 * 1024, 0) == 32, "0 ceiling falls back to 32");
    CHECK(DownloadTask::preferredSegmentCount(100 * 1024 * 1024, -5) == 32, "negative ceiling falls back to 32");
    CHECK(DownloadTask::preferredSegmentCount(100 * 1024 * 1024, 999) == 32, "a ceiling above 32 cannot exceed 32");

    using DT = DownloadTask;
    CHECK(DT::filenameFromContentDisposition("attachment; filename=\"a b.zip\"") == "a b.zip",
          "quoted plain filename");
    CHECK(DT::filenameFromContentDisposition("attachment; filename=plain.bin") == "plain.bin",
          "unquoted plain filename");
    CHECK(DT::filenameFromContentDisposition("attachment; filename*=UTF-8''caf%C3%A9.txt")
              == QString::fromUtf8("caf\xC3\xA9.txt"), "RFC 5987 filename* is percent-decoded");
    CHECK(DT::filenameFromContentDisposition(
              "attachment; filename=\"fallback.txt\"; filename*=UTF-8''real.txt") == "real.txt",
          "filename* wins over filename");
    CHECK(DT::filenameFromContentDisposition("attachment; filename=\"../../etc/passwd\"") == "passwd",
          "path components are stripped");
    CHECK(DT::filenameFromContentDisposition("attachment; filename=\"ab:cd*ef?gh|ij.txt\"") == "abcdefghij.txt",
          "reserved characters are removed");
    CHECK(DT::filenameFromContentDisposition("inline").isEmpty(), "no filename -> empty");
    CHECK(DT::filenameFromContentDisposition(QByteArray()).isEmpty(), "empty header -> empty");
    CHECK(DT::filenameFromContentDisposition("attachment; filename*=UTF-8''C%252B%252B.pdf") == "C++.pdf",
          "double-escaped '+' (ChatGPT) decodes twice");
}

static void testRateLimiter()
{
    RateLimiter rl;
    CHECK(!rl.isLimited(), "fresh limiter is unlimited");
    CHECK(rl.consume(12345) == 12345, "unlimited grants everything");
    CHECK(rl.consume(0) == 0, "consume(0) grants 0");
    CHECK(rl.consume(-5) == 0, "negative want grants 0");

    int transitions = 0;
    bool lastLimited = false;
    QObject::connect(&rl, &RateLimiter::limitedChanged, &rl,
                     [&](bool l) { ++transitions; lastLimited = l; });
    rl.setLimit(100000);   // 100 KB/s
    CHECK(rl.isLimited() && transitions == 1 && lastLimited, "limitedChanged(true) on first limit");
    CHECK(rl.consume(50000) == 0, "budget starts empty when a limit is applied");

    int wakes = 0;
    QObject::connect(&rl, &RateLimiter::replenished, &rl, [&]() { ++wakes; });
    waitUntil([&]() { return wakes >= 4; }, 2000);
    CHECK(wakes >= 4, "replenished() ticks while limited");
    const qint64 granted = rl.consume(1000000);
    // ~200 ms at 100 KB/s is ~20 KB; accept anything between 5 KB and the 1 s cap.
    CHECK(granted >= 5000 && granted <= 100000, "budget accrues at the configured rate, capped at 1 s");
    rl.refund(granted);
    CHECK(rl.consume(granted) == granted, "refund returns the budget");
    rl.refund(10 * 1000000);
    CHECK(rl.consume(1000000) <= 100000, "refund never grows the bucket past one second");

    rl.setLimit(100000);   // same limit again: no transition
    CHECK(transitions == 1, "re-applying the same limit emits no transition");
    rl.setLimit(0);
    CHECK(!rl.isLimited() && transitions == 2 && !lastLimited, "limitedChanged(false) on unlimit");
    CHECK(rl.consume(777) == 777, "unlimited again grants everything");
    rl.setLimit(-9);
    CHECK(!rl.isLimited(), "negative limit means unlimited");
}

static void testRestoreValidation(const QTemporaryDir &temp)
{
    QNetworkAccessManager nam;
    const QUrl url(QStringLiteral("http://127.0.0.1:1/x.bin"));
    auto seg = [](int i, qint64 s, qint64 e, qint64 d) { SegmentInfo x; x.index = i; x.start = s; x.end = e; x.done = d; return x; };

    {   // Overlapping ranges must be thrown away.
        DownloadTask t(1, url, temp.filePath("r1.bin"), &nam, nullptr);
        Run run; observe(t, run);
        t.restore(100, {seg(0, 0, 60, 10), seg(1, 50, 99, 0)}, true);
        CHECK(run.last == DownloadState::Paused && run.details.last().contains("invalid"),
              "overlapping segments are rejected");
        CHECK(t.segments().isEmpty() && t.totalBytes() == -1 && t.doneBytes() == 0,
              "rejected layout is cleared");
    }
    {   // A gap must be thrown away.
        DownloadTask t(2, url, temp.filePath("r2.bin"), &nam, nullptr);
        Run run; observe(t, run);
        t.restore(100, {seg(0, 0, 40, 0), seg(1, 42, 99, 0)}, true);
        CHECK(run.details.last().contains("invalid"), "gapped segments are rejected");
    }
    {   // Not reaching the end / past the end.
        DownloadTask t(3, url, temp.filePath("r3.bin"), &nam, nullptr);
        Run run; observe(t, run);
        t.restore(100, {seg(0, 0, 98, 0)}, true);
        CHECK(run.details.last().contains("invalid"), "layout not covering the file is rejected");
        t.restore(100, {seg(0, 0, 100, 0)}, true);
        CHECK(run.details.last().contains("invalid"), "layout past the end is rejected");
    }
    {   // done > length, negative offsets, wrong index order.
        DownloadTask t(4, url, temp.filePath("r4.bin"), &nam, nullptr);
        Run run; observe(t, run);
        t.restore(10, {seg(0, 0, 9, 11)}, true);
        CHECK(run.details.last().contains("invalid"), "done past the segment length is rejected");
        t.restore(10, {seg(1, 0, 9, 0)}, true);
        CHECK(run.details.last().contains("invalid"), "non-sequential index is rejected");
        t.restore(10, {seg(0, -1, 9, 0)}, true);
        CHECK(run.details.last().contains("invalid"), "negative start is rejected");
        t.restore(10, {}, true);
        CHECK(run.details.last().contains("invalid"), "empty layout is rejected");
    }
    {   // A valid partial layout restores as Paused with the summed progress.
        DownloadTask t(5, url, temp.filePath("r5.bin"), &nam, nullptr);
        Run run; observe(t, run);
        t.restore(100, {seg(0, 0, 49, 20), seg(1, 50, 99, 5)}, false, QStringLiteral("\"e1\""));
        CHECK(run.last == DownloadState::Paused && run.details.last() == "restored", "valid layout restores");
        CHECK(t.doneBytes() == 25 && t.totalBytes() == 100, "progress is the sum of segment progress");
        CHECK(t.rangesSupported(), "multi-segment layout implies Range support (legacy rows)");
        CHECK(t.etag() == "\"e1\"", "validator is restored");
    }
    {   // Fully-done layout + a complete file on disk restores as Completed …
        const QString path = temp.filePath("r6.bin");
        QFile f(path);
        if (f.open(QIODevice::WriteOnly)) { f.write(QByteArray(10, 'x')); f.close(); }
        DownloadTask t(6, url, path, &nam, nullptr);
        Run run; observe(t, run);
        t.restore(10, {seg(0, 0, 9, 10)}, false);
        CHECK(run.last == DownloadState::Completed, "complete layout with the file present restores Completed");
    }
    {   // … but without the file it must NOT claim completion.
        DownloadTask t(7, url, temp.filePath("r7-missing.bin"), &nam, nullptr);
        Run run; observe(t, run);
        t.restore(10, {seg(0, 0, 9, 10)}, false);
        CHECK(run.last == DownloadState::Paused, "complete layout with a missing file is not Completed");
    }
    {   // Unknown total: the open-ended sentinel layout is accepted.
        DownloadTask t(8, url, temp.filePath("r8.bin"), &nam, nullptr);
        Run run; observe(t, run);
        t.restore(-1, {seg(0, 0, qint64(1) << 62, 123)}, false);
        CHECK(run.last == DownloadState::Paused && run.details.last() == "restored",
              "unknown-size layout is accepted");
        CHECK(t.doneBytes() == 123, "unknown-size progress restored");
    }
}

// An unknown-length body (chunked, no Content-Length) from a server that does
// not honour Range at all — the shape of every dynamically generated download.
// The one clean close IS the end of the file; nothing can be retried because a
// resume request to such a server can only ever come back as a 200 from byte 0.
static void testChunkedUnknownLength(const QTemporaryDir &temp)
{
    const QByteArray body = patternBody(300 * 1024, 3);
    TestServer server([&](QTcpSocket *s, const Request &) {
        s->write("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n"
                 "Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n");
        QByteArray chunked;
        for (int pos = 0; pos < body.size(); pos += 64 * 1024) {
            const QByteArray piece = body.mid(pos, 64 * 1024);
            chunked += QByteArray::number(piece.size(), 16) + "\r\n" + piece + "\r\n";
        }
        chunked += "0\r\n\r\n";
        streamPayload(s, chunked, 32 * 1024, 5);
    });
    CHECK(server.listening(), "chunked server did not start");

    QNetworkAccessManager nam;
    const QString out = temp.filePath("chunked.bin");
    DownloadTask task(20, QUrl(server.url("export.bin")), out, &nam, nullptr);
    Run run; observe(task, run);
    QElapsedTimer clock; clock.start();
    task.start();
    waitUntil([&]() { return terminal(run); }, 20000);
    CHECK(run.last == DownloadState::Completed, "chunked unknown-length download did not complete");
    if (run.last != DownloadState::Completed)
        std::fprintf(stderr, "  detail: %s\n", qPrintable(run.details.value(run.details.size() - 1)));
    CHECK(clock.elapsed() < 5000, "chunked download waited on pointless resume retries");
    CHECK(readFile(out) == body, "chunked download bytes differ");
    CHECK(task.totalBytes() == body.size(), "final size adopted from the received bytes");
    CHECK(!task.rangesSupported(), "range support must not be claimed by a 200 stream");
}

static void testProbeErrors(const QTemporaryDir &temp)
{
    QNetworkAccessManager nam;
    {   // 404 must never be written to disk.
        TestServer server([](QTcpSocket *s, const Request &) {
            const QByteArray page = "<html>gone</html>";
            s->write("HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\nContent-Length: "
                     + QByteArray::number(page.size()) + "\r\nConnection: close\r\n\r\n" + page);
            s->disconnectFromHost();
        });
        const QString out = temp.filePath("missing.zip");
        DownloadTask task(30, QUrl(server.url("missing.zip")), out, &nam, nullptr);
        Run run; observe(task, run);
        task.start();
        waitUntil([&]() { return terminal(run); }, 10000);
        CHECK(run.last == DownloadState::Error && run.details.last().contains("404"),
              "404 probe must fail with the HTTP status");
        CHECK(!QFile::exists(out), "404 must not create the destination file");
    }
    {   // An HTML page served for a non-HTML target is a login wall / error page.
        TestServer server([](QTcpSocket *s, const Request &) {
            const QByteArray page = "<html><body>Please sign in</body></html>";
            s->write("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: "
                     + QByteArray::number(page.size()) + "\r\nConnection: close\r\n\r\n" + page);
            s->disconnectFromHost();
        });
        const QString out = temp.filePath("wall.zip");
        DownloadTask task(31, QUrl(server.url("wall.zip")), out, &nam, nullptr);
        Run run; observe(task, run);
        task.start();
        waitUntil([&]() { return terminal(run); }, 10000);
        CHECK(run.last == DownloadState::Error && run.details.last().contains("web page"),
              "HTML for a .zip target must be refused");
        CHECK(!QFile::exists(out), "HTML wall must not create the destination file");
    }
    {   // … but a deliberate .html download of an HTML page is fine.
        const QByteArray page = "<html><body>hello</body></html>";
        TestServer server([&](QTcpSocket *s, const Request &req) {
            sendRanged(s, page, req, "Content-Type: text/html\r\n");
        });
        const QString out = temp.filePath("page.html");
        DownloadTask task(32, QUrl(server.url("page.html")), out, &nam, nullptr);
        Run run; observe(task, run);
        task.start();
        waitUntil([&]() { return terminal(run); }, 10000);
        CHECK(run.last == DownloadState::Completed, "an .html target may receive text/html");
        CHECK(readFile(out) == page, "html page bytes");
    }
    {   // 401 on the probe surfaces the auth reason, not a generic error.
        TestServer server([](QTcpSocket *s, const Request &) {
            s->write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            s->disconnectFromHost();
        });
        DownloadTask task(33, QUrl(server.url("private.bin")), temp.filePath("private.bin"), &nam, nullptr);
        Run run; observe(task, run);
        task.start();
        waitUntil([&]() { return terminal(run); }, 10000);
        CHECK(run.last == DownloadState::Error, "401 probe fails");
        CHECK(run.details.last() == "authentication required (HTTP 401)",
              "401 carries the auth-specific detail, not the generic HTTP one");
    }
}

static void testContentDispositionRename(const QTemporaryDir &temp)
{
    const QByteArray body = patternBody(64 * 1024, 9);
    TestServer server([&](QTcpSocket *s, const Request &req) {
        sendRanged(s, body, req, "Content-Disposition: attachment; filename=\"Real Name.bin\"\r\n");
    });
    QNetworkAccessManager nam;
    const QString out = temp.filePath("token-8f3a.bin");
    DownloadTask task(40, QUrl(server.url("token-8f3a.bin")), out, &nam, nullptr);
    task.setNameResolver([&](const QString &name) { return temp.filePath(name); });
    Run run; observe(task, run);
    task.start();
    waitUntil([&]() { return terminal(run); }, 10000);
    CHECK(run.last == DownloadState::Completed, "renamed download completes");
    CHECK(run.renames == QStringList{QStringLiteral("Real Name.bin")}, "renamedTo carries the server name");
    CHECK(task.savePath() == temp.filePath("Real Name.bin"), "save path follows the resolver");
    CHECK(readFile(temp.filePath("Real Name.bin")) == body, "file lands under the server name");
    CHECK(!QFile::exists(out), "the URL-derived name is never created");
}

// Pause mid-transfer, persist, rebuild the task from the database exactly as a
// restart would, resume from the saved offsets, and end with a byte-exact file.
static void testPauseResumeThroughDatabase(const QTemporaryDir &temp)
{
    const QByteArray body = patternBody(3 * 1024 * 1024, 5);
    QList<Request> seen;
    TestServer server([&](QTcpSocket *s, const Request &req) {
        seen << req;
        // Slow enough that a pause lands mid-flight: 16 KiB every 15 ms per connection.
        sendRanged(s, body, req, "ETag: \"v1\"\r\n", req.isProbe() ? 0 : 16 * 1024, 15);
    });
    CHECK(server.listening(), "pause/resume server did not start");

    Database db;
    CHECK(db.open(temp.filePath("resume.db")), "database did not open");
    QNetworkAccessManager nam;
    const QString out = temp.filePath("resume.bin");

    auto first = std::make_unique<DownloadTask>(50, QUrl(server.url("resume.bin")), out, &nam, &db);
    Run run1; observe(*first, run1);
    first->start();
    const bool progressed = waitUntil([&]() {
        return first->state() == DownloadState::Downloading && first->doneBytes() > 256 * 1024;
    }, 15000);
    CHECK(progressed, "download did not make progress before the pause");
    first->pause();
    CHECK(first->state() == DownloadState::Paused, "pause() lands in Paused");
    const qint64 pausedAt = first->doneBytes();
    CHECK(pausedAt > 0 && pausedAt < body.size(), "pause happened mid-transfer");

    // The database must hold the paused layout, byte-exactly.
    const auto records = db.loadAll();
    CHECK(records.size() == 1 && records.first().id == 50, "paused task persisted");
    if (records.size() != 1)
        return;
    const TaskRecord rec = records.first();
    CHECK(rec.state == DownloadState::Paused, "persisted state is Paused");
    CHECK(rec.total == body.size() && rec.rangesSupported, "persisted size and Range support");
    CHECK(rec.etag == "\"v1\"", "persisted ETag");
    CHECK(rec.segments.size() == 8, "persisted 8 segments");
    qint64 persistedDone = 0;
    for (const auto &s : rec.segments)
        persistedDone += s.done;
    CHECK(persistedDone == pausedAt, "persisted segment progress equals the paused byte count");

    // Nothing else may arrive after the pause (all workers stopped).
    const int requestsAtPause = server.requests;
    waitUntil([]() { return false; }, 200);
    CHECK(server.requests == requestsAtPause, "paused task issued no further requests");

    // Simulate a restart: a fresh task rebuilt from the record.
    first.reset();
    DownloadTask second(rec.id, QUrl(rec.url), rec.savePath, &nam, &db);
    Run run2; observe(second, run2);
    second.restore(rec.total, rec.segments, rec.rangesSupported, rec.etag, rec.lastModified);
    CHECK(second.state() == DownloadState::Paused && second.doneBytes() == pausedAt,
          "restored task carries the paused progress");
    seen.clear();
    second.resume();
    waitUntil([&]() { return terminal(run2); }, 30000);
    CHECK(run2.last == DownloadState::Completed, "resumed task completes");
    if (run2.last != DownloadState::Completed)
        std::fprintf(stderr, "  detail: %s\n", qPrintable(run2.details.value(run2.details.size() - 1)));
    CHECK(run2.details.contains("resuming"), "resume did not re-probe (segments resumed directly)");
    CHECK(readFile(out) == body, "resumed file is byte-exact");

    // Every resumed connection asked for its saved offset with the validator.
    bool resumedFromOffset = false, allValidated = !seen.isEmpty();
    for (const Request &r : seen) {
        if (r.hasRange && r.from > 0)
            resumedFromOffset = true;
        if (r.header("If-Range") != "\"v1\"")
            allValidated = false;
    }
    CHECK(resumedFromOffset, "no request resumed from a non-zero offset");
    CHECK(allValidated, "resumed requests did not carry If-Range with the saved ETag");

    const auto after = db.loadAll();
    CHECK(after.size() == 1 && after.first().state == DownloadState::Completed,
          "completion persisted");
    db.close();
}

// A connection that dies before any response is a transient error: the segment
// must be retried from its offset, and the download still completes.
static void testTransientFailureRetry(const QTemporaryDir &temp)
{
    const QByteArray body = patternBody(2 * 1024 * 1024, 11);
    QSet<qint64> droppedOnce;
    int drops = 0;
    TestServer server([&](QTcpSocket *s, const Request &req) {
        if (!req.isProbe() && !droppedOnce.contains(req.from)) {
            droppedOnce.insert(req.from);
            ++drops;
            s->abort();          // RST before any byte of a response
            return;
        }
        sendRanged(s, body, req);
    });
    QNetworkAccessManager nam;
    const QString out = temp.filePath("retry.bin");
    DownloadTask task(60, QUrl(server.url("retry.bin")), out, &nam, nullptr);
    Run run; observe(task, run);
    task.start();
    waitUntil([&]() { return terminal(run); }, 30000);
    CHECK(run.last == DownloadState::Completed, "download did not survive one dropped connection per segment");
    CHECK(drops == 8, "each of the 8 segments was dropped exactly once");
    CHECK(readFile(out) == body, "retried download is byte-exact");
}

// After the retry budget is exhausted the task errors. Resuming it must start
// with a FRESH budget: the next hiccup on that same segment is retried, not
// turned straight back into an error.
static void testRetryBudgetResetsOnResume(const QTemporaryDir &temp)
{
    const QByteArray body = patternBody(2 * 1024 * 1024, 13);
    const qint64 doomedStart = 3 * (body.size() / 8);   // segment 3's first byte
    // Phase 1: every request for segment 3 dies until the task gives up.
    // Phase 2 (after resume): the next `postResumeFailures` die, then it serves.
    // Qt silently reconnects up to twice when a connection closes before any
    // response, so counts are request-level, not worker-level; three drops
    // guarantee at least one failure the worker actually sees.
    bool phaseOne = true;
    int phaseOneDrops = 0;
    int postResumeFailures = 3;
    TestServer server([&](QTcpSocket *s, const Request &req) {
        if (req.hasRange && req.from == doomedStart) {
            if (phaseOne) { ++phaseOneDrops; s->abort(); return; }
            if (postResumeFailures > 0) { --postResumeFailures; s->abort(); return; }
        }
        sendRanged(s, body, req);
    });
    QNetworkAccessManager nam;
    const QString out = temp.filePath("budget.bin");
    DownloadTask task(61, QUrl(server.url("budget.bin")), out, &nam, nullptr);
    Run run; observe(task, run);
    task.start();
    waitUntil([&]() { return terminal(run); }, 60000);
    CHECK(run.last == DownloadState::Error, "exhausted retries end in Error");
    CHECK(run.details.last().startsWith("segment 3:"), "the error names the failing segment");
    CHECK(phaseOneDrops >= 6, "the first run made at least the initial attempt plus five retries");
    phaseOne = false;

    run.details.clear();
    task.resume();
    waitUntil([&]() { return terminal(run); }, 60000);
    CHECK(run.last == DownloadState::Completed,
          "resume after an exhausted budget must retry the segment again, not fail on its first hiccup");
    if (run.last != DownloadState::Completed)
        std::fprintf(stderr, "  detail: %s\n", qPrintable(run.details.value(run.details.size() - 1)));
    CHECK(postResumeFailures == 0, "the post-resume failures were all consumed");
    CHECK(readFile(out) == body, "file is byte-exact after the second run");
}

// The object changed on the server between sessions (different ETag, different
// size): the saved partial bytes are worthless and the download must restart
// from scratch and end with the NEW content. Two server behaviours exist:
//   * lenient — ignores If-Range, honours Range, answers 206 with the new ETag;
//   * strict (RFC 7233 §3.2) — If-Range mismatch: ignores Range, answers 200
//     with the whole new object.
static void testValidatorChangeRestarts(const QTemporaryDir &temp, bool strictIfRange)
{
    const QByteArray v1 = patternBody(3 * 1024 * 1024, 17);
    const QByteArray v2 = patternBody(2 * 1024 * 1024 + 4096, 19);
    bool serveV2 = false;
    int fullRestarts = 0;
    TestServer server([&](QTcpSocket *s, const Request &req) {
        const QByteArray &body = serveV2 ? v2 : v1;
        const QByteArray etag = serveV2 ? "\"v2\"" : "\"v1\"";
        const QByteArray ifRange = req.header("If-Range");
        if (strictIfRange && req.hasRange && !ifRange.isEmpty() && ifRange != etag) {
            ++fullRestarts;
            Request whole = req;
            whole.hasRange = false;              // 200 + the entire object
            sendRanged(s, body, whole, "ETag: " + etag + "\r\n");
            return;
        }
        sendRanged(s, body, req, "ETag: " + etag + "\r\n",
                   (req.isProbe() || serveV2) ? 0 : 16 * 1024, 15);
    });
    Database db;
    const QString tag = strictIfRange ? QStringLiteral("strict") : QStringLiteral("lenient");
    CHECK(db.open(temp.filePath(QStringLiteral("etag-%1.db").arg(tag))), "etag database did not open");
    QNetworkAccessManager nam;
    const QString out = temp.filePath(QStringLiteral("etag-%1.bin").arg(tag));
    DownloadTask task(70, QUrl(server.url(QStringLiteral("etag-%1.bin").arg(tag))), out, &nam, &db);
    Run run; observe(task, run);
    task.start();
    waitUntil([&]() { return task.state() == DownloadState::Downloading && task.doneBytes() > 256 * 1024; }, 15000);
    task.pause();
    CHECK(task.state() == DownloadState::Paused && task.etag() == "\"v1\"", "paused with v1 validator");

    serveV2 = true;
    QElapsedTimer clock; clock.start();
    task.resume();
    waitUntil([&]() { return terminal(run); }, 30000);
    CHECK(run.last == DownloadState::Completed, "download completes after the object changed");
    if (run.last != DownloadState::Completed)
        std::fprintf(stderr, "  detail: %s\n", qPrintable(run.details.value(run.details.size() - 1)));
    CHECK(clock.elapsed() < 5000, "restart after the object changed did not wait on retries");
    CHECK(task.etag() == "\"v2\"", "new validator adopted");
    CHECK(task.totalBytes() == v2.size(), "new size adopted");
    CHECK(readFile(out) == v2, "file holds the NEW object, not a mix of v1 and v2");
    if (strictIfRange)
        CHECK(fullRestarts >= 1, "the strict server did answer a mismatch with a 200");
    db.close();
}

// Dynamic re-segmentation: one slow connection is split so a freed connection
// takes its tail. The result must still be contiguous and byte-exact.
static void testDynamicResegmentation(const QTemporaryDir &temp)
{
    const int size = 72 * 1024 * 1024;              // 16 segments of 4.5 MiB (> 4 MiB split floor)
    const QByteArray body = patternBody(size, 23);
    const qint64 slowStart = size / 16;             // segment 1's first byte
    int tailRequests = 0;
    TestServer server([&](QTcpSocket *s, const Request &req) {
        if (req.hasRange && req.from == slowStart) {
            // Hold the first byte back long enough for the other 15 to finish.
            sendRanged(s, body, req, QByteArray(), 256 * 1024, 5, 1500);
            return;
        }
        if (req.hasRange && req.from > slowStart && req.from < 2 * slowStart)
            ++tailRequests;
        sendRanged(s, body, req);
    });
    QNetworkAccessManager nam;
    const QString out = temp.filePath("reseg.bin");
    DownloadTask task(80, QUrl(server.url("reseg.bin")), out, &nam, nullptr);
    Run run; observe(task, run);
    task.start();
    waitUntil([&]() { return terminal(run); }, 60000);
    CHECK(run.last == DownloadState::Completed, "re-segmented download did not complete");
    if (run.last != DownloadState::Completed)
        std::fprintf(stderr, "  detail: %s\n", qPrintable(run.details.value(run.details.size() - 1)));
    CHECK(run.details.contains("16 connection(s)"), "72 MiB starts with 16 connections");
    // The server shares this event loop, so the "fast" connections are not
    // instant either and early finishers may steal from any of them; what must
    // hold is that stealing happened, that the held-back segment was among the
    // donors, and that the final layout is still contiguous and byte-exact.
    const auto segs = task.segments();
    CHECK(segs.size() > 16, "no tail was ever stolen (dynamic re-segmentation did not run)");
    CHECK(tailRequests >= 1, "the slow segment's tail was never fetched by a freed connection");
    // Contiguity + completeness of the final layout.
    QVector<SegmentInfo> byStart = segs;
    std::sort(byStart.begin(), byStart.end(),
              [](const SegmentInfo &a, const SegmentInfo &b) { return a.start < b.start; });
    bool contiguous = !byStart.isEmpty() && byStart.first().start == 0
                   && byStart.last().end == size - 1;
    for (int i = 1; contiguous && i < byStart.size(); ++i)
        contiguous = byStart[i - 1].end + 1 == byStart[i].start;
    CHECK(contiguous, "final segment layout is contiguous and covers the file");
    for (const auto &s : segs)
        CHECK(s.complete(), "every segment reports complete");
    CHECK(task.doneBytes() == size, "done equals total");
    CHECK(readFile(out) == body, "re-segmented file is byte-exact");
}

// Global cap of 200 KB/s on a 600 KB file (one connection, which may burst the
// 256 KiB throttled read buffer): must take well over a second, not ~0.
static void testGlobalSpeedLimit(const QTemporaryDir &temp)
{
    const QByteArray body = patternBody(600 * 1024, 29);
    TestServer server([&](QTcpSocket *s, const Request &req) { sendRanged(s, body, req); });
    QNetworkAccessManager nam;
    RateLimiter limiter;
    limiter.setLimit(200 * 1024);
    DownloadTask task(90, QUrl(server.url("slow.bin")), temp.filePath("slow.bin"), &nam, nullptr);
    task.setRateLimiter(&limiter);
    Run run; observe(task, run);
    QElapsedTimer clock; clock.start();
    task.start();
    waitUntil([&]() { return terminal(run); }, 20000);
    CHECK(run.last == DownloadState::Completed, "rate-limited download completes");
    CHECK(clock.elapsed() >= 1200, "a 600 KB file at 200 KB/s finished suspiciously fast (limit not applied)");
    CHECK(readFile(temp.filePath("slow.bin")) == body, "rate-limited bytes exact");

    // Per-task cap composes with (and here is tighter than) the global one.
    DownloadTask task2(91, QUrl(server.url("slow2.bin")), temp.filePath("slow2.bin"), &nam, nullptr);
    task2.setRateLimiter(&limiter);
    task2.setSpeedLimit(100 * 1024);
    CHECK(task2.speedLimit() == 100 * 1024, "per-task limit stored");
    Run run2; observe(task2, run2);
    clock.restart();
    task2.start();
    waitUntil([&]() { return terminal(run2); }, 20000);
    CHECK(run2.last == DownloadState::Completed, "per-task limited download completes");
    CHECK(clock.elapsed() >= 2500, "a 600 KB file at 100 KB/s finished suspiciously fast");
    CHECK(readFile(temp.filePath("slow2.bin")) == body, "per-task limited bytes exact");
}

static void testDatabase(const QTemporaryDir &temp)
{
    // ---- Migration from the first schema (no updated_at / ranges / validators)
    const QString oldPath = temp.filePath("old.db");
    {
        QSqlDatabase legacy = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), QStringLiteral("legacy"));
        legacy.setDatabaseName(oldPath);
        CHECK(legacy.open(), "legacy db open");
        QSqlQuery q(legacy);
        q.exec("CREATE TABLE downloads (id INTEGER PRIMARY KEY, url TEXT NOT NULL, "
               "save_path TEXT NOT NULL, total INTEGER DEFAULT -1, state INTEGER DEFAULT 0)");
        q.exec("CREATE TABLE segments (download_id INTEGER NOT NULL, idx INTEGER NOT NULL, "
               "start INTEGER NOT NULL, stop INTEGER NOT NULL, done INTEGER NOT NULL, "
               "PRIMARY KEY (download_id, idx))");
        q.exec("INSERT INTO downloads VALUES (4, 'http://h/a.bin', '/tmp/a.bin', 100, 3)");
        q.exec("INSERT INTO segments VALUES (4, 0, 0, 49, 49)");
        q.exec("INSERT INTO segments VALUES (4, 1, 50, 99, 0)");
        q.exec("INSERT INTO segments VALUES (99, 0, 0, 9, 0)");   // orphan
        legacy.close();
    }
    QSqlDatabase::removeDatabase(QStringLiteral("legacy"));
    {
        Database db;
        CHECK(db.open(oldPath), "legacy database opens after migration");
        const auto recs = db.loadAll();
        CHECK(recs.size() == 1 && recs.first().id == 4, "legacy row survives");
        if (recs.size() == 1) {
            CHECK(recs.first().segments.size() == 2 && recs.first().segments[0].done == 49,
                  "legacy segments survive");
            CHECK(!recs.first().rangesSupported && recs.first().etag.isEmpty(),
                  "migrated columns default to empty");
        }
        CHECK(db.nextId() == 5, "nextId continues after the highest legacy id");
        QSqlDatabase check = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), QStringLiteral("orphans"));
        check.setDatabaseName(oldPath);
        check.open();
        QSqlQuery q(check);
        q.exec("SELECT COUNT(*) FROM segments WHERE download_id = 99");
        CHECK(q.next() && q.value(0).toInt() == 0, "orphan segment rows are pruned on open");
        check.close();
        db.close();
    }
    QSqlDatabase::removeDatabase(QStringLiteral("orphans"));

    // ---- Scheduled jobs + completed-history cleanup + removeTask
    Database db;
    CHECK(db.open(temp.filePath("misc.db")), "misc database opens");
    db.saveScheduled(40, QStringLiteral("http://h/later.bin"), 1234567890123LL, QStringLiteral("later"));
    db.saveScheduled(41, QStringLiteral("http://h/sooner.bin"), 1234567880000LL, QString());
    auto jobs = db.loadScheduled();
    CHECK(jobs.size() == 2 && jobs[0].id == 41 && jobs[1].id == 40, "scheduled jobs load ordered by time");
    CHECK(jobs[1].name == "later" && jobs[1].startAtMs == 1234567890123LL, "scheduled fields round-trip");
    CHECK(db.nextId() >= 42, "nextId skips scheduled ids");
    db.removeScheduled(41);
    CHECK(db.loadScheduled().size() == 1, "removeScheduled drops the row");

    QNetworkAccessManager nam;
    const QUrl url(QStringLiteral("http://h/x.bin"));
    const QString done1 = temp.filePath("done1.bin"), done2 = temp.filePath("done2.bin");
    for (const QString &p : {done1, done2}) {
        QFile f(p);
        if (f.open(QIODevice::WriteOnly)) f.write("0123456789");
    }
    SegmentInfo whole; whole.index = 0; whole.start = 0; whole.end = 9; whole.done = 10;
    DownloadTask a(1, url, done1, &nam, nullptr); a.restore(10, {whole}, false);
    DownloadTask b(2, url, done2, &nam, nullptr); b.restore(10, {whole}, false);
    SegmentInfo half = whole; half.done = 4;
    DownloadTask c(3, url, temp.filePath("half.bin"), &nam, nullptr); c.restore(10, {half}, false);
    CHECK(a.state() == DownloadState::Completed && c.state() == DownloadState::Paused, "fixture states");
    db.saveTask(a, {whole});
    db.saveTask(b, {whole});
    db.saveTask(c, {half});
    CHECK(db.loadAll().size() == 3, "three rows saved");
    CHECK(db.clearCompleted(30) == 0, "fresh completed rows are younger than 30 days");
    CHECK(db.clearCompleted(0) == 2, "clearCompleted(0) removes every completed row");
    auto left = db.loadAll();
    CHECK(left.size() == 1 && left.first().id == 3 && left.first().segments.size() == 1,
          "the paused row and its segments survive cleanup");
    db.removeTask(3);
    CHECK(db.loadAll().isEmpty(), "removeTask drops the row");
    {
        QSqlDatabase check = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), QStringLiteral("segs"));
        check.setDatabaseName(temp.filePath("misc.db"));
        check.open();
        QSqlQuery q(check);
        q.exec("SELECT COUNT(*) FROM segments");
        CHECK(q.next() && q.value(0).toInt() == 0, "no segment rows outlive their downloads");
        check.close();
    }
    QSqlDatabase::removeDatabase(QStringLiteral("segs"));
    db.close();
}

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    QTemporaryDir temp;
    CHECK(temp.isValid(), "temporary directory unavailable");
    if (!temp.isValid())
        return 1;

    struct Case { const char *name; std::function<void()> fn; };
    const Case cases[] = {
        {"pure helpers",                   [&]() { testPureHelpers(); }},
        {"rate limiter",                   [&]() { testRateLimiter(); }},
        {"restore validation",             [&]() { testRestoreValidation(temp); }},
        {"probe errors",                   [&]() { testProbeErrors(temp); }},
        {"content-disposition rename",     [&]() { testContentDispositionRename(temp); }},
        {"chunked unknown length",         [&]() { testChunkedUnknownLength(temp); }},
        {"pause/resume through database",  [&]() { testPauseResumeThroughDatabase(temp); }},
        {"transient failure retry",        [&]() { testTransientFailureRetry(temp); }},
        {"retry budget resets on resume",  [&]() { testRetryBudgetResetsOnResume(temp); }},
        {"validator change (lenient 206)", [&]() { testValidatorChangeRestarts(temp, false); }},
        {"validator change (strict 200)",  [&]() { testValidatorChangeRestarts(temp, true); }},
        {"dynamic re-segmentation",        [&]() { testDynamicResegmentation(temp); }},
        {"global + per-task speed limit",  [&]() { testGlobalSpeedLimit(temp); }},
        {"database",                       [&]() { testDatabase(temp); }},
    };
    for (const Case &c : cases) {
        const int before = g_failures;
        c.fn();
        std::printf("%-34s %s\n", c.name, g_failures == before ? "ok" : "FAILED");
        std::fflush(stdout);
    }
    if (g_failures)
        std::fprintf(stderr, "%d failure(s)\n", g_failures);
    else
        std::printf("download core test ok\n");
    return g_failures ? 1 : 0;
}
