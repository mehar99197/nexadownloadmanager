#include "license/LicenseManager.h"
#include "license/CredentialStore.h"
#include "license/LicenseToken.h"

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
QUrl licenseEndpoint(const QString &action)
{
#ifdef NEXA_DEV_BUILD
    const QUrl base(qEnvironmentVariable(QStringLiteral("NEXA_LICENSE_API_URL"),
                                         QLatin1String(kProductionLicenseApi)));
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
    const QString key = credentialstore::readLicenseKey();
    if (key.isEmpty()) {
        setPlan(QStringLiteral("free"), QStringLiteral("Free plan — enter a license key in Settings"));
        return;
    }
    m_licenseKey = key;
    validate(key, false);
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
        if (claims.expiresAt <= QDateTime::currentDateTimeUtc()) {
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
    QSettings settings;
    settings.remove(QStringLiteral("license"));
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