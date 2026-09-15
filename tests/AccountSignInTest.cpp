// Account sign-in, end to end.
//
// The desktop half of the device-authorization flow: the app asks for a code,
// somebody approves it on the website, and the app is handed a token bound to
// this machine that the licence endpoints take in place of a key. What this
// drives is the real LicenseManager against a real socket, because the parts
// that break in practice are the wiring — which endpoint is derived from
// which, which credential goes on the wire, and what the app does with each
// rejection reason.
//
// The rejection reasons matter most, and they are not symmetrical:
//   signed_out          → forget the token (this machine was signed out)
//   cancelled/expired   → stay signed in, drop to Free (the plan lapsed; a
//                         renewal must reach the app with nothing to re-enter)
// Getting that backwards either strands a paying customer or leaves a revoked
// machine holding a credential.
//
// Built with NEXA_DEV_BUILD (so the endpoints can point at localhost),
// WITHOUT NEXA_LICENSE_PUBLIC_KEY (so it can mint tokens with the published
// development key), and with NEXA_TEST_CREDENTIAL_STORE (so it never writes
// into the developer's real credential manager).

#include "license/LicenseManager.h"
#include "license/LicenseToken.h"
#include "license/CredentialStore.h"

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
#include <QTimeZone>
#include <QTimer>
#include <functional>

#include <openssl/evp.h>

using namespace nexa;

static int g_failures = 0;
#define CHECK(cond, msg) do { if (!(cond)) { qWarning() << "FAIL:" << msg; ++g_failures; } } while (0)

// ---------------------------------------------------------------------------
// Signing with the development seed the backend uses when
// LICENSE_JWT_PRIVATE_KEY is unset (32 bytes of 0x4e).
// ---------------------------------------------------------------------------

static QByteArray b64u(const QByteArray &raw)
{
    return raw.toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals);
}

// An account token: `sub` is the user, not a licence key, and `acct` names the
// account it was minted for — the claim a signed-in app checks in place of the
// key comparison.
static QString mintAccountToken(const QString &plan, const QString &device,
                                int accountId, qint64 issuedAtSecs,
                                qint64 lifetimeSecs = 900)
{
    const QJsonObject header{{QStringLiteral("alg"), QStringLiteral("EdDSA")},
                             {QStringLiteral("typ"), QStringLiteral("JWT")}};
    const bool paid = plan != QLatin1String("free");
    const QJsonObject payload{
        {QStringLiteral("sub"),    QStringLiteral("user:%1").arg(accountId)},
        {QStringLiteral("acct"),   accountId},
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
// A website that answers on paths: /api/device/* speaks the {ok,data}
// envelope, /api/license/* the literal bodies the C++ app parses.
// ---------------------------------------------------------------------------

class FakeSite : public QObject {
public:
    // path → handler(requestBody) → response body
    QHash<QByteArray, std::function<QByteArray(const QJsonObject &)>> routes;
    QHash<QByteArray, int> hits;
    QHash<QByteArray, QJsonObject> lastRequest;

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
                for (const QByteArray &line : buffer.left(headerEnd).split('\n')) {
                    if (line.toLower().startsWith("content-length:"))
                        contentLength = line.mid(line.indexOf(':') + 1).trimmed().toInt();
                }
                if (buffer.size() < headerEnd + 4 + contentLength)
                    return;

                const QByteArray requestLine = buffer.left(buffer.indexOf('\r'));
                const QList<QByteArray> parts = requestLine.split(' ');
                const QByteArray path = parts.size() > 1 ? parts[1] : QByteArray();
                const QJsonObject body =
                    QJsonDocument::fromJson(buffer.mid(headerEnd + 4, contentLength)).object();
                ++hits[path];
                lastRequest[path] = body;

                QByteArray payload = "{}";
                int status = 404;
                if (routes.contains(path)) {
                    payload = routes[path](body);
                    status = 200;
                }
                QByteArray response = "HTTP/1.1 " + QByteArray::number(status)
                    + (status == 200 ? " OK\r\n" : " Not Found\r\n");
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

static QByteArray envelope(const QJsonObject &data)
{
    return QJsonDocument(QJsonObject{{QStringLiteral("ok"), true},
                                     {QStringLiteral("data"), data}})
        .toJson(QJsonDocument::Compact);
}

static QByteArray literal(const QJsonObject &body)
{
    return QJsonDocument(body).toJson(QJsonDocument::Compact);
}

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

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);

    QTemporaryDir settingsDir;
    QCoreApplication::setOrganizationName(QStringLiteral("NexaAccountSignInTest"));
    QCoreApplication::setApplicationName(QStringLiteral("NexaAccountSignInTest"));
    QCoreApplication::setApplicationVersion(QStringLiteral("9.9.9-test"));
    QSettings::setDefaultFormat(QSettings::IniFormat);
    QSettings::setPath(QSettings::IniFormat, QSettings::UserScope, settingsDir.path());

    qputenv("NEXA_ALLOW_INSECURE_LICENSE_API", "1");

    const QString device = LicenseManager::deviceFingerprint();
    const qint64 now = QDateTime::currentSecsSinceEpoch();
    const QString deviceToken = QStringLiteral("ndt_") + QString(43, QLatin1Char('a'));
    constexpr int kAccountId = 7;

    FakeSite site;
    if (!site.listen()) {
        qWarning() << "FAIL: could not start the fake site";
        return 1;
    }
    qputenv("NEXA_LICENSE_API_URL",
            QStringLiteral("http://127.0.0.1:%1/api/license/validate").arg(site.port()).toUtf8());

    // --- the website ------------------------------------------------------
    int pollsBeforeApproval = 1;
    QString pollOutcome = QStringLiteral("approved");
    site.routes["/api/device/code"] = [&](const QJsonObject &) {
        return envelope({
            {QStringLiteral("deviceCode"), QString(43, QLatin1Char('c'))},
            {QStringLiteral("userCode"), QStringLiteral("ABCD-1234")},
            {QStringLiteral("verificationUrl"), QStringLiteral("http://127.0.0.1/activate")},
            {QStringLiteral("verificationUrlComplete"),
             QStringLiteral("http://127.0.0.1/activate?code=ABCD-1234")},
            {QStringLiteral("expiresIn"), 600},
            {QStringLiteral("interval"), 1},
        });
    };
    site.routes["/api/device/token"] = [&](const QJsonObject &) {
        if (site.hits["/api/device/token"] <= pollsBeforeApproval)
            return envelope({{QStringLiteral("status"), QStringLiteral("pending")},
                             {QStringLiteral("interval"), 1}});
        if (pollOutcome != QLatin1String("approved"))
            return envelope({{QStringLiteral("status"), pollOutcome}});
        return envelope({
            {QStringLiteral("status"), QStringLiteral("approved")},
            {QStringLiteral("deviceToken"), deviceToken},
            {QStringLiteral("account"), QJsonObject{
                {QStringLiteral("id"), kAccountId},
                {QStringLiteral("email"), QStringLiteral("owner@example.com")},
                {QStringLiteral("name"), QStringLiteral("Owner")},
            }},
        });
    };
    site.routes["/api/device/signout"] = [&](const QJsonObject &) {
        return envelope({{QStringLiteral("signedOut"), true},
                         {QStringLiteral("wasSignedIn"), true}});
    };

    // /api/license/validate, programmable per case.
    QString validatePlan = QStringLiteral("pro");
    QString validateReason;             // empty = valid
    int tokenAccountId = kAccountId;    // the `acct` the token is minted for
    site.routes["/api/license/validate"] = [&](const QJsonObject &) {
        if (!validateReason.isEmpty()) {
            return literal({
                {QStringLiteral("valid"), false},
                {QStringLiteral("reason"), validateReason},
                {QStringLiteral("trial"), false},
                {QStringLiteral("account"), QJsonObject{
                    {QStringLiteral("id"), kAccountId},
                    {QStringLiteral("email"), QStringLiteral("owner@example.com")},
                }},
            });
        }
        return literal({
            {QStringLiteral("valid"), true},
            {QStringLiteral("plan"), validatePlan},
            {QStringLiteral("token"), mintAccountToken(validatePlan, device, tokenAccountId, now)},
            {QStringLiteral("trial"), false},
            {QStringLiteral("seats"), 1},
            {QStringLiteral("activeSeats"), 1},
            {QStringLiteral("account"), QJsonObject{
                {QStringLiteral("id"), kAccountId},
                {QStringLiteral("email"), QStringLiteral("owner@example.com")},
                {QStringLiteral("name"), QStringLiteral("Owner")},
            }},
        });
    };
    site.routes["/api/license/heartbeat"] = [&](const QJsonObject &) {
        return literal({{QStringLiteral("valid"), true},
                        {QStringLiteral("plan"), validatePlan},
                        {QStringLiteral("token"), mintAccountToken(validatePlan, device, tokenAccountId, now)},
                        {QStringLiteral("trial"), false},
                        {QStringLiteral("seats"), 1},
                        {QStringLiteral("activeSeats"), 1}});
    };
    site.routes["/api/license/release"] = [&](const QJsonObject &) {
        return literal({{QStringLiteral("released"), true}});
    };

    // --- A. Signing in: code, approval, and the plan that follows ----------
    {
        LicenseManager license;
        QString shownCode, shownUrl;
        bool finished = false, ok = false;
        QString accountSignal;
        QObject::connect(&license, &LicenseManager::signInCodeReady, &license,
                         [&](const QString &code, const QString &url) { shownCode = code; shownUrl = url; });
        QObject::connect(&license, &LicenseManager::signInFinished, &license,
                         [&](bool good, const QString &) { finished = true; ok = good; });
        QObject::connect(&license, &LicenseManager::accountChanged, &license,
                         [&](const QString &email) { accountSignal = email; });

        license.beginSignIn();
        pump([&]() { return !shownCode.isEmpty(); });
        CHECK(shownCode == QLatin1String("ABCD-1234"), "the code the website will show is surfaced");
        CHECK(shownUrl.contains(QLatin1String("/activate?code=ABCD-1234")),
              "the page to open carries the code");
        CHECK(license.signInInProgress(), "the sign-in is marked as waiting");
        // The request that started it must carry this machine, not a key.
        const QJsonObject codeRequest = site.lastRequest["/api/device/code"];
        CHECK(codeRequest.value(QStringLiteral("device_fingerprint")).toString() == device,
              "the code request is bound to this machine");
        CHECK(codeRequest.value(QStringLiteral("app_version")).toString()
                  == QLatin1String("9.9.9-test"),
              "the app version is sent so the person can recognise the machine");

        pump([&]() { return finished; });
        CHECK(finished && ok, "approval completes the sign-in");
        CHECK(license.isSignedIn(), "the machine is signed in");
        CHECK(!license.signInInProgress(), "the waiting state is over");
        CHECK(license.accountEmail() == QLatin1String("owner@example.com"),
              "the account is remembered for the Settings label");
        CHECK(accountSignal == QLatin1String("owner@example.com"), "accountChanged announced it");
        CHECK(credentialstore::readAccountToken() == deviceToken,
              "the token went to the credential store, not to settings");

        pump([&]() { return license.plan() == QLatin1String("pro"); });
        CHECK(license.plan() == QLatin1String("pro"), "the account's plan reaches the app");
        CHECK(license.features().adFree, "entitlements arrived with it");
        CHECK(license.verifiedFeatures().authSiteDownloads,
              "the signature-derived path agrees (no key involved)");
        CHECK(license.status().contains(QLatin1String("owner@example.com")),
              "the status says who this machine is signed in as");

        // The wire: an account validates with its token and NO licence key.
        const QJsonObject validateRequest = site.lastRequest["/api/license/validate"];
        CHECK(validateRequest.value(QStringLiteral("device_token")).toString() == deviceToken,
              "validate sends the device token");
        CHECK(!validateRequest.contains(QStringLiteral("license_key")),
              "validate sends no licence key — the server refuses both at once");
    }

    // --- B. A restart picks the account up from the credential store -------
    {
        LicenseManager license;
        license.start();
        pump([&]() { return license.plan() == QLatin1String("pro"); });
        CHECK(license.isSignedIn(), "start() found the stored account token");
        CHECK(license.plan() == QLatin1String("pro"), "and validated it without anyone typing anything");
    }

    // --- C. A token minted for another account is refused ------------------
    {
        tokenAccountId = 99;            // the server hands back somebody else's token
        LicenseManager license;
        license.start();
        pump([&]() { return license.plan() == QLatin1String("free")
                         && license.status().contains(QLatin1String("account")); });
        CHECK(license.plan() == QLatin1String("free"),
              "a token for a different account grants nothing");
        CHECK(!license.features().adFree, "and no entitlements leak from it");
        tokenAccountId = kAccountId;
    }

    // --- D. A lapsed plan keeps the machine signed in ----------------------
    //
    // The distinction that matters: `cancelled` is about the plan, not about
    // this machine, so the token stays and a renewal reaches the app on its
    // own. Deleting it here would make every lapsed customer sign in again.
    {
        validateReason = QStringLiteral("cancelled");
        LicenseManager license;
        license.start();
        pump([&]() { return license.plan() == QLatin1String("free") && license.isSignedIn()
                         && license.status().contains(QLatin1String("cancelled")); });
        CHECK(license.plan() == QLatin1String("free"), "a cancelled plan drops to Free");
        CHECK(license.isSignedIn(), "…but the machine stays signed in");
        CHECK(!credentialstore::readAccountToken().isEmpty(), "…and keeps its token");
        CHECK(license.status().contains(QLatin1String("cancelled")),
              "the reason is shown rather than a bare 'Free plan'");
        validateReason.clear();
    }

    // --- E. signed_out is the one reason that costs the token --------------
    {
        validateReason = QStringLiteral("signed_out");
        LicenseManager license;
        license.start();
        pump([&]() { return !license.isSignedIn() && license.plan() == QLatin1String("free"); });
        CHECK(!license.isSignedIn(), "a signed-out machine forgets its account");
        CHECK(credentialstore::readAccountToken().isEmpty(),
              "the token is removed from the credential store");
        CHECK(license.plan() == QLatin1String("free"), "and the app is on Free");
        CHECK(QSettings().value(QStringLiteral("license/cachedToken")).toString().isEmpty(),
              "offline grace cannot hand the plan back after a revocation");
        validateReason.clear();
    }

    // --- F. Signing out tells the server, then forgets everything ----------
    {
        // Sign in again first (the previous case revoked it).
        LicenseManager license;
        bool finished = false;
        QObject::connect(&license, &LicenseManager::signInFinished, &license,
                         [&](bool, const QString &) { finished = true; });
        license.beginSignIn();
        pump([&]() { return finished; });
        pump([&]() { return license.plan() == QLatin1String("pro"); });
        CHECK(license.isSignedIn(), "signed in again");

        const int before = site.hits["/api/device/signout"];
        license.signOut();
        CHECK(site.hits["/api/device/signout"] == before + 1,
              "signing out tells the server, so the seat frees and the dashboard updates");
        const QJsonObject request = site.lastRequest["/api/device/signout"];
        CHECK(request.value(QStringLiteral("device_token")).toString() == deviceToken,
              "the sign-out names the token being given up");
        CHECK(!license.isSignedIn(), "the account is forgotten locally");
        CHECK(credentialstore::readAccountToken().isEmpty(), "the credential store is cleared");
        CHECK(license.plan() == QLatin1String("free"), "and the app is back on Free");
    }

    // --- G. A denied sign-in leaves the machine alone ---------------------
    {
        pollOutcome = QStringLiteral("denied");
        LicenseManager license;
        bool finished = false, ok = true;
        QString message;
        QObject::connect(&license, &LicenseManager::signInFinished, &license,
                         [&](bool good, const QString &text) { finished = true; ok = good; message = text; });
        license.beginSignIn();
        pump([&]() { return finished; });
        CHECK(finished && !ok, "a denial ends the attempt");
        CHECK(message.contains(QLatin1String("denied"), Qt::CaseInsensitive),
              "and says so plainly");
        CHECK(!license.isSignedIn(), "nothing was signed in");
        CHECK(credentialstore::readAccountToken().isEmpty(), "and no token was stored");
        pollOutcome = QStringLiteral("approved");
    }

    // --- H. Cancelling stops the polling ----------------------------------
    {
        pollsBeforeApproval = 1000;     // never approved during this case
        LicenseManager license;
        QString code;
        bool finished = false, ok = true;
        QObject::connect(&license, &LicenseManager::signInCodeReady, &license,
                         [&](const QString &value, const QString &) { code = value; });
        QObject::connect(&license, &LicenseManager::signInFinished, &license,
                         [&](bool good, const QString &) { finished = true; ok = good; });
        license.beginSignIn();
        pump([&]() { return !code.isEmpty(); });
        license.cancelSignIn();
        CHECK(finished && !ok, "cancelling ends the attempt immediately");
        CHECK(!license.signInInProgress(), "and nothing is left waiting");
        const int after = site.hits["/api/device/token"];
        pump([]() { return false; }, 1500);
        CHECK(site.hits["/api/device/token"] == after, "the polling really stopped");
        pollsBeforeApproval = 1;
    }

    if (g_failures == 0)
        qInfo() << "AccountSignInTest: all checks passed";
    return g_failures == 0 ? 0 : 1;
}
