// A paid install asks for no promo before its plan is known.
//
// LicenseManager::start() reads the stored credential a turn of the event loop
// later and then validates it over the network; until that answers, plan()
// reads "free" on a machine that has paid as well. The ad strip is started in
// exactly that window (main.cpp builds the window straight after start()), and
// used to ask for a promo there with no licence token — which the server
// rightly treats as Free, so a paying customer could be shown an ad and have
// its impression counted.
//
// Drives the real LicenseManager, AdService and AdBanner in main.cpp's order,
// against one fake server that answers the licence and the ad endpoints and
// holds every validation back until the test lets it answer, so the window
// before the answer can be watched.
//
// Built like ReverifyTest: NEXA_DEV_BUILD (so the endpoints can be moved),
// NEXA_TEST_CREDENTIAL_STORE (so stored credentials stay in this process), and
// no NEXA_LICENSE_PUBLIC_KEY (so it can mint tokens with the development key).

#include "ads/AdService.h"
#include "license/CredentialStore.h"
#include "license/LicenseManager.h"
#include "ui/AdBanner.h"

#include <QApplication>
#include <QDateTime>
#include <QDebug>
#include <QElapsedTimer>
#include <QEventLoop>
#include <QHash>
#include <QHostAddress>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QPointer>
#include <QSettings>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTemporaryDir>
#include <QTimer>
#include <QWidget>
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

// `subject` holds the claims naming what the token speaks for: `sub` = the
// licence key for a key, or `acct` = the account for a signed-in machine.
static QString mintToken(const QString &plan, const QString &device, const QJsonObject &subject)
{
    const qint64 now = QDateTime::currentSecsSinceEpoch();
    const bool paid = plan != QLatin1String("free");
    QJsonObject payload = subject;
    payload.insert(QStringLiteral("plan"), plan);
    payload.insert(QStringLiteral("device"), device);
    payload.insert(QStringLiteral("typ"), QStringLiteral("license"));
    payload.insert(QStringLiteral("iat"), now);
    payload.insert(QStringLiteral("exp"), now + 900);
    payload.insert(QStringLiteral("features"), QJsonObject{
        {QStringLiteral("maxConcurrentDownloads"), paid ? 0 : 3},
        {QStringLiteral("themes"), paid ? QStringLiteral("all") : QStringLiteral("basic")},
        {QStringLiteral("authSiteDownloads"), paid},
        {QStringLiteral("aiRename"), paid},
        {QStringLiteral("adFree"), paid},
        {QStringLiteral("seats"), plan == QLatin1String("team") ? 5 : 1},
    });
    const QJsonObject header{{QStringLiteral("alg"), QStringLiteral("EdDSA")},
                             {QStringLiteral("typ"), QStringLiteral("JWT")}};
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
// One server for everything a launch asks: /api/license/validate, held until
// release(); GET /api/ads, which always has one promo (the fake does not need
// the real one's paid-token check — a paid install must not ask at all); and
// the impression and click reports at /api/ads/<id>/event. Counts each kind.
// ---------------------------------------------------------------------------

class FakeServer : public QObject {
public:
    QHash<QString, int> requests;     // "validate", "ads", "event"

    int count(const char *kind) const { return requests.value(QLatin1String(kind)); }

    // Arrange the next launch: /validate will answer `status` and `body` once
    // released, and every count starts again from zero.
    void prepare(int status, const QString &body)
    {
        m_validateStatus = status;
        m_validateBody = body.toUtf8();
        requests.clear();
    }

    // Let every validation held so far answer.
    void release()
    {
        const QList<QPointer<QTcpSocket>> held = m_held;
        m_held.clear();
        for (const QPointer<QTcpSocket> &socket : held) {
            if (socket)
                answer(socket, m_validateStatus, m_validateBody);
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
                int contentLength = 0;
                const QList<QByteArray> lines = buffer.left(headerEnd).split('\n');
                for (const QByteArray &line : lines) {
                    if (line.toLower().startsWith("content-length:"))
                        contentLength = line.mid(line.indexOf(':') + 1).trimmed().toInt();
                }
                if (buffer.size() < headerEnd + 4 + contentLength)
                    return;
                m_buffers.remove(socket);

                // "GET /api/ads?placement=app_banner HTTP/1.1" -> "/api/ads"
                QByteArray path = lines.value(0).split(' ').value(1);
                const int query = path.indexOf('?');
                if (query >= 0)
                    path.truncate(query);
                const QString kind = path.endsWith("/event") ? QStringLiteral("event")
                                   : path.endsWith("/ads")   ? QStringLiteral("ads")
                                   : QString::fromLatin1(path.mid(path.lastIndexOf('/') + 1));
                ++requests[kind];

                if (kind == QLatin1String("validate"))
                    m_held.append(socket);
                else if (kind == QLatin1String("ads"))
                    answer(socket, 200, adsBody());
                else
                    answer(socket, 200, QByteArrayLiteral("{\"ok\":true,\"data\":{\"counted\":true}}"));
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
    // One promo, shaped as the live endpoint shapes it for a Free install.
    static QByteArray adsBody()
    {
        const QJsonObject ad{
            {QStringLiteral("id"), 7},
            {QStringLiteral("title"), QStringLiteral("A promo")},
            {QStringLiteral("body"), QStringLiteral("For Free installs only")},
            {QStringLiteral("targetUrl"), QStringLiteral("https://example.com/promo")},
            {QStringLiteral("ctaLabel"), QStringLiteral("Open")},
            {QStringLiteral("weight"), 1},
            {QStringLiteral("token"), QStringLiteral("event-token")},
        };
        return QJsonDocument(QJsonObject{
            {QStringLiteral("ok"), true},
            {QStringLiteral("data"), QJsonObject{
                {QStringLiteral("adFree"), false},
                {QStringLiteral("ads"), QJsonArray{ad}},
            }},
        }).toJson(QJsonDocument::Compact);
    }

    static void answer(QTcpSocket *socket, int status, const QByteArray &payload)
    {
        QByteArray response = "HTTP/1.1 " + QByteArray::number(status)
                              + (status == 200 ? " OK" : " Service Unavailable") + "\r\n";
        response += "Content-Type: application/json\r\n";
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
    int m_validateStatus = 200;
    QByteArray m_validateBody;
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

// Nothing stored by one case may reach the next: the credentials, and the
// cached token that offline grace would replay. Named keys rather than the
// whole group, which also holds the fallback device seed.
static void forgetLicence()
{
    credentialstore::removeLicenseKey();
    credentialstore::removeAccountToken();
    QSettings settings;
    for (const char *key : {"license/cachedToken", "license/cachedTrial",
                            "license/accountId", "license/accountEmail"})
        settings.remove(QLatin1String(key));
    settings.sync();
}

// One launch of the app in main.cpp's order: the licence starts (which only
// schedules the credential read), then the window builds the ad strip and
// starts it — all before the event loop has turned once.
struct Launch {
    LicenseManager license;
    AdService ads{&license};
    QWidget window;                   // the strip's parent, as in MainWindow; never shown
    AdBanner banner{&ads, &window};   // declared after its parent, so destroyed first
    int promos = 0;                   // adChanged(true): the strip had an ad to draw

    Launch()
    {
        QObject::connect(&ads, &AdService::adChanged, &ads, [this](bool has) {
            if (has)
                ++promos;
        });
        license.start();
        ads.start();
    }
};

int main(int argc, char **argv)
{
    // The banner is a real widget: it needs a GUI application, not a screen.
    qputenv("QT_QPA_PLATFORM", "offscreen");
    QApplication app(argc, argv);

    // Isolate settings so the test never touches a real installation's licence.
    QTemporaryDir settingsDir;
    QCoreApplication::setOrganizationName(QStringLiteral("NexaAdServiceTest"));
    QCoreApplication::setApplicationName(QStringLiteral("NexaAdServiceTest"));
    QSettings::setDefaultFormat(QSettings::IniFormat);
    QSettings::setPath(QSettings::IniFormat, QSettings::UserScope, settingsDir.path());

    qputenv("NEXA_ALLOW_INSECURE_LICENSE_API", "1");

    FakeServer server;
    if (!server.listen()) {
        qWarning() << "FAIL: could not start the fake server";
        return 1;
    }
    const QString api = QStringLiteral("http://127.0.0.1:%1/api").arg(server.port());
    qputenv("NEXA_LICENSE_API_URL", (api + QStringLiteral("/license/validate")).toUtf8());
    qputenv("NEXA_ADS_API_URL", (api + QStringLiteral("/ads")).toUtf8());

    const QString licenseKey = QStringLiteral("NDM-AAAA-BBBB-CCCC");
    const QString device = LicenseManager::deviceFingerprint();
    const QJsonObject keySubject{{QStringLiteral("sub"), licenseKey}};
    const QJsonObject accountSubject{{QStringLiteral("sub"), QStringLiteral("user:42")},
                                     {QStringLiteral("acct"), 42}};

    // Every launch with a stored credential starts the same way: the
    // credential is read and sent, and the server holds the answer. That is
    // the window this test is about — plan() reads "free" in it on a paid
    // install too — so nothing may be asked for, shown or counted there.
    // Then the server is let answer.
    auto untilAnswered = [&](Launch &launch, const QString &label) {
        pump([&]() { return server.count("validate") == 1; });
        settle();
        CHECK(server.count("validate") == 1, label + ": the stored credential is sent for validation");
        CHECK(server.count("ads") == 0, label + ": no promo is asked for before the licence answers");
        CHECK(launch.promos == 0 && server.count("event") == 0,
              label + ": …so none is shown or counted");
        server.release();
    };

    // A stored credential that ends on a paid plan never asks for a promo:
    // not while the answer is outstanding, and not after it.
    auto expectAdFree = [&](const QString &label, const QString &plan) {
        Launch launch;
        untilAnswered(launch, label);
        pump([&]() { return launch.license.plan() == plan; });
        settle();
        CHECK(launch.license.plan() == plan, label + ": the licence answers " + plan);
        CHECK(server.count("ads") == 0, label + ": …and a paid install never asks for a promo");
        CHECK(launch.promos == 0 && launch.banner.isHidden(),
              label + ": …so the banner never has one to show");
        CHECK(server.count("event") == 0, label + ": …and no impression is counted");
    };

    // A stored credential that ends on Free is a Free install like any other:
    // nothing while the answer is outstanding, then the promo, shown and counted.
    auto expectPromoAfterAnswer = [&](const QString &label) {
        Launch launch;
        untilAnswered(launch, label);
        pump([&]() { return server.count("event") == 1; });
        CHECK(launch.license.plan() == QLatin1String("free"), label + ": the licence answers Free");
        CHECK(server.count("ads") == 1, label + ": …then the promo is asked for");
        CHECK(launch.promos == 1 && !launch.banner.isHidden(), label + ": …shown");
        CHECK(server.count("event") == 1, label + ": …and its impression counted");
    };

    // --- A. A stored key on Pro --------------------------------------------------
    forgetLicence();
    credentialstore::writeLicenseKey(licenseKey);
    server.prepare(200, okBody(mintToken(QStringLiteral("pro"), device, keySubject)));
    expectAdFree(QStringLiteral("A (stored key, Pro)"), QStringLiteral("pro"));

    // --- B. A signed-in account on Team ----------------------------------------
    // start() reads the account token before any key, down its own branch.
    forgetLicence();
    credentialstore::writeAccountToken(QStringLiteral("device-token-of-a-team-account"));
    server.prepare(200, okBody(mintToken(QStringLiteral("team"), device, accountSubject)));
    expectAdFree(QStringLiteral("B (signed-in account, Team)"), QStringLiteral("team"));

    // --- C. The server unreachable, Pro kept by offline grace ------------------
    forgetLicence();
    credentialstore::writeLicenseKey(licenseKey);
    {
        // What the last successful check left behind.
        QSettings settings;
        settings.setValue(QStringLiteral("license/cachedToken"),
                          mintToken(QStringLiteral("pro"), device, keySubject));
        settings.setValue(QStringLiteral("license/cachedTrial"), false);
        settings.sync();
    }
    server.prepare(503, QString());
    expectAdFree(QStringLiteral("C (offline, inside the grace window)"), QStringLiteral("pro"));

    // --- D. Nothing stored: Free at once, the promo without waiting ------------
    // The server still holds every validation, so a strip that waited on one
    // here would never be answered.
    {
        forgetLicence();
        server.prepare(200, QString());          // fresh counts; nothing is released here
        Launch launch;
        pump([&]() { return server.count("event") == 1; });
        CHECK(server.count("validate") == 0, "D: with nothing stored there is nothing to validate");
        CHECK(launch.license.plan() == QLatin1String("free"), "D: the install is on Free");
        CHECK(server.count("ads") == 1, "D: …so the promo is asked for without waiting");
        CHECK(launch.promos == 1 && !launch.banner.isHidden(), "D: …shown");
        CHECK(server.count("event") == 1, "D: …and its impression counted");
    }

    // --- E-G. A stored credential that ends on Free ------------------------------
    forgetLicence();
    credentialstore::writeLicenseKey(licenseKey);
    server.prepare(200, okBody(mintToken(QStringLiteral("free"), device, keySubject)));
    expectPromoAfterAnswer(QStringLiteral("E (stored key, the server says Free)"));

    forgetLicence();
    credentialstore::writeLicenseKey(licenseKey);
    server.prepare(200, rejectedBody(QStringLiteral("expired")));
    expectPromoAfterAnswer(QStringLiteral("F (stored key, rejected)"));

    forgetLicence();
    credentialstore::writeLicenseKey(licenseKey);
    server.prepare(503, QString());
    expectPromoAfterAnswer(QStringLiteral("G (server unreachable, nothing cached)"));

    forgetLicence();
    if (g_failures == 0)
        qInfo() << "AdService: all checks passed";
    return g_failures == 0 ? 0 : 1;
}
