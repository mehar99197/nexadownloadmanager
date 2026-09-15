#include "license/LicenseManager.h"
#include "license/CredentialStore.h"
#include "license/LicenseToken.h"
#include "license/KeyIntegrity.h"
#include "license/Guard.h"

#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDateTime>
#include <QJsonDocument>
#include <QJsonObject>
#include <QEventLoop>
#include <QJsonArray>
#include <QNetworkAccessManager>
#include <QNetworkInterface>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRegularExpression>
#include <QSettings>
#include <QSysInfo>
#include <QTimer>
#include <QUrl>
#include <QUuid>

namespace nexa {

namespace {
constexpr auto kDeviceSeed     = "license/deviceSeed";
// The server's signed token, kept verbatim. Everything the offline path needs
// (plan, entitlements, issue time, which device it belongs to) is inside it and
// covered by the signature, so there is nothing left in settings worth editing.
// The old cachedPlan/cachedExpires/cachedAt trio is deliberately gone: writing
// `cachedPlan=pro` into this file used to be a complete, permanent bypass.
constexpr auto kCachedToken    = "license/cachedToken";
constexpr auto kCachedTrial    = "license/cachedTrial";
constexpr int  kRevalidateMs   = 6 * 60 * 60 * 1000;   // 6 hours
// The server holds a seat for 15 minutes past the last heartbeat, so beating
// every 5 leaves room for two dropped requests before a seat is lost.
constexpr int  kHeartbeatMs    = 5 * 60 * 1000;
// How far a machine's clock may disagree with the server's before a freshly
// minted licence token is treated as stale. Generous because the cost of being
// strict is refusing to activate a genuine paying customer, while the cost of
// being lenient is nil — the server re-checks expiry whenever the token is
// actually used for anything.
constexpr int  kClockSkewToleranceSecs = 30 * 60;
// How often the cached entitlements are re-derived from the signed token.
// Short enough that a patched-in "pro" does not survive usefully, long enough
// that the signature check is nowhere near a hot path.
constexpr int  kEntitlementRecheckMs = 60 * 1000;

QString planLabel(const QString &plan) { return plan.toUpper(); }

// The production licence endpoint, fixed at compile time.
//
// This is deliberately NOT overridable in a shipped build. When it was read
// from $NEXA_LICENSE_API_URL, anyone could point the app at a server of their
// own that answers {"valid":true,"plan":"pro",...} and unlock every
// client-side gate in about five minutes — no debugger, no patching, no
// reverse engineering. A developer build (-DNEXA_DEV_BUILD=ON) still honours
// the override so the backend can be run against localhost.
constexpr auto kProductionLicenseApi = "https://nexadownloadmanager.com/api/license/validate";

// The licence endpoints are siblings: .../license/validate, /heartbeat, /release.
// Deriving them from the one configured URL keeps a dev override pointing the
// whole family at localhost instead of only the validate call.
//
// The override is compiled in ONLY for a -DNEXA_DEV_BUILD=ON build. In a
// shipped binary the environment variable is never consulted: otherwise anyone
// could point validation at a server of their own that answers "pro", which is
// the cheapest of the licensing bypasses recorded in docs/issues.md.
QUrl licenseEndpoint(const QString &action)
{
#ifdef NEXA_DEV_BUILD
    // qEnvironmentVariable takes a const char* name, not a QString — passing a
    // QStringLiteral here does not compile. It went unnoticed because nothing
    // built this branch: it only exists under NEXA_DEV_BUILD.
    const QUrl base(qEnvironmentVariable("NEXA_LICENSE_API_URL",
                                         QString::fromLatin1(kProductionLicenseApi)));
#else
    const QUrl base{QLatin1String(kProductionLicenseApi)};
#endif
    if (action == QLatin1String("validate"))
        return base;
    QUrl url(base);
    QString path = base.path();
    const int slash = path.lastIndexOf(QLatin1Char('/'));
    if (slash >= 0)
        path.truncate(slash + 1);
    url.setPath(path + action);
    return url;
}

// An endpoint is usable if it is HTTPS. A developer build additionally accepts
// plain HTTP on loopback when explicitly opted in; a shipped build has no such
// escape hatch, because "run a plain-HTTP server on 127.0.0.1" was otherwise a
// licence bypass that needed no TLS certificate at all.
bool endpointAllowed(const QUrl &endpoint)
{
#ifdef NEXA_DEV_BUILD
    const bool insecureDevelopment =
        qEnvironmentVariableIntValue("NEXA_ALLOW_INSECURE_LICENSE_API") == 1 &&
        (endpoint.host() == QLatin1String("localhost") || endpoint.host() == QLatin1String("127.0.0.1"));
#else
    constexpr bool insecureDevelopment = false;
#endif
    return endpoint.isValid()
        && (endpoint.scheme() == QLatin1String("https") || insecureDevelopment);
}
}

LicenseManager::LicenseManager(QObject *parent)
    : QObject(parent), m_network(new QNetworkAccessManager(this))
{
    // Periodic re-validation: a trial that ends, or a cancelled subscription,
    // takes effect without a restart; an outage keeps the cached entitlement.
    m_revalidate = new QTimer(this);
    m_revalidate->setInterval(kRevalidateMs);
    connect(m_revalidate, &QTimer::timeout, this, [this]() {
        if (!m_licenseKey.isEmpty() && !m_reply)
            validate(m_licenseKey, false);
    });
    m_revalidate->start();

    // Seats are concurrent, so the server has to be told this machine is still
    // running. Only beats while a licence key is in use; Free installs never
    // touch the network here.
    m_heartbeat = new QTimer(this);
    m_heartbeat->setInterval(kHeartbeatMs);
    connect(m_heartbeat, &QTimer::timeout, this, &LicenseManager::sendHeartbeat);

    // Re-derive entitlements from the signed token on a short cycle. Everything
    // in the UI reads the cached struct for speed, and this is what stops that
    // struct from being a single durable place to patch: whatever it is set to,
    // it goes back to what the signature says within a minute. Runs always,
    // including on Free, so the code path is not something that only exists on
    // paid installs.
    m_recheck = new QTimer(this);
    m_recheck->setInterval(kEntitlementRecheckMs);
    connect(m_recheck, &QTimer::timeout, this, &LicenseManager::recheckEntitlements);
    m_recheck->start();
}

// The MAC of the first real wired/wireless interface, lowercased. Virtual,
// loopback and point-to-point interfaces are skipped because Docker, VPN and
// VM adapters come and go — including one would change the fingerprint between
// runs and silently burn a seat every time.
static QByteArray primaryMacAddress()
{
    QString best;
    for (const QNetworkInterface &iface : QNetworkInterface::allInterfaces()) {
        const QNetworkInterface::InterfaceFlags flags = iface.flags();
        if (flags & QNetworkInterface::IsLoopBack)
            continue;
        if (!(flags & QNetworkInterface::IsUp))
            continue;
        const QNetworkInterface::InterfaceType type = iface.type();
        if (type != QNetworkInterface::Ethernet && type != QNetworkInterface::Wifi)
            continue;
        const QString hw = iface.hardwareAddress().toLower();
        if (hw.isEmpty() || hw == QLatin1String("00:00:00:00:00:00"))
            continue;
        // Deterministic pick: lowest address wins, so interface enumeration
        // order (which is not stable across reboots) cannot change the id.
        if (best.isEmpty() || hw < best)
            best = hw;
    }
    return best.toLatin1();
}

// Stable, opaque id for this machine.
//
// Built from the primary MAC plus the OS machine id, then hashed — the raw MAC
// never leaves the device, so this identifies a machine for seat counting
// without shipping a hardware address to the server. Either input alone is
// enough: a machine with no usable NIC still gets the machine id, and a
// reinstalled OS keeps the same MAC.
QString LicenseManager::deviceFingerprint()
{
    QByteArray identity = primaryMacAddress();
    identity += QSysInfo::machineUniqueId();
    if (identity.isEmpty()) {
        // No MAC and no machine id (some containers/BSDs): fall back to a seed
        // generated once and kept in settings.
        QSettings settings;
        identity = settings.value(QLatin1String(kDeviceSeed)).toByteArray();
        if (identity.isEmpty()) {
            identity = QUuid::createUuid().toByteArray(QUuid::WithoutBraces);
            settings.setValue(QLatin1String(kDeviceSeed), identity);
        }
    }
    return QString::fromLatin1(QCryptographicHash::hash(
        QByteArrayLiteral("NexaDownloadManager/license/v2/") + identity,
        QCryptographicHash::Sha256).toHex());
}

QString LicenseManager::deviceName()
{
    const QString host = QSysInfo::machineHostName();
    const QString os = QSysInfo::prettyProductName();
    if (host.isEmpty())
        return os.isEmpty() ? QStringLiteral("Unknown device") : os;
    return os.isEmpty() ? host : QStringLiteral("%1 (%2)").arg(host, os);
}

void LicenseManager::start()
{
    // Reading the OS credential store BLOCKS. On Linux it runs a python3 helper
    // against the Secret Service: a machine without python3 or secretstorage
    // pays the full 2 s start timeout, and a locked keyring can raise an unlock
    // prompt inside the 5 s finish timeout. main() calls this before the window
    // is shown, so doing it inline froze every launch on exactly the machines
    // least able to afford it.
    //
    // Defer to the event loop instead. Nothing is lost by waiting one turn: the
    // pre-answer state is already Free (Entitlements defaults to the Free set),
    // so the app gates rather than leaks while the key is being read.
    QTimer::singleShot(0, this, [this]() {
        const QString key = credentialstore::readLicenseKey();
        if (key.isEmpty()) {
            setPlan(QStringLiteral("free"),
                    QStringLiteral("Free plan — enter a license key in Settings"));
            return;
        }
        m_licenseKey = key;
        validate(key, false);
    });
}

void LicenseManager::activate(const QString &licenseKey)
{
    static const QRegularExpression keyPattern(QStringLiteral("\\ANDM(?:-[A-Z0-9]{4}){3}\\z"));
    const QString key = licenseKey.trimmed().toUpper();
    if (!keyPattern.match(key).hasMatch()) {
        emit activationFinished(false, QStringLiteral("Invalid license key format"));
        return;
    }
    validate(key, true);
}

void LicenseManager::validate(const QString &licenseKey, bool userInitiated)
{
    if (m_reply) {
        // Drop our handler FIRST: abort() emits finished() synchronously, and the
        // handler would treat the cancellation as "server unavailable" and rewrite
        // the plan from cache moments before this fresh answer arrives.
        m_reply->disconnect(this);
        m_reply->abort();
        m_reply->deleteLater();
        m_reply = nullptr;
    }

    const QUrl endpoint = licenseEndpoint(QStringLiteral("validate"));
    if (!endpointAllowed(endpoint)) {
        const QString message = QStringLiteral("License API must use HTTPS");
        setPlan(QStringLiteral("free"), message);
        if (userInitiated)
            emit activationFinished(false, message);
        return;
    }

    QNetworkRequest request(endpoint);
    request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    request.setHeader(QNetworkRequest::UserAgentHeader,
                      QStringLiteral("Nexa/%1").arg(QCoreApplication::applicationVersion()));
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                         QNetworkRequest::NoLessSafeRedirectPolicy);
    request.setTransferTimeout(15000);

    const QByteArray body = QJsonDocument(QJsonObject{
        {QStringLiteral("license_key"), licenseKey},
        {QStringLiteral("device_fingerprint"), deviceFingerprint()},
        {QStringLiteral("device_name"), deviceName()},
    }).toJson(QJsonDocument::Compact);

    // Status only — don't drop the plan while we wait (a startup re-check would
    // otherwise flicker Pro → Free → Pro and re-cap the queue for a moment).
    m_status = QStringLiteral("Validating license…");
    emit statusChanged(m_status);
    m_reply = m_network->post(request, body);
    connect(m_reply, &QNetworkReply::finished, this,
            [this, licenseKey, userInitiated]() {
        QNetworkReply *reply = m_reply;
        m_reply = nullptr;
        if (!reply)
            return;
        const QNetworkReply::NetworkError networkError = reply->error();
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const QByteArray response = reply->readAll();
        reply->deleteLater();

        if (networkError != QNetworkReply::NoError || status != 200) {
            // Offline / server down: keep a recently confirmed paid plan working for
            // kOfflineGraceDays rather than punishing the user for a network blip.
            applyCachedEntitlement(QStringLiteral("License server unavailable; Free plan active"),
                                   userInitiated);
            return;
        }
        if (response.size() > 64 * 1024) {
            const QString message = QStringLiteral("License server returned an invalid response");
            setPlan(QStringLiteral("free"), message);
            if (userInitiated)
                emit activationFinished(false, message);
            return;
        }

        QJsonParseError parseError;
        const QJsonDocument document = QJsonDocument::fromJson(response, &parseError);
        const QJsonObject object = document.object();
        if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
            const QString message = QStringLiteral("License server returned an invalid response");
            setPlan(QStringLiteral("free"), message);
            if (userInitiated)
                emit activationFinished(false, message);
            return;
        }

        if (!object.value(QStringLiteral("valid")).toBool()) {
            const QString reason = object.value(QStringLiteral("reason")).toString(QStringLiteral("invalid"));

            // A full licence is NOT a bad licence. Keep the key — the user only
            // has to close the app on another machine — and say so plainly
            // instead of deleting their credential and making them re-enter it.
            if (reason == QLatin1String("seat_limit")) {
                const int seats = object.value(QStringLiteral("seats")).toInt(1);
                m_licenseKey = licenseKey;
                m_licenseToken.clear();
                m_heartbeat->stop();
                setFeaturesForPlan(QStringLiteral("free"));
                const QString message =
                    tr("All %n seat(s) on this license are in use on other devices", nullptr, seats);
                setPlan(QStringLiteral("free"), message);
                emit seatLimitReached(seats);
                if (userInitiated)
                    emit activationFinished(false, message);
                return;
            }

            credentialstore::removeLicenseKey();
            clearCache();
            m_licenseKey.clear();
            m_licenseToken.clear();
            m_trial = false;
            m_expires = QDateTime();
            m_heartbeat->stop();
            setFeaturesForPlan(QStringLiteral("free"));
            const QString message = QStringLiteral("License rejected: %1").arg(reason);
            setPlan(QStringLiteral("free"), message);
            if (userInitiated)
                emit activationFinished(false, message);
            return;
        }

        // The plan and entitlements are taken from the SIGNED token, never from
        // the sibling JSON. That JSON is whatever the other end of the socket
        // chose to send; the token is something only the licence server can
        // produce. Reading `plan` from the response body was the flaw that made
        // a five-minute fake server enough to unlock everything.
        const QString token = object.value(QStringLiteral("token")).toString();
        licensetoken::Claims claims;
        QString tokenError;
        if (!licensetoken::verify(token, &claims, &tokenError)) {
            const QString message = QStringLiteral("License response could not be verified");
            setFeaturesForPlan(QStringLiteral("free"));
            setPlan(QStringLiteral("free"), message);
            if (userInitiated)
                emit activationFinished(false, message);
            return;
        }
        // A token is issued to one machine. Without this check a paid token
        // could be copied from one install to another and shared freely.
        if (claims.device != deviceFingerprint()) {
            const QString message = QStringLiteral("License token was issued to a different device");
            setFeaturesForPlan(QStringLiteral("free"));
            setPlan(QStringLiteral("free"), message);
            if (userInitiated)
                emit activationFinished(false, message);
            return;
        }
        // …and for the key we actually asked about, so a token minted for one
        // licence cannot answer for another.
        if (!claims.licenseKey.isEmpty() && claims.licenseKey != licenseKey) {
            const QString message = QStringLiteral("License token does not match this key");
            setFeaturesForPlan(QStringLiteral("free"));
            setPlan(QStringLiteral("free"), message);
            if (userInitiated)
                emit activationFinished(false, message);
            return;
        }
        // Tolerant on purpose. Tokens live 15 minutes, so a machine whose clock
        // is a few minutes fast would otherwise see every freshly minted token
        // as already expired and never activate at all. This check is hygiene
        // against an obviously stale replay — the server is what actually
        // enforces expiry when the token is used, and it applies its own skew
        // allowance there.
        if (claims.expiresAt.addSecs(kClockSkewToleranceSecs) <= QDateTime::currentDateTimeUtc()) {
            const QString message = QStringLiteral("License token has already expired");
            setFeaturesForPlan(QStringLiteral("free"));
            setPlan(QStringLiteral("free"), message);
            if (userInitiated)
                emit activationFinished(false, message);
            return;
        }

        const QString plan = claims.plan;
        const bool stored = credentialstore::writeLicenseKey(licenseKey);
        m_licenseKey = licenseKey;
        m_licenseToken = token;
        // `trial` and `expires` only shape the status text — the entitlements
        // they used to imply now come from the token — so they may keep coming
        // from the response body.
        m_trial = object.value(QStringLiteral("trial")).toBool(false);
        m_expires = QDateTime::fromString(object.value(QStringLiteral("expires")).toString(), Qt::ISODate);
        applyFeatures(claims.features, plan);
        // Display-only, so it may come from the response body.
        m_activeSeats = object.value(QStringLiteral("activeSeats")).toInt(m_activeSeats);
        cacheEntitlement(token, m_trial);
        // The seat is ours; keep it by beating until the app closes.
        if (!m_heartbeat->isActive())
            m_heartbeat->start();

        QString message;
        if (m_trial && m_expires.isValid()) {
            const qint64 hoursLeft = QDateTime::currentDateTimeUtc().secsTo(m_expires) / 3600;
            const qint64 daysLeft = qMax<qint64>(0, (hoursLeft + 23) / 24);
            message = QStringLiteral("%1 trial — %2 day%3 left")
                .arg(planLabel(plan)).arg(daysLeft).arg(daysLeft == 1 ? QString() : QStringLiteral("s"));
        } else {
            message = QStringLiteral("%1 license active").arg(planLabel(plan));
        }
        if (!stored)
            message += QStringLiteral(" (this session only; OS credential store unavailable)");
        setPlan(plan, message);
        if (userInitiated)
            emit activationFinished(true, message);
    });
}

// Known-good entitlements for a plan, used when the server sends no `features`
// object (older backend) and whenever we fall back to Free.
void LicenseManager::setFeaturesForPlan(const QString &plan)
{
    const bool paid = plan == QLatin1String("pro") || plan == QLatin1String("team");
    Entitlements f;                       // defaults are the Free set
    if (paid) {
        f.maxConcurrentDownloads = 0;     // unlimited
        f.themes = QStringLiteral("all");
        f.authSiteDownloads = true;
        f.aiRename = true;
        f.adFree = true;
        f.seats = plan == QLatin1String("team") ? 5 : 1;
    }
    m_features = f;
    emit featuresChanged(m_features);
}

void LicenseManager::applyFeatures(const QJsonObject &f, const QString &plan)
{
    // Start from the plan's defaults so a server that omits a key (or an older
    // server whose token carries no `features` at all) still yields a coherent
    // set. The plan itself already came from the signed claims.
    setFeaturesForPlan(plan);
    if (f.isEmpty())
        return;
    Entitlements e = m_features;
    if (f.contains(QStringLiteral("maxConcurrentDownloads")))
        e.maxConcurrentDownloads = qMax(0, f.value(QStringLiteral("maxConcurrentDownloads")).toInt(e.maxConcurrentDownloads));
    if (f.value(QStringLiteral("themes")).isString())
        e.themes = f.value(QStringLiteral("themes")).toString();
    if (f.value(QStringLiteral("freeThemes")).isArray()) {
        QStringList ids;
        const QJsonArray arr = f.value(QStringLiteral("freeThemes")).toArray();
        for (const QJsonValue &v : arr)
            if (v.isString()) ids << v.toString();
        if (!ids.isEmpty())
            e.freeThemes = ids;
    }
    if (f.contains(QStringLiteral("authSiteDownloads")))
        e.authSiteDownloads = f.value(QStringLiteral("authSiteDownloads")).toBool(e.authSiteDownloads);
    if (f.contains(QStringLiteral("aiRename")))
        e.aiRename = f.value(QStringLiteral("aiRename")).toBool(e.aiRename);
    if (f.contains(QStringLiteral("adFree")))
        e.adFree = f.value(QStringLiteral("adFree")).toBool(e.adFree);
    if (f.contains(QStringLiteral("seats")))
        e.seats = qMax(1, f.value(QStringLiteral("seats")).toInt(e.seats));

    m_features = e;
    emit featuresChanged(m_features);
}

// Keep this machine's seat lease alive. Fire-and-forget: a failed beat costs
// nothing because the lease outlives two missed intervals, and a genuine
// seat_limit answer is surfaced so the user learns why the app went Free.
void LicenseManager::sendHeartbeat()
{
    if (m_licenseKey.isEmpty() || m_heartbeatReply)
        return;
    const QUrl endpoint = licenseEndpoint(QStringLiteral("heartbeat"));
    if (!endpointAllowed(endpoint))
        return;

    QNetworkRequest request(endpoint);
    request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                         QNetworkRequest::NoLessSafeRedirectPolicy);
    request.setTransferTimeout(15000);

    const QByteArray body = QJsonDocument(QJsonObject{
        {QStringLiteral("license_key"), m_licenseKey},
        {QStringLiteral("device_fingerprint"), deviceFingerprint()},
        {QStringLiteral("device_name"), deviceName()},
    }).toJson(QJsonDocument::Compact);

    m_heartbeatReply = m_network->post(request, body);
    connect(m_heartbeatReply, &QNetworkReply::finished, this, [this]() {
        QNetworkReply *reply = m_heartbeatReply;
        m_heartbeatReply = nullptr;
        if (!reply)
            return;
        const bool transportOk = reply->error() == QNetworkReply::NoError
            && reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt() == 200;
        const QByteArray response = reply->readAll();
        reply->deleteLater();
        if (!transportOk || response.size() > 64 * 1024)
            return;   // a missed beat is harmless; the lease has slack

        const QJsonObject object = QJsonDocument::fromJson(response).object();
        if (object.value(QStringLiteral("valid")).toBool()) {
            m_activeSeats = object.value(QStringLiteral("activeSeats")).toInt(m_activeSeats);
            adoptRefreshedToken(object.value(QStringLiteral("token")).toString());
            return;
        }
        // Every rejection reason has to be handled here. This used to act on
        // seat_limit alone and silently discard the rest, so a cancelled or
        // expired licence went on running as Pro until the six-hourly
        // revalidation happened to notice.
        const QString reason = object.value(QStringLiteral("reason")).toString();
        if (reason.isEmpty())
            return;   // malformed body; a missed beat is harmless, the lease has slack

        const int seats = object.value(QStringLiteral("seats")).toInt(m_features.seats);

        // The seat is gone but the licence is fine, so the key is kept — the user
        // has nothing to re-enter. Both cases stop the heartbeat: without that
        // this fires again every five minutes and pops the dialog each time.
        // Recovery is the next revalidation, or the user re-activating.
        const bool revoked = reason == QLatin1String("seat_revoked");
        if (revoked || reason == QLatin1String("seat_limit")) {
            m_licenseToken.clear();
            m_heartbeat->stop();
            // Offline grace must not hand the plan straight back: without this,
            // pulling the network undoes the revocation for a further 7 days.
            clearCache();
            setFeaturesForPlan(QStringLiteral("free"));
            setPlan(QStringLiteral("free"),
                    revoked
                        ? tr("Seat not available on this license — it was freed from your account")
                        : tr("Seat not available on this license — all %n seat(s) are in use "
                             "on other devices", nullptr, seats));
            if (revoked)
                emit seatRevoked();
            else
                emit seatLimitReached(seats);
            return;
        }

        // not_found / cancelled / expired / invalid: the licence itself stopped
        // being usable, so the stored key goes with it.
        credentialstore::removeLicenseKey();
        clearCache();
        m_licenseKey.clear();
        m_licenseToken.clear();
        m_trial = false;
        m_expires = QDateTime();
        m_heartbeat->stop();
        setFeaturesForPlan(QStringLiteral("free"));
        setPlan(QStringLiteral("free"), QStringLiteral("License rejected: %1").arg(reason));
    });
}

// Derive plan and entitlements from a signature, not from stored state.
//
// Order matters: the live token first, then the cached one under the offline
// grace policy. Both are verified against the compiled-in public key, so this
// function's answer cannot be improved by editing settings, and a patched
// binary cannot improve it without defeating Ed25519.
bool LicenseManager::deriveFromToken(QString *plan, Entitlements *features) const
{
    auto accept = [&](const licensetoken::Claims &claims) {
        if (plan)
            *plan = claims.plan;
        if (features) {
            // Mirrors applyFeatures()' merge, but writes to the caller's copy
            // so this stays free of side effects and safe to call anywhere.
            Entitlements derived;
            const bool paid = claims.plan == QLatin1String("pro")
                              || claims.plan == QLatin1String("team");
            if (paid) {
                derived.maxConcurrentDownloads = 0;
                derived.themes = QStringLiteral("all");
                derived.authSiteDownloads = true;
                derived.aiRename = true;
                derived.adFree = true;
                derived.seats = claims.plan == QLatin1String("team") ? 5 : 1;
            }
            const QJsonObject f = claims.features;
            if (f.contains(QStringLiteral("maxConcurrentDownloads")))
                derived.maxConcurrentDownloads =
                    qMax(0, f.value(QStringLiteral("maxConcurrentDownloads")).toInt(derived.maxConcurrentDownloads));
            if (f.value(QStringLiteral("themes")).isString())
                derived.themes = f.value(QStringLiteral("themes")).toString();
            if (f.value(QStringLiteral("freeThemes")).isArray()) {
                QStringList ids;
                for (const QJsonValue &v : f.value(QStringLiteral("freeThemes")).toArray())
                    if (v.isString()) ids << v.toString();
                if (!ids.isEmpty())
                    derived.freeThemes = ids;
            }
            if (f.contains(QStringLiteral("authSiteDownloads")))
                derived.authSiteDownloads = f.value(QStringLiteral("authSiteDownloads")).toBool(derived.authSiteDownloads);
            if (f.contains(QStringLiteral("aiRename")))
                derived.aiRename = f.value(QStringLiteral("aiRename")).toBool(derived.aiRename);
            if (f.contains(QStringLiteral("adFree")))
                derived.adFree = f.value(QStringLiteral("adFree")).toBool(derived.adFree);
            if (f.contains(QStringLiteral("seats")))
                derived.seats = qMax(1, f.value(QStringLiteral("seats")).toInt(derived.seats));
            *features = derived;
        }
        return true;
    };

    // If the compiled-in public key is not the one this build shipped with,
    // every signature below would be checked against an attacker's key and
    // would happily pass. Refusing here degrades the install to Free quietly —
    // no dialog, no crash, no message naming the check — because a loud failure
    // is a signpost to whoever is looking for it.
    if (!licensetoken::publicKeyIntact())
        return false;

    const QDateTime now = QDateTime::currentDateTimeUtc();

    licensetoken::Claims live;
    if (!m_licenseToken.isEmpty()
        && licensetoken::verify(m_licenseToken, &live)
        && live.device == deviceFingerprint()
        && live.expiresAt.addSecs(kClockSkewToleranceSecs) > now) {
        return accept(live);
    }

    // Offline: the cached token still speaks for this install inside the grace
    // window. Without this branch a re-derivation would drop a paying customer
    // to Free the moment their connection went away.
    QSettings settings;
    licensetoken::Claims cached;
    const QString stored = settings.value(QLatin1String(kCachedToken)).toString();
    if (!stored.isEmpty()
        && licensetoken::verify(stored, &cached)
        && licensetoken::offlineGraceAllows(cached, deviceFingerprint(), now, kOfflineGraceDays)) {
        return accept(cached);
    }

    return false;
}

// --- Redundant re-verifications behind the guard -----------------------------
//
// Each of these re-derives one fact from the signed token independently. They
// overlap with deriveFromToken and with each other ON PURPOSE: the guard
// combines them so that patching the one obvious gate leaves the rest standing,
// and none of them can be tricked by editing settings or overwriting a cached
// struct, because each re-runs Ed25519 verification against the compiled-in key.

bool LicenseManager::isPaidPlan(const QString &plan)
{
    return plan == QLatin1String("pro") || plan == QLatin1String("team");
}

bool LicenseManager::liveTokenGrantsPaid() const
{
    if (m_licenseToken.isEmpty())
        return false;
    licensetoken::Claims c;
    if (!licensetoken::verify(m_licenseToken, &c))
        return false;
    if (c.device != deviceFingerprint())
        return false;
    if (c.expiresAt.addSecs(kClockSkewToleranceSecs) <= QDateTime::currentDateTimeUtc())
        return false;
    return isPaidPlan(c.plan);
}

bool LicenseManager::cachedTokenGrantsPaidInGrace() const
{
    QSettings settings;
    const QString stored = settings.value(QLatin1String(kCachedToken)).toString();
    if (stored.isEmpty())
        return false;
    licensetoken::Claims c;
    if (!licensetoken::verify(stored, &c))
        return false;
    return licensetoken::offlineGraceAllows(
        c, deviceFingerprint(), QDateTime::currentDateTimeUtc(), kOfflineGraceDays);
}

bool LicenseManager::hasSignedPaidGrant() const
{
    const QString fingerprint = deviceFingerprint();
    const auto grantsPaid = [&](const QString &token) {
        if (token.isEmpty())
            return false;
        licensetoken::Claims c;
        if (!licensetoken::verify(token, &c))
            return false;
        if (c.device != fingerprint)
            return false;
        return isPaidPlan(c.plan);
    };
    if (grantsPaid(m_licenseToken))
        return true;
    QSettings settings;
    return grantsPaid(settings.value(QLatin1String(kCachedToken)).toString());
}

// The expensive gate. This is what unlocking a paid feature has to get past, so
// it does three things at once: re-derives the entitlements from the signature
// (deriveFromToken), re-confirms that answer through the guard's independent,
// obfuscated, per-release-rotated checks, and trips a sticky tamper canary if
// the in-memory plan claims paid while no signature backs it.
//
// For every legitimate input the return value is exactly what deriveFromToken
// alone would produce (GuardTest and OfflineGraceTest both hold this). The only
// additions are behavioural on a *patched* install: the canary latches and
// scattered reads fold to Free.
Entitlements LicenseManager::verifiedFeatures() const
{
    QString plan;
    Entitlements derived;                       // Free by default — fails closed
    const bool derivedOk = deriveFromToken(&plan, &derived);
    const bool derivedPaid = derivedOk && isPaidPlan(plan);

    // The guard's five independent checks. Side-effect free, so the seed-chosen
    // order the guard runs them in never changes the answer.
    guard::Checks checks = {
        [] { return licensetoken::publicKeyIntact(); },
        [this] { return liveTokenGrantsPaid(); },
        [this] { return cachedTokenGrantsPaidInGrace(); },
        [this] { return isPaidPlan(m_plan); },
        [this] { return hasSignedPaidGrant(); },
    };
    const guard::Result g = guard::evaluate(checks);
    if (g.tamper)
        m_tamperObserved = true;                // sticky for the session

    // derivedPaid implies g.paid (both rest on the same signatures and key
    // check), so for a real paid user this is simply derivedPaid && !tampered.
    const bool paidConfirmed = derivedPaid && g.paid && !m_tamperObserved;
    if (paidConfirmed)
        return derived;                         // the paid entitlements

    // Not confirmed paid: preserve a valid FREE token's own entitlements (custom
    // freeThemes and the like), else the Free defaults. A tampered install lands
    // here too, on Free — degrade only, never anything destructive.
    if (derivedOk && !derivedPaid)
        return derived;
    return Entitlements();
}

// Re-derive the cached entitlements from the signature, quietly.
//
// This is what makes overwriting m_features a temporary win rather than a
// permanent one: whatever it was set to, a minute later it is whatever the
// token actually says. It never *raises* the plan on its own — an install with
// no valid token lands on Free, which is where it belongs.
void LicenseManager::recheckEntitlements()
{
    QString plan = QStringLiteral("free");
    Entitlements ignore;            // Free defaults
    deriveFromToken(&plan, &ignore);

    // Go through the guarded read, not deriveFromToken directly: it maintains the
    // tamper canary and returns Free-folded entitlements when the in-memory paid
    // state is not backed by a signature. For an untampered install this is the
    // same struct deriveFromToken produced.
    const Entitlements derived = verifiedFeatures();
    // Once tamper has been observed, the plan drops to Free too, so the cheap
    // features() copy the UI reads and the plan gates all reflect it.
    if (m_tamperObserved)
        plan = QStringLiteral("free");

    const bool sameFeatures =
        derived.maxConcurrentDownloads == m_features.maxConcurrentDownloads
        && derived.themes == m_features.themes
        && derived.freeThemes == m_features.freeThemes
        && derived.authSiteDownloads == m_features.authSiteDownloads
        && derived.aiRename == m_features.aiRename
        && derived.adFree == m_features.adFree
        && derived.seats == m_features.seats;
    if (sameFeatures && plan == m_plan)
        return;                     // the common case: nothing to say

    m_features = derived;
    emit featuresChanged(m_features);
    if (plan != m_plan) {
        // Only ever downgrade from here. Raising the plan is something a server
        // response does, with a status message to match.
        const bool derivedIsPaid = plan == QLatin1String("pro") || plan == QLatin1String("team");
        if (!derivedIsPaid)
            setPlan(plan, tr("Free plan"));
    }
}

// Take a token the heartbeat handed back.
//
// Licence tokens are short-lived (15 minutes, matching the seat lease), so this
// is what keeps a running app in possession of a valid one. It is held to the
// same standard as a token from /validate — verified, and bound to this device
// — because "it arrived on the heartbeat" is not evidence of anything; the
// heartbeat response is as forgeable as any other.
//
// A refused or absent token is not an error: an older server simply does not
// send one, and the token already held stays in place until it lapses.
void LicenseManager::adoptRefreshedToken(const QString &token)
{
    if (token.isEmpty())
        return;

    licensetoken::Claims claims;
    if (!licensetoken::verify(token, &claims))
        return;
    if (claims.device != deviceFingerprint())
        return;
    if (!m_licenseKey.isEmpty() && !claims.licenseKey.isEmpty()
        && claims.licenseKey != m_licenseKey)
        return;

    m_licenseToken = token;

    // A beat is the server vouching for this install right now, so it also
    // refreshes the offline-grace window — a user online all week then gets the
    // full 7 days from when they actually went offline, not from whenever the
    // six-hourly revalidation last happened to run.
    cacheEntitlement(token, m_trial);

    // A plan change (an admin downgrade, a lapsed subscription) reaches the
    // client here rather than waiting for the next revalidation. Only act when
    // it actually changed, so a beat does not churn signals every 5 minutes.
    if (claims.plan != m_plan) {
        applyFeatures(claims.features, claims.plan);
        setPlan(claims.plan, claims.plan == QLatin1String("free")
                                 ? tr("Free plan")
                                 : QStringLiteral("%1 license active").arg(planLabel(claims.plan)));
    }
}

// Best-effort synchronous release so a seat frees the moment the app closes
// instead of after the lease times out. Bounded by a short timer because
// quitting must never hang on the network.
void LicenseManager::releaseSeat()
{
    if (m_heartbeat)
        m_heartbeat->stop();
    if (m_licenseKey.isEmpty())
        return;
    const QUrl endpoint = licenseEndpoint(QStringLiteral("release"));
    if (!endpointAllowed(endpoint))
        return;

    QNetworkRequest request(endpoint);
    request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    request.setTransferTimeout(3000);

    const QByteArray body = QJsonDocument(QJsonObject{
        {QStringLiteral("license_key"), m_licenseKey},
        {QStringLiteral("device_fingerprint"), deviceFingerprint()},
    }).toJson(QJsonDocument::Compact);

    QNetworkReply *reply = m_network->post(request, body);
    QEventLoop loop;
    QTimer guard;
    guard.setSingleShot(true);
    connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    connect(&guard, &QTimer::timeout, &loop, &QEventLoop::quit);
    guard.start(3000);
    loop.exec(QEventLoop::ExcludeUserInputEvents);
    if (reply->isRunning())
        reply->abort();
    reply->deleteLater();
}

void LicenseManager::cacheEntitlement(const QString &token, bool trial)
{
    QSettings settings;
    settings.setValue(QLatin1String(kCachedToken), token);
    settings.setValue(QLatin1String(kCachedTrial), trial);
}

void LicenseManager::applyCachedEntitlement(const QString &offlineReason, bool userInitiated)
{
    QSettings settings;
    const QString token = settings.value(QLatin1String(kCachedToken)).toString();
    const bool trial = settings.value(QLatin1String(kCachedTrial), false).toBool();

    // Everything the decision rests on is now inside a signature: the plan, the
    // entitlements, when it was issued, and which machine it was issued to.
    // Hand-editing this file can no longer produce a paid plan — it can only
    // produce a token that fails to verify, which lands on Free below.
    licensetoken::Claims claims;
    const QDateTime now = QDateTime::currentDateTimeUtc();
    // The whole decision: a signature that checks out, plus the grace policy in
    // licensetoken::offlineGraceAllows (paid plan, issued to this device, `iat`
    // within the window and not in the future). `iat` is the server's own
    // record of when it last vouched for this install, so the window is
    // measured against something the user cannot move. A user who rolls the
    // whole system clock back can still stretch it — that breaks TLS and much
    // else on their machine, and no offline grace scheme survives it.
    const bool allowed = licensetoken::verify(token, &claims)
        && licensetoken::offlineGraceAllows(claims, deviceFingerprint(), now, kOfflineGraceDays);

    if (allowed) {
        m_trial = trial;
        m_expires = QDateTime();
        // Offline grace restores the token's own entitlements, not a guess from
        // the plan name — so a Team seat count or a server-side feature flip
        // survives an outage exactly as issued.
        applyFeatures(claims.features, claims.plan);
        const QString plan = claims.plan;
        const qint64 days = claims.issuedAt.daysTo(now);
        const QString when = days <= 0 ? QStringLiteral("today")
                           : QStringLiteral("%1 day%2 ago").arg(days).arg(days == 1 ? QString() : QStringLiteral("s"));
        const QString message = QStringLiteral("%1 active (offline — last verified %2)")
            .arg(planLabel(plan), when);
        setPlan(plan, message);
        if (userInitiated)
            emit activationFinished(true, message);
        return;
    }
    m_trial = false;
    m_expires = QDateTime();
    setFeaturesForPlan(QStringLiteral("free"));
    setPlan(QStringLiteral("free"), offlineReason);
    if (userInitiated)
        emit activationFinished(false, offlineReason);
}

void LicenseManager::deactivate()
{
    if (m_reply) {
        m_reply->abort();
        m_reply->deleteLater();
        m_reply = nullptr;
    }
    // Give the seat back before forgetting the key, or it would sit occupied
    // until the lease expired even though this machine is no longer licensed.
    releaseSeat();
    credentialstore::removeLicenseKey();
    clearCache();
    m_licenseKey.clear();
    m_licenseToken.clear();
    m_trial = false;
    m_expires = QDateTime();
    setFeaturesForPlan(QStringLiteral("free"));
    setPlan(QStringLiteral("free"), QStringLiteral("Free plan"));
    emit activationFinished(true, QStringLiteral("License removed"));
}

void LicenseManager::clearCache()
{
    // Remove the cached ENTITLEMENT, and only that. remove("license") took the
    // whole settings group with it — including license/deviceSeed, the fallback
    // machine identity used where there is no MAC and no machineUniqueId
    // (containers, some BSDs). Regenerating that seed changes
    // deviceFingerprint(), so every cache clear — and one happens on any
    // rejection, revocation or deactivation — silently burned another seat.
    QSettings settings;
    settings.remove(QLatin1String(kCachedToken));
    settings.remove(QLatin1String(kCachedTrial));
}

void LicenseManager::setPlan(const QString &plan, const QString &status)
{
    const bool planChanged = m_plan != plan;
    m_plan = plan;
    m_status = status;
    if (planChanged)
        emit entitlementChanged(m_plan);
    emit statusChanged(m_status);
}

} // namespace nexa