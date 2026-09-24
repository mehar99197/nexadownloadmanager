// The Pro gate on course sites, through the real DownloadEngine and IpcServer.
//
// Downloading from a login-gated course site is a paid feature (proOnly in
// cloud_providers.json). Coursera and Skillshare stream their lectures from a
// CDN, though, and the extension hands the stream over under the CDN's own
// address with the lecture page as the Referer. A gate that read only the
// download's host let every one of those lectures through on Free. The page a
// download came from has to count as well -- and only a course page may, or
// Free loses the CDN files it is promised from every other page.
//
// Built with NEXA_DEV_BUILD (the licence endpoint points at a closed local
// port, so Pro comes from offline grace) and WITHOUT NEXA_LICENSE_PUBLIC_KEY
// (so the test can mint that Pro token with the published development key),
// like OfflineGraceTest. Nothing is fetched: "ask before download" is on, so a
// download the gate lets through is held for a confirm prompt that never runs.

#include "core/DownloadEngine.h"
#include "ipc/IpcServer.h"
#include "license/LicenseManager.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QDebug>
#include <QDir>
#include <QElapsedTimer>
#include <QEventLoop>
#include <QFileInfo>
#include <QHostAddress>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLocalSocket>
#include <QNetworkProxy>
#include <QSettings>
#include <QStandardPaths>
#include <QTcpServer>
#include <QTemporaryDir>
#include <QTimer>
#include <QtEndian>
#include <functional>

#include <openssl/evp.h>

using namespace nexa;

static int g_failures = 0;
#define CHECK(cond, msg) do { if (!(cond)) { qWarning() << "FAIL:" << msg; ++g_failures; } } while (0)

// ---------------------------------------------------------------------------
// A Pro token, signed with the development key the backend uses when
// LICENSE_JWT_PRIVATE_KEY is unset (32 bytes of 0x4e).
// ---------------------------------------------------------------------------

static QByteArray b64u(const QByteArray &raw)
{
    return raw.toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals);
}

static QString mintProToken(const QString &device, const QString &licenseKey)
{
    const qint64 now = QDateTime::currentSecsSinceEpoch();
    const QJsonObject header{{QStringLiteral("alg"), QStringLiteral("EdDSA")},
                             {QStringLiteral("typ"), QStringLiteral("JWT")}};
    const QJsonObject payload{
        {QStringLiteral("sub"),    licenseKey},
        {QStringLiteral("plan"),   QStringLiteral("pro")},
        {QStringLiteral("device"), device},
        {QStringLiteral("typ"),    QStringLiteral("license")},
        {QStringLiteral("iat"),    now},
        {QStringLiteral("exp"),    now + 86400},
        {QStringLiteral("features"), QJsonObject{
            {QStringLiteral("maxConcurrentDownloads"), 0},
            {QStringLiteral("themes"), QStringLiteral("all")},
            {QStringLiteral("authSiteDownloads"), true},
            {QStringLiteral("aiRename"), true},
            {QStringLiteral("adFree"), true},
            {QStringLiteral("seats"), 1},
        }},
    };
    const QByteArray signingInput =
        b64u(QJsonDocument(header).toJson(QJsonDocument::Compact)) + '.'
        + b64u(QJsonDocument(payload).toJson(QJsonDocument::Compact));

    const QByteArray seed(32, '\x4e');
    EVP_PKEY *key = EVP_PKEY_new_raw_private_key(
        EVP_PKEY_ED25519, nullptr,
        reinterpret_cast<const unsigned char *>(seed.constData()), size_t(seed.size()));
    if (!key)
        return QString();
    EVP_MD_CTX *ctx = EVP_MD_CTX_new();
    QByteArray signature(64, '\0');
    size_t signatureLength = size_t(signature.size());
    const bool ok = ctx
        && EVP_DigestSignInit(ctx, nullptr, nullptr, nullptr, key) == 1
        && EVP_DigestSign(ctx, reinterpret_cast<unsigned char *>(signature.data()), &signatureLength,
                          reinterpret_cast<const unsigned char *>(signingInput.constData()),
                          size_t(signingInput.size())) == 1;
    if (ctx) EVP_MD_CTX_free(ctx);
    EVP_PKEY_free(key);
    if (!ok)
        return QString();
    signature.truncate(int(signatureLength));
    return QString::fromLatin1(signingInput + '.' + b64u(signature));
}

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

// A local port nothing listens on: bound for a moment, then released.
static quint16 closedPort()
{
    QTcpServer probe;
    probe.listen(QHostAddress::LocalHost, 0);
    const quint16 port = probe.serverPort();
    probe.close();
    return port;
}

// One framed request, the way nexa-host sends it. The server answers on this
// same thread, so the wait pumps the event loop instead of blocking it.
static QJsonObject ipcRequest(const QString &serverName, const QJsonObject &message)
{
    QLocalSocket socket;
    socket.connectToServer(serverName);
    if (!socket.waitForConnected(2000))
        return {};
    const QByteArray body = QJsonDocument(message).toJson(QJsonDocument::Compact);
    QByteArray frame(4, '\0');
    qToLittleEndian<quint32>(quint32(body.size()), frame.data());
    socket.write(frame + body);
    socket.flush();
    QByteArray reply;
    pump([&]() {
        reply += socket.readAll();
        return reply.size() >= 4
            && quint32(reply.size()) >= qFromLittleEndian<quint32>(reply.constData()) + 4;
    });
    if (reply.size() < 4)
        return {};
    return QJsonDocument::fromJson(reply.mid(4)).object();
}

static HeaderList referer(const char *page, const char *name = "Referer")
{
    return {{QByteArray(name), QByteArray(page)}};
}

// Pages and streams, in the shapes the extension hands over. None is contacted.
static const char kCourseraLecture[] =
    "https://www.coursera.org/learn/machine-learning/lecture/Ujm7v/what-is-machine-learning";
static const char kSkillshareClass[] = "https://www.skillshare.com/en/classes/some-class/123456789";
static const char kUdemyLecture[] = "https://www.udemy.com/course/some-course/learn/lecture/123";
static const char kLinkedInCourse[] = "https://www.linkedin.com/learning/some-course/welcome";
static const char kLinkedInFeed[] = "https://www.linkedin.com/feed/";
static const char kBlogPost[] = "https://blog.example.com/2026/09/notes";

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);

    // Settings, the download database and the licence cache all stay inside
    // this test: none of them may touch a real installation's.
    QTemporaryDir settingsDir;
    QTemporaryDir downloadDir;
    QCoreApplication::setOrganizationName(QStringLiteral("NexaProGateTest"));
    QCoreApplication::setApplicationName(QStringLiteral("NexaProGateTest"));
    QSettings::setDefaultFormat(QSettings::IniFormat);
    QSettings::setPath(QSettings::IniFormat, QSettings::UserScope, settingsDir.path());
    QStandardPaths::setTestModeEnabled(true);
    const QString dataDir = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);

    // No request this test makes can leave the machine, whatever the engine
    // decides to start: every one goes through a proxy that is not there.
    const quint16 nowhere = closedPort();
    QNetworkProxy::setApplicationProxy(
        QNetworkProxy(QNetworkProxy::HttpProxy, QStringLiteral("127.0.0.1"), nowhere));
    qputenv("NEXA_ALLOW_INSECURE_LICENSE_API", "1");
    qputenv("NEXA_LICENSE_API_URL",
            QStringLiteral("http://127.0.0.1:%1/api/license/validate").arg(nowhere).toUtf8());

    const QUrl courseraStream(QStringLiteral(
        "https://d3c33hcgiwev3.cloudfront.net/Ujm7v/720p/index.mp4?Expires=1700000000&Signature=abc"));
    const QUrl skillshareStream(QStringLiteral("https://video-cdn.example.net/class/123456789/master.m3u8"));
    // IPC only takes public addresses, and resolving a name would put DNS in
    // the loop; a literal is judged without a lookup.
    const QUrl ipcStream(QStringLiteral("https://93.184.216.34/lecture/index.mp4"));

    {
        DownloadEngine engine;
        engine.setDownloadDir(downloadDir.path());
        engine.setConfirmBeforeStart(true);   // an accepted download is held, never started

        QStringList blocked;
        QObject::connect(&engine, &DownloadEngine::downloadBlocked, &engine,
                         [&](const QUrl &, const QString &reason) { blocked << reason; });
        const auto add = [&](const QUrl &url, const HeaderList &headers) {
            return engine.addDownload(url, QString(), headers);
        };

        const QString server = QStringLiteral("nexa-pro-gate-test-%1")
                                   .arg(QCoreApplication::applicationPid());
        IpcServer ipc(&engine);
        CHECK(ipc.start(server), "the IPC server listens");
        const auto handoff = [&](const QUrl &url, const char *page) {
            return ipcRequest(server, QJsonObject{
                {QStringLiteral("type"), QStringLiteral("download")},
                {QStringLiteral("url"), url.toString()},
                {QStringLiteral("referrer"), QString::fromLatin1(page)}});
        };
        const auto grabLinks = [&](const char *page) {
            return ipcRequest(server, QJsonObject{
                {QStringLiteral("type"), QStringLiteral("links")},
                {QStringLiteral("pageUrl"), QString::fromLatin1(page)},
                {QStringLiteral("links"), QJsonArray{QJsonObject{
                    {QStringLiteral("url"), ipcStream.toString()},
                    {QStringLiteral("kind"), QStringLiteral("media")}}}},
                {QStringLiteral("headers"), QJsonArray{
                    QJsonArray{QStringLiteral("referer"), QString::fromLatin1(page)}}}});
        };

        CHECK(engine.licensePlan() == QLatin1String("free"), "a fresh install is on Free");

        // --- No page behind it: exactly what the gate did before ------------
        CHECK(add(courseraStream, {}) >= 0,
              "a pasted CDN address, with no page behind it, is not gated");
        const int beforeUdemy = blocked.size();
        CHECK(add(QUrl(QString::fromLatin1(kUdemyLecture)), {}) == -1,
              "a course address itself is still refused on Free");
        const QString udemyReason = blocked.value(beforeUdemy);
        CHECK(blocked.size() == beforeUdemy + 1
              && udemyReason.contains(QLatin1String("www.udemy.com")),
              "…and the refusal names the course site");
        // It used to send people to a trial control Settings does not have.
        // The trial starts on the website; signing the app in to that account
        // is what brings the plan across.
        CHECK(udemyReason.contains(QLatin1String("nexadownloadmanager.com/pricing")),
              "the refusal says where the trial starts");
        CHECK(udemyReason.contains(QStringLiteral("Settings → Account")),
              "…and where the app signs in to pick the plan up");
        CHECK(!udemyReason.contains(QLatin1String("trial in Settings")),
              "…and no longer claims Settings can start a trial");

        // --- A course page behind a CDN stream is a course download ---------
        const int beforeCoursera = blocked.size();
        CHECK(add(courseraStream, referer(kCourseraLecture)) == -1,
              "Free: a Coursera lecture streamed from its CDN is refused");
        CHECK(blocked.size() == beforeCoursera + 1, "…with one explanation");
        const QString reason = blocked.value(beforeCoursera);
        CHECK(reason.contains(QLatin1String("www.coursera.org")),
              "…naming the course site, where the download came from");
        CHECK(!reason.contains(QLatin1String("cloudfront")),
              "…not the CDN, which means nothing to the person reading it");

        CHECK(add(skillshareStream, referer(kSkillshareClass)) == -1,
              "Free: a Skillshare class streamed over HLS from a CDN is refused");
        CHECK(add(courseraStream, referer(kCourseraLecture, "referer")) == -1,
              "the header name is case-blind: the link grabber sends `referer`");
        HeaderList twoPages = referer(kBlogPost);
        twoPages += referer(kCourseraLecture);
        CHECK(add(courseraStream, twoPages) == -1,
              "a harmless Referer first does not hide the course page behind it");
        CHECK(add(courseraStream, referer(kLinkedInCourse)) == -1,
              "a LinkedIn Learning page is a course page");

        // --- Every other page is left alone ---------------------------------
        CHECK(add(courseraStream, referer(kLinkedInFeed)) >= 0,
              "the LinkedIn feed is not a course page");
        CHECK(add(courseraStream, referer("https://vimeo.com/76979871")) >= 0,
              "Vimeo uses login cookies but is not a course site");
        CHECK(add(courseraStream, referer("https://www.youtube.com/watch?v=dQw4w9WgXcQ")) >= 0,
              "a YouTube page is not a course page");
        CHECK(add(courseraStream, referer(kBlogPost)) >= 0, "a blog is not a course page");
        CHECK(add(courseraStream, referer("https://evil-udemy.com/course/x")) >= 0,
              "the page's host is matched on a label boundary, like every host rule");

        // --- Batches: each address is judged with the page it came with -----
        const QString twoStreams = courseraStream.toString() + QLatin1Char('\n')
                                 + skillshareStream.toString();
        CHECK(engine.addBatch(twoStreams, referer(kCourseraLecture)).isEmpty(),
              "Free: a batch taken from a course page queues nothing");
        CHECK(engine.addBatch(twoStreams, referer(kBlogPost)).size() == 2,
              "a batch taken from any other page queues all of it");

        // --- "Refresh address" is a handoff too ----------------------------
        // It re-aims a waiting task at whatever the browser sends next for the
        // same file, and it used to run before the gate: a lecture started on a
        // trial could be finished on Free by fetching it again from the course.
        {
            const QUrl first(QStringLiteral("https://93.184.216.34/v/lecture.mp4?t=1"));
            const int waiting = add(first, referer(kBlogPost));
            CHECK(waiting >= 0, "a download from a blog is queued");
            engine.armRefreshCapture(waiting);
            CHECK(add(QUrl(QStringLiteral("https://93.184.216.34/v/lecture.mp4?t=2")),
                      referer(kCourseraLecture)) == -1,
                  "Free: a refreshed address from a course page is refused");
            CHECK(engine.urlOf(waiting) == first.toString(),
                  "…and the waiting download keeps its old address");
            engine.cancelRefreshCapture();
        }

        // --- The extension's side of it: the IPC reply ----------------------
        const int beforeIpc = blocked.size();
        const QJsonObject refused = handoff(ipcStream, kCourseraLecture);
        CHECK(!refused.value(QStringLiteral("ok")).toBool(true),
              "IPC, Free: a stream handed over from a Coursera lecture is refused");
        CHECK(blocked.size() == beforeIpc + 1
              && refused.value(QStringLiteral("message")).toString() == blocked.last(),
              "…and the extension is told the same reason the app shows, not \"rejected\"");
        CHECK(handoff(ipcStream, "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
                  .value(QStringLiteral("ok")).toBool(),
              "IPC, Free: the same stream from any other page is accepted");

        const QJsonObject linksRefused = grabLinks(kCourseraLecture);
        CHECK(!linksRefused.value(QStringLiteral("ok")).toBool(true),
              "IPC, Free: a course page's links are refused at the door");
        CHECK(linksRefused.value(QStringLiteral("message")).toString().contains(QLatin1String("www.coursera.org")),
              "…with the one explanation, instead of one per link picked");
        CHECK(grabLinks(kBlogPost).value(QStringLiteral("ok")).toBool(),
              "IPC, Free: another page's links still open the link grabber");

        // --- Pro: the same downloads go through -----------------------------
        const QString licenseKey = QStringLiteral("NDM-PROG-ATE0-TEST");
        {
            QSettings settings;
            settings.setValue(QStringLiteral("license/cachedToken"),
                              mintProToken(LicenseManager::deviceFingerprint(), licenseKey));
            settings.setValue(QStringLiteral("license/cachedTrial"), false);
        }
        bool finished = false;
        QObject::connect(engine.license(), &LicenseManager::activationFinished, &engine,
                         [&](bool, const QString &) { finished = true; });
        engine.license()->activate(licenseKey);
        pump([&]() { return finished; }, 20000);
        CHECK(engine.licensePlan() == QLatin1String("pro"), "the install is on Pro");

        const int beforePro = blocked.size();
        CHECK(add(courseraStream, referer(kCourseraLecture)) >= 0,
              "Pro: a Coursera lecture streamed from its CDN is accepted");
        CHECK(add(skillshareStream, referer(kSkillshareClass)) >= 0,
              "Pro: a Skillshare class is accepted");
        CHECK(blocked.size() == beforePro, "Pro: nothing is refused");
        CHECK(handoff(ipcStream, kCourseraLecture).value(QStringLiteral("ok")).toBool(),
              "IPC, Pro: a stream handed over from a Coursera lecture is accepted");
        CHECK(grabLinks(kCourseraLecture).value(QStringLiteral("ok")).toBool(),
              "IPC, Pro: a course page's links open the link grabber");
    }

    // <test-mode root>/NexaProGateTest/NexaProGateTest: both levels are ours,
    // and the root goes too when nothing else has used it.
    const QString orgDir = QFileInfo(dataDir).absolutePath();
    QDir(orgDir).removeRecursively();
    QDir().rmdir(QFileInfo(orgDir).absolutePath());

    if (g_failures == 0) {
        qInfo() << "Pro gate tests passed";
        return 0;
    }
    qWarning() << g_failures << "failure(s)";
    return 1;
}
