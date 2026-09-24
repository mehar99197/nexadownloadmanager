// Every 10th completed download asks the server again (docs/issues.md, Issue 3).
//
// Drives the real LicenseManager against a real socket, like OfflineGraceTest,
// because what goes wrong here is the wiring: which request goes out, when it
// is skipped, and what the plan and its limits do when the answer changes.
//
// Built with NEXA_DEV_BUILD (so the endpoints and the check spacing can be
// moved) and WITHOUT NEXA_LICENSE_PUBLIC_KEY (so it can mint tokens with the
// published development key).

#include "license/CredentialStore.h"
#include "license/LicenseManager.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QDebug>
#include <QElapsedTimer>
#include <QEventLoop>
#include <QHash>
#include <QHostAddress>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSettings>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTemporaryDir>
#include <QTimer>
#include <functional>

#include <openssl/evp.h>

using namespace nexa;

static int g_failures = 0;
#define CHECK(cond, msg) do { if (!(cond)) { qWarning() << "FAIL:" << msg; ++g_failures; } } while (0)

// ---------------------------------------------------------------------------
// Signing, with the development key the backend uses when
// LICENSE_JWT_PRIVATE_KEY is unset (32 bytes of 0x4e).
// ---------------------------------------------------------------------------

static QByteArray b64u(const QByteArray &raw)
{
    return raw.toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals);
}

static QJsonObject planFeatures(const QString &plan)
{
    const bool paid = plan != QLatin1String("free");
    return QJsonObject{
        {QStringLiteral("maxConcurrentDownloads"), paid ? 0 : 3},
        {QStringLiteral("maxConnectionsPerFile"), paid ? 32 : 16},
        {QStringLiteral("themes"), paid ? QStringLiteral("all") : QStringLiteral("basic")},
        {QStringLiteral("authSiteDownloads"), paid},
        {QStringLiteral("aiRename"), paid},
        {QStringLiteral("adFree"), paid},
        {QStringLiteral("seats"), plan == QLatin1String("team") ? 5 : 1},
    };
}

static QString mintToken(const QString &plan, const QString &device, const QString &licenseKey,
                         const QJsonObject &features)
{
    const qint64 now = QDateTime::currentSecsSinceEpoch();
    const QJsonObject header{{QStringLiteral("alg"), QStringLiteral("EdDSA")},
                             {QStringLiteral("typ"), QStringLiteral("JWT")}};
    const QJsonObject payload{
        {QStringLiteral("sub"),      licenseKey},
        {QStringLiteral("plan"),     plan},
        {QStringLiteral("device"),   device},
        {QStringLiteral("typ"),      QStringLiteral("license")},
        {QStringLiteral("iat"),      now},
        {QStringLiteral("exp"),      now + 900},
        {QStringLiteral("features"), features},
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
// A licence server that answers /validate and /heartbeat separately and
// counts each, so a test can tell which one a check used.
// ---------------------------------------------------------------------------

class FakeLicenseServer : public QObject {
public:
    QString validateBody;
    QString heartbeatBody;
    int heartbeatStatus = 200;
    QHash<QString, int> requests;     // by last path segment: "validate", "heartbeat"

    int count(const char *action) const { return requests.value(QLatin1String(action)); }

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
                int contentLength = 0;
                const QList<QByteArray> lines = buffer.left(headerEnd).split('\n');
                for (const QByteArray &line : lines) {
                    if (line.toLower().startsWith("content-length:"))
                        contentLength = line.mid(line.indexOf(':') + 1).trimmed().toInt();
                }
                if (buffer.size() < headerEnd + 4 + contentLength)
                    return;

                // "POST /api/license/heartbeat HTTP/1.1" -> "heartbeat"
                const QByteArray path = lines.value(0).split(' ').value(1);
                const QString action = QString::fromLatin1(path.mid(path.lastIndexOf('/') + 1));
                ++requests[action];

                const bool beat = action == QLatin1String("heartbeat");
                const int status = beat ? heartbeatStatus : 200;
                const QByteArray payload = (beat ? heartbeatBody : validateBody).toUtf8();
                QByteArray response = "HTTP/1.1 " + QByteArray::number(status)
                                      + (status == 200 ? " OK" : " Service Unavailable") + "\r\n";
                response += "Content-Type: application/json\r\n";
                response += "Content-Length: " + QByteArray::number(payload.size()) + "\r\n";
                response += "Connection: close\r\n\r\n";
                response += payload;
                socket->write(response);
                socket->flush();
                socket->disconnectFromHost();
                m_buffers.remove(socket);
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
    QTcpServer m_server;
    QHash<QTcpSocket *, QByteArray> m_buffers;
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

// Long enough for a request that should NOT have been sent to have arrived.
static void settle() { pump([] { return false; }, 300); }

static QString okBody(const QString &token)
{
    return QString::fromUtf8(QJsonDocument(QJsonObject{
        {QStringLiteral("valid"), true},
        {QStringLiteral("token"), token},
        {QStringLiteral("trial"), false},
        {QStringLiteral("seats"), 1},
        {QStringLiteral("activeSeats"), 1},
    }).toJson(QJsonDocument::Compact));
}

static QString rejectedBody(const QString &reason)
{
    return QString::fromUtf8(QJsonDocument(QJsonObject{
        {QStringLiteral("valid"), false},
        {QStringLiteral("reason"), reason},
    }).toJson(QJsonDocument::Compact));
}

static qint64 completedCount()
{
    return QSettings().value(QStringLiteral("license/completedDownloads")).toLongLong();
}

static void download(LicenseManager &license, int times)
{
    for (int i = 0; i < times; ++i)
        license.noteCompletedDownload();
}

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);

    // Isolate settings so the test never touches a real installation's licence.
    QTemporaryDir settingsDir;
    QCoreApplication::setOrganizationName(QStringLiteral("NexaReverifyTest"));
    QCoreApplication::setApplicationName(QStringLiteral("NexaReverifyTest"));
    QSettings::setDefaultFormat(QSettings::IniFormat);
    QSettings::setPath(QSettings::IniFormat, QSettings::UserScope, settingsDir.path());

    qputenv("NEXA_ALLOW_INSECURE_LICENSE_API", "1");
    qputenv("NEXA_REVERIFY_SPACING_MS", "0");

    const QString licenseKey = QStringLiteral("NDM-AAAA-BBBB-CCCC");
    const QString device = LicenseManager::deviceFingerprint();
    const QString proToken = mintToken(QStringLiteral("pro"), device, licenseKey,
                                       planFeatures(QStringLiteral("pro")));

    FakeLicenseServer server;
    if (!server.listen()) {
        qWarning() << "FAIL: could not start the fake licence server";
        return 1;
    }
    qputenv("NEXA_LICENSE_API_URL",
            QStringLiteral("http://127.0.0.1:%1/api/license/validate").arg(server.port()).toUtf8());
    server.validateBody = okBody(proToken);
    server.heartbeatBody = okBody(proToken);

    // Activate against /validate, which also takes the seat and starts the beat.
    // Disconnects afterwards: the handler points at this call's `finished`, and
    // a second activation of the same instance must not write to it.
    auto activate = [&](LicenseManager &license) {
        bool finished = false;
        const QMetaObject::Connection c = QObject::connect(
            &license, &LicenseManager::activationFinished,
            &license, [&](bool, const QString &) { finished = true; });
        license.activate(licenseKey);
        pump([&]() { return finished; });
        QObject::disconnect(c);
        return license.plan() == QLatin1String("pro");
    };

    // --- A. Nine downloads send nothing; the tenth sends exactly one beat ------
    {
        LicenseManager license;
        CHECK(activate(license), "A: activation puts the install on Pro");
        const int validates = server.count("validate");

        download(license, 9);
        settle();
        CHECK(server.count("heartbeat") == 0, "A: nine completed downloads ask nothing");

        download(license, 1);
        pump([&]() { return server.count("heartbeat") == 1; });
        settle();
        CHECK(server.count("heartbeat") == 1, "A: the tenth download asks the server exactly once");
        CHECK(server.count("validate") == validates,
              "A: the check is a beat, not /validate (10 an hour per address)");
        CHECK(completedCount() == 10, "A: the count is kept in settings");
        CHECK(license.plan() == QLatin1String("pro"), "A: an unchanged answer keeps Pro");
    }

    // --- B. The count survives a restart ----------------------------------------
    // Five more here and five in a fresh process make the 20th: only a count
    // that carried over reaches ten in the second process.
    {
        const int beats = server.count("heartbeat");
        {
            LicenseManager license;
            CHECK(activate(license), "B: activation");
            download(license, 5);
            settle();
        }
        LicenseManager license;               // a fresh run of the app
        CHECK(activate(license), "B: activation after the restart");
        download(license, 4);
        settle();
        CHECK(server.count("heartbeat") == beats, "B: the 19th download asks nothing");
        download(license, 1);
        pump([&]() { return server.count("heartbeat") == beats + 1; });
        CHECK(server.count("heartbeat") == beats + 1,
              "B: the 20th download asks, so the count carried over the restart");
        CHECK(completedCount() == 20, "B: 20 downloads counted across both runs");
    }

    // --- C. Same plan, tighter limits: reaches the entitlements at once --------
    // Before, a beat applied a token only when the plan NAME changed, and the
    // recheck compared every limit except connections per file.
    {
        LicenseManager license;
        CHECK(activate(license), "C: activation");
        int planSignals = 0;
        int featureSignals = 0;
        QObject::connect(&license, &LicenseManager::entitlementChanged,
                         &license, [&](const QString &) { ++planSignals; });
        QObject::connect(&license, &LicenseManager::featuresChanged,
                         &license, [&](const Entitlements &) { ++featureSignals; });

        QJsonObject tighter = planFeatures(QStringLiteral("pro"));
        tighter[QStringLiteral("maxConcurrentDownloads")] = 4;
        tighter[QStringLiteral("maxConnectionsPerFile")] = 8;
        tighter[QStringLiteral("authSiteDownloads")] = false;
        server.heartbeatBody = okBody(mintToken(QStringLiteral("pro"), device, licenseKey, tighter));

        download(license, 10);
        pump([&]() { return license.features().maxConcurrentDownloads == 4; });
        CHECK(license.plan() == QLatin1String("pro"), "C: still Pro");
        CHECK(license.features().maxConcurrentDownloads == 4, "C: the new queue cap applies");
        CHECK(license.features().maxConnectionsPerFile == 8,
              "C: the new connections-per-file ceiling applies");
        CHECK(!license.features().authSiteDownloads, "C: auth-site downloads were withdrawn");
        CHECK(license.verifiedFeatures().maxConcurrentDownloads == 4,
              "C: the signature-derived path agrees");
        CHECK(featureSignals >= 1, "C: featuresChanged told the gates");
        CHECK(planSignals == 0,
              "C: no plan-name change, which is why the engine now listens to featuresChanged");

        // Connections per file alone: the one limit the recheck used to skip.
        tighter[QStringLiteral("maxConnectionsPerFile")] = 12;
        server.heartbeatBody = okBody(mintToken(QStringLiteral("pro"), device, licenseKey, tighter));
        download(license, 10);
        pump([&]() { return license.features().maxConnectionsPerFile == 12; });
        CHECK(license.features().maxConnectionsPerFile == 12,
              "C: a change to connections per file alone is applied");
        server.heartbeatBody = okBody(proToken);
    }

    // --- D. A downgrade in the answer takes effect -----------------------------
    {
        LicenseManager license;
        CHECK(activate(license), "D: activation");
        server.heartbeatBody = okBody(mintToken(QStringLiteral("free"), device, licenseKey,
                                                planFeatures(QStringLiteral("free"))));
        download(license, 10);
        pump([&]() { return license.plan() == QLatin1String("free"); });
        CHECK(license.plan() == QLatin1String("free"), "D: a Free answer drops the plan to Free");
        CHECK(license.features().maxConcurrentDownloads == 3, "D: …with the Free queue cap");
        CHECK(!license.verifiedFeatures().aiRename, "D: …and without AI rename");
        server.heartbeatBody = okBody(proToken);
    }

    // --- E. A rejection drops to Free, and with no seat there is no next check --
    {
        LicenseManager license;
        CHECK(activate(license), "E: activation");
        const qint64 before = completedCount();
        server.heartbeatBody = rejectedBody(QStringLiteral("expired"));
        const int beats = server.count("heartbeat");
        download(license, 10);
        pump([&]() { return license.plan() == QLatin1String("free"); });
        CHECK(license.plan() == QLatin1String("free"), "E: an expired licence drops to Free");
        CHECK(!license.verifiedFeatures().authSiteDownloads, "E: …and loses auth-site downloads");
        CHECK(completedCount() == before + 10, "E: clearing the licence cache keeps the count");

        download(license, 10);
        settle();
        CHECK(server.count("heartbeat") == beats + 1,
              "E: no seat is held any more, so no further beat is sent");
        server.heartbeatBody = okBody(proToken);
    }

    // --- F. The server failing to answer keeps Pro -------------------------------
    {
        LicenseManager license;
        CHECK(activate(license), "F: activation");
        server.heartbeatStatus = 503;
        const int beats = server.count("heartbeat");
        download(license, 10);
        pump([&]() { return server.count("heartbeat") == beats + 1; });
        settle();
        CHECK(server.count("heartbeat") == beats + 1, "F: the check was sent");
        CHECK(license.plan() == QLatin1String("pro"), "F: a failed check does not downgrade");
        CHECK(license.verifiedFeatures().authSiteDownloads, "F: …not even the signature path");
        server.heartbeatStatus = 200;
    }

    // --- G. An unlicensed install never asks --------------------------------------
    {
        LicenseManager license;               // never activated: Free, no seat
        const int validates = server.count("validate");
        const int beats = server.count("heartbeat");
        download(license, 20);
        settle();
        CHECK(server.count("validate") == validates && server.count("heartbeat") == beats,
              "G: an unlicensed install sends nothing");
    }

    // --- H. A check the server has just answered is not repeated ----------------
    {
        qputenv("NEXA_REVERIFY_SPACING_MS", "60000");
        LicenseManager license;
        CHECK(activate(license), "H: activation");
        const int beats = server.count("heartbeat");
        download(license, 10);
        pump([&]() { return server.count("heartbeat") == beats + 1; });
        download(license, 10);
        settle();
        CHECK(server.count("heartbeat") == beats + 1,
              "H: ten more downloads within the minute do not send a second check");
        qputenv("NEXA_REVERIFY_SPACING_MS", "0");
        download(license, 10);
        pump([&]() { return server.count("heartbeat") == beats + 2; });
        CHECK(server.count("heartbeat") == beats + 2, "H: once the spacing has passed, it asks again");
    }

    // --- I. A signed-in Free account holds no seat, so it never beats ----------
    // It has an account token, which is all sendHeartbeat() itself checks for;
    // the server would answer seat_limit and tell a Free user that every seat
    // on a licence they do not have is in use.
    {
        credentialstore::removeLicenseKey();
        credentialstore::writeAccountToken(QStringLiteral("device-token-of-a-free-account"));
        server.validateBody = rejectedBody(QStringLiteral("no_subscription"));
        server.heartbeatBody = rejectedBody(QStringLiteral("seat_limit"));
        LicenseManager license;
        bool seatMessage = false;
        QObject::connect(&license, &LicenseManager::seatLimitReached,
                         &license, [&](int) { seatMessage = true; });
        const int validates = server.count("validate");
        license.start();
        pump([&]() { return server.count("validate") == validates + 1; });
        settle();
        CHECK(license.isSignedIn(), "I: the account is signed in");
        CHECK(license.plan() == QLatin1String("free"), "I: …on Free, with no plan on the account");
        const int beats = server.count("heartbeat");
        download(license, 10);
        settle();
        CHECK(server.count("heartbeat") == beats, "I: no seat is held, so no beat is sent");
        CHECK(!seatMessage, "I: …and no 'every seat is in use' message reaches a Free user");
        credentialstore::removeAccountToken();
        server.validateBody = okBody(proToken);
        server.heartbeatBody = okBody(proToken);
    }

    // --- J. A renewal after a rejection is honoured -----------------------------
    // featuresChanged is emitted in the middle of a rejection, while the plan
    // still reads Pro but the token is gone. The engine reads verifiedFeatures()
    // from it through a queued connection; a synchronous read at that moment
    // looks like tampering, and the guard folds the install to Free for the
    // rest of the session, so a customer who renews stays on Free until a
    // restart.
    auto renewAfterRejection = [&](Qt::ConnectionType type) {
        LicenseManager license;
        QObject::connect(&license, &LicenseManager::featuresChanged, &license,
                         [&license]() { (void)license.verifiedFeatures(); }, type);
        activate(license);
        server.heartbeatBody = rejectedBody(QStringLiteral("expired"));
        download(license, 10);
        pump([&]() { return license.plan() == QLatin1String("free"); });
        settle();
        server.heartbeatBody = okBody(proToken);
        activate(license);                    // the customer renews and activates again
        settle();
        return license.verifiedFeatures().authSiteDownloads;
    };
    CHECK(renewAfterRejection(Qt::QueuedConnection),
          "J: with a queued reader (as DownloadEngine has), the renewed plan is honoured");
    CHECK(!renewAfterRejection(Qt::DirectConnection),
          "J: a synchronous reader trips the guard, which is why the engine's connection "
          "is queued (if this check fails, the gap is gone and the warning on "
          "featuresChanged can be dropped)");

    if (g_failures == 0)
        qInfo() << "Reverify: all checks passed";
    return g_failures == 0 ? 0 : 1;
}
