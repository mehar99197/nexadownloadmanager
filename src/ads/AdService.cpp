#include "ads/AdService.h"

#include "license/LicenseManager.h"

#include <QCoreApplication>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRandomGenerator>
#include <QTimer>
#include <QUrl>
#include <QUrlQuery>

namespace nexa {

namespace {

// The one surface the desktop app renders today. The server knows others; the
// app only asks for what it can actually show.
constexpr auto kPlacement = "app_banner";

// Re-ask the server this often, so an ad an admin pauses stops showing without
// the user restarting Nexa.
constexpr int kRefreshMs = 30 * 60 * 1000;
// How long one ad stays on screen before the next comes up.
constexpr int kRotateMs = 45 * 1000;
// A hostile or broken server must not be able to grow the UI without bound.
constexpr int kMaxAds = 10;
constexpr int kMaxResponseBytes = 64 * 1024;

// Ads are opened in the user's browser and images are fetched over the network,
// so both links are re-checked here even though the server already validates
// them. A compromised or misconfigured endpoint still cannot hand the app an
// http:// or file:// URL to follow.
bool isHttpsUrl(const QString &value)
{
    const QUrl url(value);
    return url.isValid() && url.scheme() == QLatin1String("https") && !url.host().isEmpty();
}

} // namespace

AdService::AdService(LicenseManager *license, QObject *parent)
    : QObject(parent)
    , m_license(license)
    , m_network(new QNetworkAccessManager(this))
    , m_refresh(new QTimer(this))
    , m_rotate(new QTimer(this))
{
    m_refresh->setInterval(kRefreshMs);
    connect(m_refresh, &QTimer::timeout, this, &AdService::fetch);

    m_rotate->setInterval(kRotateMs);
    connect(m_rotate, &QTimer::timeout, this, [this]() {
        if (m_ads.size() < 2)
            return;
        // Weighted pick, never the ad already on screen — a two-ad rotation
        // should alternate rather than sometimes repeat itself.
        int total = 0;
        for (int i = 0; i < m_ads.size(); ++i)
            if (i != m_index)
                total += qMax(1, m_ads[i].weight);
        if (total <= 0)
            return;
        int roll = int(QRandomGenerator::global()->bounded(total));
        for (int i = 0; i < m_ads.size(); ++i) {
            if (i == m_index)
                continue;
            roll -= qMax(1, m_ads[i].weight);
            if (roll < 0) { m_index = i; break; }
        }
        emit adChanged(true);
    });

    if (m_license) {
        connect(m_license, &LicenseManager::entitlementChanged,
                this, &AdService::applyPlan);
    }
}

Ad AdService::current() const
{
    if (m_index < 0 || m_index >= m_ads.size())
        return Ad{};
    return m_ads.at(m_index);
}

void AdService::start()
{
    if (m_started)
        return;
    m_started = true;
    applyPlan(m_license ? m_license->plan() : QStringLiteral("free"));
}

// The single gate: a paid plan means no fetching, no ads held in memory, and a
// banner told to disappear. Dropping back to Free starts the cycle again.
void AdService::applyPlan(const QString &plan)
{
    const bool paid = plan == QLatin1String("pro") || plan == QLatin1String("team");
    if (paid) {
        m_adFree = true;
        m_refresh->stop();
        m_rotate->stop();
        if (m_reply) {
            m_reply->disconnect(this);
            m_reply->abort();
            m_reply->deleteLater();
            m_reply = nullptr;
        }
        const bool had = !m_ads.isEmpty();
        m_ads.clear();
        m_index = -1;
        if (had)
            emit adChanged(false);
        return;
    }

    m_adFree = false;
    if (!m_started)
        return;
    if (!m_refresh->isActive())
        m_refresh->start();
    fetch();
}

QUrl AdService::endpoint(const QString &path) const
{
    // The environment override exists for developers pointing a build at
    // localhost and is compiled in only with -DNEXA_DEV_OVERRIDES=ON. A shipped
    // binary never consults it: the banner renders whatever this endpoint
    // returns, so redirecting it is a way to put arbitrary content in the app.
    static const QString kProduction = QStringLiteral("https://nexadownloadmanager.com/api/ads");
#if NEXA_DEV_OVERRIDES
    const QString base = qEnvironmentVariable("NEXA_ADS_API_URL", kProduction);
    QUrl url(base + path);
    const bool insecureDevelopment = qEnvironmentVariableIntValue("NEXA_ALLOW_INSECURE_LICENSE_API") == 1 &&
        (url.host() == QLatin1String("localhost") || url.host() == QLatin1String("127.0.0.1"));
#else
    QUrl url(kProduction + path);
    const bool insecureDevelopment = false;
#endif
    if (!url.isValid() || (url.scheme() != QLatin1String("https") && !insecureDevelopment))
        return QUrl();
    return url;
}

void AdService::fetch()
{
    if (m_adFree || m_reply)
        return;
    QUrl url = endpoint(QString());
    if (!url.isValid())
        return;
    QUrlQuery query;
    query.addQueryItem(QStringLiteral("placement"), QLatin1String(kPlacement));
    url.setQuery(query);

    QNetworkRequest request(url);
    request.setHeader(QNetworkRequest::UserAgentHeader,
                      QStringLiteral("Nexa/%1").arg(QCoreApplication::applicationVersion()));
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                         QNetworkRequest::NoLessSafeRedirectPolicy);
    request.setTransferTimeout(15000);
    // Proves the plan to the server. Free installs simply have no token.
    const QString token = m_license ? m_license->licenseToken() : QString();
    if (!token.isEmpty())
        request.setRawHeader("Authorization", QByteArray("Bearer ") + token.toUtf8());

    m_reply = m_network->get(request);
    connect(m_reply, &QNetworkReply::finished, this, [this]() {
        QNetworkReply *reply = m_reply;
        m_reply = nullptr;
        if (!reply)
            return;
        const bool failed = reply->error() != QNetworkReply::NoError
            || reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt() != 200;
        const QByteArray body = reply->readAll();
        reply->deleteLater();
        // A failed fetch keeps whatever is already on screen: an outage should
        // not blank the banner, and it must never promote anyone to ad-free.
        if (failed || body.size() > kMaxResponseBytes)
            return;

        const QJsonObject root = QJsonDocument::fromJson(body).object();
        if (!root.value(QStringLiteral("ok")).toBool())
            return;
        const QJsonObject data = root.value(QStringLiteral("data")).toObject();
        if (data.value(QStringLiteral("adFree")).toBool()) {
            applyPlan(QStringLiteral("pro"));      // the server says this licence is paid
            return;
        }

        QVector<Ad> parsed;
        const QJsonArray items = data.value(QStringLiteral("ads")).toArray();
        for (const QJsonValue &value : items) {
            if (parsed.size() >= kMaxAds)
                break;
            const QJsonObject object = value.toObject();
            Ad ad;
            ad.id        = object.value(QStringLiteral("id")).toInt();
            ad.title     = object.value(QStringLiteral("title")).toString().trimmed();
            ad.body      = object.value(QStringLiteral("body")).toString().trimmed();
            ad.imageUrl  = object.value(QStringLiteral("imageUrl")).toString().trimmed();
            ad.targetUrl = object.value(QStringLiteral("targetUrl")).toString().trimmed();
            ad.ctaLabel  = object.value(QStringLiteral("ctaLabel")).toString().trimmed();
            ad.weight    = qBound(1, object.value(QStringLiteral("weight")).toInt(1), 100);
            if (ad.id <= 0 || ad.title.isEmpty() || !isHttpsUrl(ad.targetUrl))
                continue;
            if (!ad.imageUrl.isEmpty() && !isHttpsUrl(ad.imageUrl))
                ad.imageUrl.clear();
            if (ad.ctaLabel.isEmpty())
                ad.ctaLabel = tr("Learn more");
            parsed.append(ad);
        }

        // Keep showing the same ad across a refresh when it is still in the
        // list, so a routine poll doesn't visibly reshuffle the banner.
        const int previousId = current().id;
        m_ads = parsed;
        m_index = m_ads.isEmpty() ? -1 : 0;
        for (int i = 0; i < m_ads.size(); ++i)
            if (m_ads[i].id == previousId) { m_index = i; break; }

        if (m_ads.size() > 1) m_rotate->start();
        else                  m_rotate->stop();
        emit adChanged(!m_ads.isEmpty());
    });
}

void AdService::reportImpression() { report(QStringLiteral("impression"), current().id); }
void AdService::reportClick()      { report(QStringLiteral("click"), current().id); }

void AdService::report(const QString &type, int adId)
{
    if (m_adFree || adId <= 0)
        return;
    const QUrl url = endpoint(QStringLiteral("/%1/event").arg(adId));
    if (!url.isValid())
        return;
    QNetworkRequest request(url);
    request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    request.setHeader(QNetworkRequest::UserAgentHeader,
                      QStringLiteral("Nexa/%1").arg(QCoreApplication::applicationVersion()));
    request.setTransferTimeout(10000);
    const QString token = m_license ? m_license->licenseToken() : QString();
    if (!token.isEmpty())
        request.setRawHeader("Authorization", QByteArray("Bearer ") + token.toUtf8());

    const QByteArray payload = QJsonDocument(QJsonObject{
        {QStringLiteral("type"), type},
    }).toJson(QJsonDocument::Compact);
    QNetworkReply *reply = m_network->post(request, payload);
    // Fire and forget: counting is the server's problem, not the user's.
    connect(reply, &QNetworkReply::finished, reply, &QNetworkReply::deleteLater);
}

} // namespace nexa
