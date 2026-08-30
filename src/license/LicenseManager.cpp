#include "license/LicenseManager.h"
#include "license/CredentialStore.h"

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
constexpr auto kCachedPlan     = "license/cachedPlan";
constexpr auto kCachedExpires  = "license/cachedExpires";
constexpr auto kCachedAt       = "license/cachedAt";
constexpr auto kCachedTrial    = "license/cachedTrial";
constexpr int  kRevalidateMs   = 6 * 60 * 60 * 1000;   // 6 hours
// The server holds a seat for 15 minutes past the last heartbeat, so beating
// every 5 leaves room for two dropped requests before a seat is lost.
constexpr int  kHeartbeatMs    = 5 * 60 * 1000;

QString planLabel(const QString &plan) { return plan.toUpper(); }

// The licence endpoints are siblings: .../license/validate, /heartbeat, /release.
// Deriving them from the one configured URL keeps a dev override pointing the
// whole family at localhost instead of only the validate call.
QUrl licenseEndpoint(const QString &action)
{
    const QUrl base(qEnvironmentVariable(
        "NEXA_LICENSE_API_URL",
        QStringLiteral("https://nexadownloadmanager.com/api/license/validate")));
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

// An endpoint is usable if it is HTTPS, or plainly a developer's loopback and
// explicitly opted in. Same rule the validate path has always applied.
bool endpointAllowed(const QUrl &endpoint)
{
    const bool insecureDevelopment =
        qEnvironmentVariableIntValue("NEXA_ALLOW_INSECURE_LICENSE_API") == 1 &&
        (endpoint.host() == QLatin1String("localhost") || endpoint.host() == QLatin1String("127.0.0.1"));
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

        const QString plan = object.value(QStringLiteral("plan")).toString();
        const QString token = object.value(QStringLiteral("token")).toString();
        if ((plan != QLatin1String("free") && plan != QLatin1String("pro") &&
             plan != QLatin1String("team")) || token.isEmpty()) {
            const QString message = QStringLiteral("License response is missing entitlement data");
            setPlan(QStringLiteral("free"), message);
            if (userInitiated)
                emit activationFinished(false, message);
            return;
        }

        const bool stored = credentialstore::writeLicenseKey(licenseKey);
        m_licenseKey = licenseKey;
        m_licenseToken = token;        // never persisted: it expires in 24h anyway
        m_trial = object.value(QStringLiteral("trial")).toBool(false);
        m_expires = QDateTime::fromString(object.value(QStringLiteral("expires")).toString(), Qt::ISODate);
        applyFeatures(object, plan);
        cacheEntitlement(plan, m_expires, m_trial);
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

void LicenseManager::applyFeatures(const QJsonObject &object, const QString &plan)
{
    // Start from the plan's defaults so a server that omits a key (or an older
    // server that sends no `features` at all) still yields a coherent set.
    setFeaturesForPlan(plan);
    const QJsonValue raw = object.value(QStringLiteral("features"));
    if (!raw.isObject()) {
        m_activeSeats = object.value(QStringLiteral("activeSeats")).toInt(m_activeSeats);
        return;
    }
    const QJsonObject f = raw.toObject();
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
    m_activeSeats = object.value(QStringLiteral("activeSeats")).toInt(m_activeSeats);
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
        // Lost the seat (another machine took it while we were offline) or the
        // licence stopped being valid. Drop to Free and say which.
        const QString reason = object.value(QStringLiteral("reason")).toString();
        if (reason == QLatin1String("seat_limit")) {
            const int seats = object.value(QStringLiteral("seats")).toInt(m_features.seats);
            setFeaturesForPlan(QStringLiteral("free"));
            setPlan(QStringLiteral("free"),
                    tr("All %n seat(s) on this license are in use on other devices", nullptr, seats));
            emit seatLimitReached(seats);
        }
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

void LicenseManager::cacheEntitlement(const QString &plan, const QDateTime &expires, bool trial)
{
    QSettings settings;
    settings.setValue(QLatin1String(kCachedPlan), plan);
    settings.setValue(QLatin1String(kCachedExpires),
                      expires.isValid() ? expires.toUTC().toString(Qt::ISODate) : QString());
    settings.setValue(QLatin1String(kCachedAt), QDateTime::currentDateTimeUtc().toString(Qt::ISODate));
    settings.setValue(QLatin1String(kCachedTrial), trial);
}

void LicenseManager::applyCachedEntitlement(const QString &offlineReason, bool userInitiated)
{
    QSettings settings;
    const QString plan = settings.value(QLatin1String(kCachedPlan)).toString();
    const QDateTime cachedAt = QDateTime::fromString(
        settings.value(QLatin1String(kCachedAt)).toString(), Qt::ISODate);
    const QString expiresRaw = settings.value(QLatin1String(kCachedExpires)).toString();
    const QDateTime expires = expiresRaw.isEmpty() ? QDateTime()
                                                   : QDateTime::fromString(expiresRaw, Qt::ISODate);
    const bool trial = settings.value(QLatin1String(kCachedTrial), false).toBool();

    const QDateTime now = QDateTime::currentDateTimeUtc();
    const bool paid = plan == QLatin1String("pro") || plan == QLatin1String("team");
    // Reject a cache from the future (clock rolled back) as well as a stale one.
    const bool fresh = cachedAt.isValid() && cachedAt <= now.addSecs(300)
                       && cachedAt.daysTo(now) <= kOfflineGraceDays;
    const bool unexpired = !expires.isValid() || expires > now;

    if (paid && fresh && unexpired) {
        m_trial = trial;
        m_expires = expires;
        // Offline grace restores the plan's entitlements too, otherwise a paid
        // user would keep their badge but silently lose themes and Udemy.
        setFeaturesForPlan(plan);
        const qint64 days = cachedAt.daysTo(now);
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