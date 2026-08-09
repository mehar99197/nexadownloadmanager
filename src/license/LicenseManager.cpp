#include "license/LicenseManager.h"
#include "license/CredentialStore.h"

#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDateTime>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRegularExpression>
#include <QSettings>
#include <QSysInfo>
#include <QUrl>
#include <QUuid>

namespace nexa {

namespace {
constexpr auto kDeviceSeed = "license/deviceSeed";
}

LicenseManager::LicenseManager(QObject *parent)
    : QObject(parent), m_network(new QNetworkAccessManager(this))
{
}

QString LicenseManager::deviceFingerprint()
{
    QByteArray identity = QSysInfo::machineUniqueId();
    if (identity.isEmpty()) {
        QSettings settings;
        identity = settings.value(QLatin1String(kDeviceSeed)).toByteArray();
        if (identity.isEmpty()) {
            identity = QUuid::createUuid().toByteArray(QUuid::WithoutBraces);
            settings.setValue(QLatin1String(kDeviceSeed), identity);
        }
    }
    return QString::fromLatin1(QCryptographicHash::hash(
        QByteArrayLiteral("NexaDownloadManager/license/v1/") + identity,
        QCryptographicHash::Sha256).toHex());
}

void LicenseManager::start()
{
    const QString key = credentialstore::readLicenseKey();
    if (key.isEmpty()) {
        setPlan(QStringLiteral("free"), QStringLiteral("Free plan — enter a license key in Settings"));
        return;
    }
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
        m_reply->abort();
        m_reply->deleteLater();
        m_reply = nullptr;
    }

    const QUrl endpoint(qEnvironmentVariable(
        "NEXA_LICENSE_API_URL",
        QStringLiteral("https://nexadownloadmanager.com/api/license/validate")));
    const bool insecureDevelopment = qEnvironmentVariableIntValue("NEXA_ALLOW_INSECURE_LICENSE_API") == 1 &&
        (endpoint.host() == QLatin1String("localhost") || endpoint.host() == QLatin1String("127.0.0.1"));
    if (!endpoint.isValid() || (endpoint.scheme() != QLatin1String("https") && !insecureDevelopment)) {
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
    }).toJson(QJsonDocument::Compact);

    setPlan(QStringLiteral("free"), QStringLiteral("Validating license…"));
    m_reply = m_network->post(request, body);
    connect(m_reply, &QNetworkReply::finished, this,
            [this, licenseKey, userInitiated]() {
        QNetworkReply *reply = m_reply;
        m_reply = nullptr;
        if (!reply)
            return;
        const QNetworkReply::NetworkError networkError = reply->error();
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const QByteArray response = reply->read(64 * 1024);
        reply->deleteLater();

        if (networkError != QNetworkReply::NoError || status != 200) {
            const QString message = QStringLiteral("License server unavailable; Free plan active");
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
            credentialstore::removeLicenseKey();
            clearCache();
            const QString reason = object.value(QStringLiteral("reason")).toString(QStringLiteral("invalid"));
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
        const QString message = stored
            ? QStringLiteral("%1 license active").arg(plan.toUpper())
            : QStringLiteral("%1 active for this session; OS credential store unavailable").arg(plan.toUpper());
        setPlan(plan, message);
        if (userInitiated)
            emit activationFinished(true, message);
    });
}

void LicenseManager::deactivate()
{
    if (m_reply) {
        m_reply->abort();
        m_reply->deleteLater();
        m_reply = nullptr;
    }
    credentialstore::removeLicenseKey();
    clearCache();
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