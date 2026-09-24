// "Remove license", or signing out, while a licence check is still out.
//
// deactivate() aborted the validation in flight without detaching its handler.
// abort() emits finished() synchronously, so the handler ran inside
// deactivate(): it took m_reply, set it to null and treated the cancellation as
// an outage — the offline-grace path, which puts a cached paid plan back for a
// moment — and deactivate() then called m_reply->deleteLater() on the null
// pointer, taking the app down. A heartbeat in flight was not cancelled at all:
// its answer could land after the key was gone, with a fresh token that no key
// was left to be checked against, and the plan came back.
//
// Signing out had that second half too. Every sign-in ends in forgetAccount(),
// which left the validation and the heartbeat running, and an answer landing
// afterwards re-adopted the plan with no account left to check it against.
//
// Drives the real LicenseManager against a fake server that can hold /validate
// and /heartbeat open, so Remove or the sign-out lands while a reply is
// genuinely pending — in the first seconds after launch, right after Activate,
// or while a beat is out. C and D took the old code down outright, so they run
// after A and B, which only failed.
//
// Built like ReverifyTest: NEXA_DEV_BUILD (so the endpoints can be moved),
// NEXA_TEST_CREDENTIAL_STORE (so the stored key stays in this process), and no
// NEXA_LICENSE_PUBLIC_KEY (so it can mint tokens with the development key).

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
#include <QPointer>
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

// `subject` is the licence key a key's token is minted for. An account's token
// names the user there instead, and the account itself in `acct`.
static QString mintToken(const QString &plan, const QString &device, const QString &subject,
                         int accountId = 0)
{
    const qint64 now = QDateTime::currentSecsSinceEpoch();
    const bool paid = plan != QLatin1String("free");
    const QJsonObject header{{QStringLiteral("alg"), QStringLiteral("EdDSA")},
                             {QStringLiteral("typ"), QStringLiteral("JWT")}};
    QJsonObject payload{
        {QStringLiteral("sub"),    subject},
        {QStringLiteral("plan"),   plan},
        {QStringLiteral("device"), device},
        {QStringLiteral("typ"),    QStringLiteral("license")},
        {QStringLiteral("iat"),    now},
        {QStringLiteral("exp"),    now + 900},
        {QStringLiteral("features"), QJsonObject{
            {QStringLiteral("maxConcurrentDownloads"), paid ? 0 : 3},
            {QStringLiteral("themes"), paid ? QStringLiteral("all") : QStringLiteral("basic")},
            {QStringLiteral("authSiteDownloads"), paid},
            {QStringLiteral("aiRename"), paid},
            {QStringLiteral("adFree"), paid},
            {QStringLiteral("seats"), 1},
        }},
    };
    if (accountId > 0)
        payload.insert(QStringLiteral("acct"), accountId);
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
// A licence server whose answers are set per action — "validate", "heartbeat",
// "release" — and any of which can be held open until release(action), so a
// request is still pending when the test clicks Remove. Counts each action.
// ---------------------------------------------------------------------------

class FakeLicenseServer : public QObject {
public:
    QHash<QString, int> requests;

    int count(const char *action) const { return requests.value(QLatin1String(action)); }

    // How `action` answers from now on: `status` and `body`, straight away or,
    // with `hold`, only once release(action) is called. Unset actions answer
    // 200 with an empty body, which is all /release needs.
    void on(const char *action, int status, const QString &body, bool hold = false)
    {
        m_routes.insert(QLatin1String(action), Route{status, body.toUtf8(), hold});
    }

    // Answer every request held on `action` so far.
    void release(const char *action)
    {
        const QString name = QLatin1String(action);
        const QList<QPointer<QTcpSocket>> held = m_held.take(name);
        const Route route = m_routes.value(name);
        for (const QPointer<QTcpSocket> &socket : held) {
            if (socket)
                answer(socket, route.status, route.body);
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

                // "POST /api/license/heartbeat HTTP/1.1" -> "heartbeat"
                const QByteArray path = lines.value(0).split(' ').value(1);
                const QString action = QString::fromLatin1(path.mid(path.lastIndexOf('/') + 1));
                m_buffers.remove(socket);
                ++requests[action];

                const Route route = m_routes.value(action);
                if (route.hold)
                    m_held[action].append(socket);
                else
                    answer(socket, route.status, route.body);
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
    struct Route {
        int status = 200;
        QByteArray body;
        bool hold = false;
    };

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
    QHash<QString, Route> m_routes;
    QHash<QString, QList<QPointer<QTcpSocket>>> m_held;
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

// Long enough for an answer that should change nothing to have landed.
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

static QString cachedToken()
{
    return QSettings().value(QStringLiteral("license/cachedToken")).toString();
}

// A recent paid token in the offline-grace cache, as a customer who was on Pro
// yesterday has: exactly what the aborted validation's handler reached for.
static void writeCachedToken(const QString &token)
{
    QSettings settings;
    settings.setValue(QStringLiteral("license/cachedToken"), token);
    settings.setValue(QStringLiteral("license/cachedTrial"), false);
    settings.sync();
}

// Nothing stored by one case may reach the next. Named keys rather than the
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

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);

    // Isolate settings so the test never touches a real installation's licence.
    QTemporaryDir settingsDir;
    QCoreApplication::setOrganizationName(QStringLiteral("NexaLicenseRemoveTest"));
    QCoreApplication::setApplicationName(QStringLiteral("NexaLicenseRemoveTest"));
    QSettings::setDefaultFormat(QSettings::IniFormat);
    QSettings::setPath(QSettings::IniFormat, QSettings::UserScope, settingsDir.path());

    qputenv("NEXA_ALLOW_INSECURE_LICENSE_API", "1");
    qputenv("NEXA_REVERIFY_SPACING_MS", "0");

    FakeLicenseServer server;
    if (!server.listen()) {
        qWarning() << "FAIL: could not start the fake licence server";
        return 1;
    }
    qputenv("NEXA_LICENSE_API_URL",
            QStringLiteral("http://127.0.0.1:%1/api/license/validate").arg(server.port()).toUtf8());

    const QString licenseKey = QStringLiteral("NDM-AAAA-BBBB-CCCC");
    const QString device = LicenseManager::deviceFingerprint();
    const QString proToken = mintToken(QStringLiteral("pro"), device, licenseKey);

    // What every Remove must leave behind, whatever was in flight: Free, by the
    // signature-derived path too, with the key and the cached token gone.
    auto expectRemoved = [&](LicenseManager &license, const QString &label) {
        CHECK(license.plan() == QLatin1String("free"), label + ": the plan ends Free");
        CHECK(!license.verifiedFeatures().authSiteDownloads,
              label + ": …by the signature-derived path too");
        CHECK(credentialstore::readLicenseKey().isEmpty(), label + ": the stored key is removed");
        CHECK(cachedToken().isEmpty(), label + ": no token is left for offline grace to replay");
    };

    // --- A. Remove while a heartbeat is out ------------------------------------
    // Never aborted, so never a crash — but never cancelled either. Its answer
    // landed after the key was gone and put Pro back.
    {
        forgetLicence();
        server.on("validate", 200, okBody(proToken));
        server.on("heartbeat", 200, okBody(proToken), /*hold=*/true);
        server.requests.clear();

        LicenseManager license;
        bool activated = false;
        QObject::connect(&license, &LicenseManager::activationFinished,
                         &license, [&](bool, const QString &) { activated = true; });
        license.activate(licenseKey);
        pump([&]() { return activated; });
        CHECK(license.plan() == QLatin1String("pro"), "A: activation puts the install on Pro");

        // Every 10th completed download sends an early beat.
        for (int i = 0; i < LicenseManager::kReverifyEveryDownloads; ++i)
            license.noteCompletedDownload();
        pump([&]() { return server.count("heartbeat") == 1; });
        CHECK(server.count("heartbeat") == 1, "A: a heartbeat is out when Remove is clicked");

        license.deactivate();
        server.release("heartbeat");          // its answer, a fresh Pro token
        settle();
        expectRemoved(license, QStringLiteral("A (heartbeat out)"));
        CHECK(license.licenseToken().isEmpty(), "A: the late beat's token is not adopted");
    }

    // --- B. Closing the app with the launch check out ----------------------------
    // Already safe, and kept that way: ~QObject disconnects the handlers before
    // it deletes the network manager and the reply with it.
    {
        forgetLicence();
        credentialstore::writeLicenseKey(licenseKey);
        server.on("validate", 200, okBody(proToken), /*hold=*/true);
        server.requests.clear();
        {
            LicenseManager license;
            license.start();
            pump([&]() { return server.count("validate") == 1; });
            CHECK(server.count("validate") == 1, "B: the launch check is out at exit");
        }
        server.release("validate");
        settle();
        // Getting here is the check: a handler run on the destroyed manager
        // would have crashed.
    }

    // --- C. Remove while the launch check is out -----------------------------------
    // A key is stored and a recent Pro token is cached, as on any paying
    // machine: the settings are opened in the seconds after launch and Remove
    // is clicked before the check has answered.
    {
        forgetLicence();
        credentialstore::writeLicenseKey(licenseKey);
        writeCachedToken(proToken);
        server.on("validate", 200, okBody(proToken), /*hold=*/true);
        server.requests.clear();

        LicenseManager license;
        license.start();
        pump([&]() { return server.count("validate") == 1; });
        CHECK(server.count("validate") == 1, "C: the launch check is out when Remove is clicked");

        // Everything the licence says from the click on. The aborted check's
        // handler would say "PRO active (offline …)" first, or "server
        // unavailable" — the offline-grace path — before Remove's "Free plan".
        QStringList statuses;
        QStringList plans;
        QObject::connect(&license, &LicenseManager::statusChanged,
                         &license, [&](const QString &status) { statuses << status; });
        QObject::connect(&license, &LicenseManager::entitlementChanged,
                         &license, [&](const QString &plan) { plans << plan; });

        license.deactivate();
        expectRemoved(license, QStringLiteral("C (launch check out)"));
        CHECK(server.count("release") == 1, "C: the seat is handed back");
        CHECK(statuses == QStringList{QStringLiteral("Free plan")},
              "C: the aborted check's handler never runs: no offline-grace plan, no outage");
        CHECK(plans.isEmpty(), "C: …and no paid plan is announced, even for a moment");

        server.release("validate");           // the answer it was waiting for
        settle();
        CHECK(statuses.size() == 1 && plans.isEmpty(),
              "C: nothing answers for the removed key afterwards");
        expectRemoved(license, QStringLiteral("C (after the held answer)"));
    }

    // --- D. Remove right after Activate --------------------------------------------
    // The activation is the user's own request, so the aborted handler used to
    // answer it as well: "activated (offline)" from the cached token, on top of
    // the removal.
    {
        forgetLicence();
        writeCachedToken(proToken);
        server.on("validate", 200, okBody(proToken), /*hold=*/true);
        server.requests.clear();

        LicenseManager license;
        QStringList answers;
        QObject::connect(&license, &LicenseManager::activationFinished, &license,
                         [&](bool ok, const QString &message) {
            answers << (ok ? QStringLiteral("ok: ") : QStringLiteral("failed: ")) + message;
        });
        license.activate(licenseKey);
        pump([&]() { return server.count("validate") == 1; });
        CHECK(server.count("validate") == 1, "D: the activation is out when Remove is clicked");

        license.deactivate();
        expectRemoved(license, QStringLiteral("D (activation out)"));
        CHECK(answers == QStringList{QStringLiteral("ok: License removed")},
              "D: the removal is the only answer the user gets");

        server.release("validate");
        settle();
        CHECK(answers.size() == 1 && license.plan() == QLatin1String("free"),
              "D: the held activation's answer changes nothing");
    }

    // --- Signing out while a check is out ------------------------------------------
    // Every sign-in ends in forgetAccount(): signOut(), or the server answering
    // `signed_out` to a validation or to a heartbeat. It left the other
    // requests running, and an answer that landed afterwards had no account
    // left to be checked against — the id and the token had just been cleared
    // — so it put the plan back and cached its token for the offline grace.
    const QString accountToken =
        mintToken(QStringLiteral("pro"), device, QStringLiteral("user:42"), 42);

    // Signed in, with the checks answering Pro, and every count from zero.
    auto signedIn = [&]() {
        forgetLicence();
        credentialstore::writeAccountToken(QStringLiteral("device-token-of-a-pro-account"));
        server.on("validate", 200, okBody(accountToken));
        server.on("heartbeat", 200, okBody(accountToken));
        server.requests.clear();
    };
    // Every 10th completed download sends an early beat.
    auto sendBeat = [](LicenseManager &license) {
        for (int i = 0; i < LicenseManager::kReverifyEveryDownloads; ++i)
            license.noteCompletedDownload();
    };
    // What every end of a sign-in must leave behind, whatever was in flight.
    auto expectSignedOut = [&](LicenseManager &license, const QString &label) {
        CHECK(!license.isSignedIn(), label + ": the machine is signed out");
        CHECK(license.plan() == QLatin1String("free"), label + ": the plan ends Free");
        CHECK(!license.verifiedFeatures().authSiteDownloads,
              label + ": …by the signature-derived path too");
        CHECK(license.licenseToken().isEmpty(), label + ": no token is held");
        CHECK(cachedToken().isEmpty(), label + ": none is cached for offline grace");
        CHECK(QSettings().value(QStringLiteral("license/accountId")).toString().isEmpty(),
              label + ": the account id is not written back");
    };

    // --- E. Sign out with the launch check out ---------------------------------------
    {
        signedIn();
        server.on("validate", 200, okBody(accountToken), /*hold=*/true);
        LicenseManager license;
        license.start();
        pump([&]() { return server.count("validate") == 1; });
        CHECK(license.isSignedIn() && server.count("validate") == 1,
              "E: signed in, with the launch check out");

        license.signOut();
        server.release("validate");           // it answers Pro
        settle();
        expectSignedOut(license, QStringLiteral("E (sign out, launch check out)"));
    }

    // --- F. Sign out with a heartbeat out --------------------------------------------
    {
        signedIn();
        server.on("heartbeat", 200, okBody(accountToken), /*hold=*/true);
        LicenseManager license;
        license.start();
        pump([&]() { return license.plan() == QLatin1String("pro"); });
        sendBeat(license);
        pump([&]() { return server.count("heartbeat") == 1; });
        CHECK(license.plan() == QLatin1String("pro") && server.count("heartbeat") == 1,
              "F: signed in on Pro, with a heartbeat out");

        license.signOut();
        server.release("heartbeat");
        settle();
        expectSignedOut(license, QStringLiteral("F (sign out, heartbeat out)"));
    }

    // --- G. A re-check answers `signed_out` while a heartbeat is out -------------------
    // start() again stands in for the six-hourly re-check: the same validate().
    {
        signedIn();
        server.on("heartbeat", 200, okBody(accountToken), /*hold=*/true);
        LicenseManager license;
        license.start();
        pump([&]() { return license.plan() == QLatin1String("pro"); });
        sendBeat(license);
        pump([&]() { return server.count("heartbeat") == 1; });

        server.on("validate", 200, rejectedBody(QStringLiteral("signed_out")));
        license.start();
        pump([&]() { return !license.isSignedIn(); });
        CHECK(!license.isSignedIn() && server.count("heartbeat") == 1,
              "G: the re-check signs the machine out, with a heartbeat out");

        server.release("heartbeat");
        settle();
        expectSignedOut(license, QStringLiteral("G (signed_out from a re-check)"));
    }

    // --- H. A heartbeat answers `signed_out` while a re-check is out -------------------
    {
        signedIn();
        server.on("heartbeat", 200, rejectedBody(QStringLiteral("signed_out")));
        LicenseManager license;
        license.start();
        pump([&]() { return license.plan() == QLatin1String("pro"); });

        server.on("validate", 200, okBody(accountToken), /*hold=*/true);
        license.start();
        pump([&]() { return server.count("validate") == 2; });
        sendBeat(license);
        pump([&]() { return !license.isSignedIn(); });
        CHECK(!license.isSignedIn() && server.count("validate") == 2,
              "H: a heartbeat signs the machine out, with a re-check out");

        server.release("validate");           // the re-check answers Pro
        settle();
        expectSignedOut(license, QStringLiteral("H (signed_out from a heartbeat)"));
    }

    forgetLicence();
    if (g_failures == 0)
        qInfo() << "LicenseRemove: all checks passed";
    return g_failures == 0 ? 0 : 1;
}
