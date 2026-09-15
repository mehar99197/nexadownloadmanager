// Offline grace, end to end.
//
// This is the "did the anti-piracy work break paying customers?" test. The
// licence hardening replaced a plaintext `cachedPlan=pro` string with a signed,
// device-bound token, and the failure mode of getting that wrong is silent and
// expensive: a customer on a train loses Pro. LicenseTokenTest already covers
// the policy in isolation; this drives the real LicenseManager against a real
// socket, because the parts that break in practice are the wiring — which
// settings key is read, whether the offline path runs at all, whether
// entitlements come back with the plan.
//
// Built with NEXA_DEV_BUILD (so the endpoint can point at localhost) and
// WITHOUT NEXA_LICENSE_PUBLIC_KEY (so it can mint tokens with the published
// development key).

#include "license/LicenseManager.h"
#include "license/LicenseToken.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QDebug>
#include <QElapsedTimer>
#include <QEventLoop>
#include <QHostAddress>
#include <QTimeZone>
#include <functional>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSettings>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTemporaryDir>
#include <QTimer>

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

static QString mintToken(const QString &plan, const QString &device, const QString &licenseKey,
                         qint64 issuedAtSecs, qint64 lifetimeSecs = 86400)
{
    const QJsonObject header{{QStringLiteral("alg"), QStringLiteral("EdDSA")},
                             {QStringLiteral("typ"), QStringLiteral("JWT")}};
    const bool paid = plan != QLatin1String("free");
    const QJsonObject payload{
        {QStringLiteral("sub"),    licenseKey},
        {QStringLiteral("plan"),   plan},
        {QStringLiteral("device"), device},
        {QStringLiteral("typ"),    QStringLiteral("license")},
        {QStringLiteral("iat"),    issuedAtSecs},
        {QStringLiteral("exp"),    issuedAtSecs + lifetimeSecs},
        {QStringLiteral("features"), QJsonObject{
            {QStringLiteral("maxConcurrentDownloads"), paid ? 0 : 3},
            {QStringLiteral("themes"), paid ? QStringLiteral("all") : QStringLiteral("basic")},
            {QStringLiteral("authSiteDownloads"), paid},
            {QStringLiteral("aiRename"), paid},
            {QStringLiteral("adFree"), paid},
            {QStringLiteral("seats"), plan == QLatin1String("team") ? 5 : 1},
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
// A licence server that can be switched off mid-test.
// ---------------------------------------------------------------------------

class FakeLicenseServer : public QObject {
public:
    QString body;                 // what /validate answers with
    int requests = 0;

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
                // Wait for the whole body before answering, so a split write
                // does not produce a half-read request.
                int contentLength = 0;
                for (const QByteArray &line : buffer.left(headerEnd).split('\n')) {
                    if (line.toLower().startsWith("content-length:"))
                        contentLength = line.mid(line.indexOf(':') + 1).trimmed().toInt();
                }
                if (buffer.size() < headerEnd + 4 + contentLength)
                    return;

                ++requests;
                const QByteArray payload = body.toUtf8();
                QByteArray response = "HTTP/1.1 200 OK\r\n";
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
    void stop() { m_server.close(); }

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

static void clearCache()
{
    QSettings settings;
    settings.remove(QStringLiteral("license"));
    settings.sync();
}

static QString cachedToken()
{
    QSettings settings;
    return settings.value(QStringLiteral("license/cachedToken")).toString();
}

static void writeCachedToken(const QString &token)
{
    QSettings settings;
    settings.setValue(QStringLiteral("license/cachedToken"), token);
    settings.setValue(QStringLiteral("license/cachedTrial"), false);
    settings.sync();
}

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);

    // Isolate settings so the test never touches a real installation's licence.
    QTemporaryDir settingsDir;
    QCoreApplication::setOrganizationName(QStringLiteral("NexaOfflineGraceTest"));
    QCoreApplication::setApplicationName(QStringLiteral("NexaOfflineGraceTest"));
    QSettings::setDefaultFormat(QSettings::IniFormat);
    QSettings::setPath(QSettings::IniFormat, QSettings::UserScope, settingsDir.path());

    qputenv("NEXA_ALLOW_INSECURE_LICENSE_API", "1");

    const QString licenseKey = QStringLiteral("NDM-AAAA-BBBB-CCCC");
    const QString device = LicenseManager::deviceFingerprint();
    const qint64 now = QDateTime::currentSecsSinceEpoch();

    FakeLicenseServer server;
    if (!server.listen()) {
        qWarning() << "FAIL: could not start the fake licence server";
        return 1;
    }
    qputenv("NEXA_LICENSE_API_URL",
            QStringLiteral("http://127.0.0.1:%1/api/license/validate").arg(server.port()).toUtf8());

    auto validateBody = [&](const QString &token) {
        return QString::fromUtf8(QJsonDocument(QJsonObject{
            {QStringLiteral("valid"), true},
            {QStringLiteral("plan"), QStringLiteral("pro")},
            {QStringLiteral("token"), token},
            {QStringLiteral("trial"), false},
            {QStringLiteral("expires"), QDateTime::fromSecsSinceEpoch(now + 30 * 86400, QTimeZone::utc())
                                            .toString(Qt::ISODate)},
            {QStringLiteral("seats"), 1},
            {QStringLiteral("activeSeats"), 1},
        }).toJson(QJsonDocument::Compact));
    };

    // --- A. Online activation puts the install on Pro and caches the token ---
    {
        clearCache();
        server.body = validateBody(mintToken(QStringLiteral("pro"), device, licenseKey, now));

        LicenseManager license;
        bool finished = false;
        bool valid = false;
        QObject::connect(&license, &LicenseManager::activationFinished,
                         &license, [&](bool ok, const QString &) { finished = true; valid = ok; });
        license.activate(licenseKey);
        pump([&]() { return finished; });

        CHECK(finished, "activation completed");
        CHECK(valid, "a correctly signed Pro token activates");
        CHECK(license.plan() == QLatin1String("pro"), "plan is Pro after activation");
        CHECK(license.isPaid(), "isPaid() reports paid");
        CHECK(license.features().adFree, "entitlements arrived: ad-free");
        CHECK(license.features().aiRename, "entitlements arrived: AI rename");
        CHECK(license.features().authSiteDownloads, "entitlements arrived: auth sites");
        CHECK(license.features().maxConcurrentDownloads == 0, "entitlements arrived: unlimited queue");
        CHECK(license.allowsTheme(QStringLiteral("nebula")), "paid themes unlocked");
        CHECK(!cachedToken().isEmpty(), "the signed token was cached for offline use");
        CHECK(!license.licenseToken().isEmpty(), "a token is held for plan-gated APIs");
        // The independent path: re-derived from the signature, not from the
        // cached struct, so the two have to be defeated separately.
        CHECK(license.verifiedFeatures().adFree, "verifiedFeatures() agrees: ad-free");
        CHECK(license.verifiedFeatures().authSiteDownloads,
              "verifiedFeatures() agrees: auth sites");
    }

    // --- B. THE regression test: server unreachable, plan survives ----------
    // A paying customer who loses connectivity must keep Pro for the grace
    // window, with entitlements intact — not just a Pro badge over Free limits.
    {
        server.stop();

        LicenseManager license;      // a fresh run of the app
        bool finished = false;
        bool valid = false;
        QObject::connect(&license, &LicenseManager::activationFinished,
                         &license, [&](bool ok, const QString &) { finished = true; valid = ok; });
        license.activate(licenseKey);
        pump([&]() { return finished; });

        CHECK(valid, "offline activation succeeds from the cached token");
        CHECK(license.plan() == QLatin1String("pro"), "OFFLINE GRACE: still Pro with no server");
        CHECK(license.isPaid(), "OFFLINE GRACE: isPaid() still true");
        CHECK(license.features().adFree, "OFFLINE GRACE: ad-free survives");
        CHECK(license.features().aiRename, "OFFLINE GRACE: AI rename survives");
        CHECK(license.features().authSiteDownloads, "OFFLINE GRACE: auth sites survive");
        CHECK(license.features().maxConcurrentDownloads == 0,
              "OFFLINE GRACE: the queue is not silently re-capped");
        CHECK(license.allowsTheme(QStringLiteral("nebula")),
              "OFFLINE GRACE: paid themes still allowed");
        CHECK(license.status().contains(QLatin1String("offline"), Qt::CaseInsensitive),
              "the user is told this is an offline grace period");
        CHECK(license.verifiedFeatures().authSiteDownloads,
              "OFFLINE GRACE: the signature-derived path agrees too");
    }

    // --- C. Grace has a limit: a token older than 7 days stops working ------
    {
        writeCachedToken(mintToken(QStringLiteral("pro"), device, licenseKey, now - 8 * 86400));
        LicenseManager license;
        bool finished = false;
        QObject::connect(&license, &LicenseManager::activationFinished,
                         &license, [&](bool, const QString &) { finished = true; });
        license.activate(licenseKey);
        pump([&]() { return finished; });

        CHECK(license.plan() == QLatin1String("free"), "a token 8 days old drops to Free");
        CHECK(!license.features().adFree, "…and loses ad-free");
        CHECK(!license.allowsTheme(QStringLiteral("nebula")), "…and loses paid themes");
        CHECK(license.features().maxConcurrentDownloads == 3, "…and is re-capped to the Free queue");
    }

    // --- D. Day 6 still works, so the window is genuinely 7 days -----------
    {
        writeCachedToken(mintToken(QStringLiteral("pro"), device, licenseKey, now - 6 * 86400));
        LicenseManager license;
        bool finished = false;
        QObject::connect(&license, &LicenseManager::activationFinished,
                         &license, [&](bool, const QString &) { finished = true; });
        license.activate(licenseKey);
        pump([&]() { return finished; });
        CHECK(license.plan() == QLatin1String("pro"), "a 6-day-old token is still inside the window");
    }

    // --- E. The cache is not a bypass -------------------------------------
    {
        // Someone else's token, copied into this machine's settings.
        writeCachedToken(mintToken(QStringLiteral("team"), QStringLiteral("another-machine"),
                                   licenseKey, now));
        LicenseManager license;
        bool finished = false;
        QObject::connect(&license, &LicenseManager::activationFinished,
                         &license, [&](bool, const QString &) { finished = true; });
        license.activate(licenseKey);
        pump([&]() { return finished; });
        CHECK(license.plan() == QLatin1String("free"),
              "a token issued to another device does not grant a plan");
        CHECK(!license.verifiedFeatures().authSiteDownloads,
              "…and the signature-derived path refuses it as well");
    }
    {
        // Hand-edited settings — the old cachedPlan=pro attack.
        writeCachedToken(QStringLiteral("not-a-token"));
        LicenseManager license;
        bool finished = false;
        QObject::connect(&license, &LicenseManager::activationFinished,
                         &license, [&](bool, const QString &) { finished = true; });
        license.activate(licenseKey);
        pump([&]() { return finished; });
        CHECK(license.plan() == QLatin1String("free"), "garbage in the cache grants nothing");
        CHECK(!license.verifiedFeatures().adFree,
              "…and verifiedFeatures() is Free, not merely the cached struct");
    }
    {
        // A signed but FREE token must not be promoted.
        writeCachedToken(mintToken(QStringLiteral("free"), device, licenseKey, now));
        LicenseManager license;
        bool finished = false;
        QObject::connect(&license, &LicenseManager::activationFinished,
                         &license, [&](bool, const QString &) { finished = true; });
        license.activate(licenseKey);
        pump([&]() { return finished; });
        CHECK(license.plan() == QLatin1String("free"), "a Free token stays Free offline");
    }

    // --- F. An empty cache is Free, not a crash ---------------------------
    {
        clearCache();
        LicenseManager license;
        bool finished = false;
        QObject::connect(&license, &LicenseManager::activationFinished,
                         &license, [&](bool, const QString &) { finished = true; });
        license.activate(licenseKey);
        pump([&]() { return finished; });
        CHECK(license.plan() == QLatin1String("free"), "no cache and no server is Free");
        CHECK(license.features().maxConcurrentDownloads == 3, "…with Free entitlements");
    }

    if (g_failures == 0)
        qInfo() << "OfflineGrace: all checks passed";
    return g_failures == 0 ? 0 : 1;
}
