#include "ui/AdBanner.h"

#include "ads/AdService.h"
#include "ui/Theme.h"

#include <QDesktopServices>
#include <QHBoxLayout>
#include <QLabel>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QPainter>
#include <QPainterPath>
#include <QPixmap>
#include <QPushButton>
#include <QUrl>
#include <QVBoxLayout>

namespace nexa {

namespace {
constexpr int kThumb = 36;
// An ad image is a 36px thumbnail; anything larger is a mistake or an attack.
constexpr int kMaxImageBytes = 512 * 1024;
constexpr auto kPricingUrl = "https://nexadownloadmanager.com/pricing";
} // namespace

AdBanner::AdBanner(AdService *ads, QWidget *parent)
    : QWidget(parent)
    , m_ads(ads)
    , m_network(new QNetworkAccessManager(this))
{
    setObjectName(QStringLiteral("AdBar"));
    setVisible(false);                 // nothing to show until an ad arrives

    auto *row = new QHBoxLayout(this);
    row->setContentsMargins(16, 8, 16, 8);
    row->setSpacing(12);

    m_thumb = new QLabel(this);
    m_thumb->setObjectName(QStringLiteral("AdThumb"));
    m_thumb->setFixedSize(kThumb, kThumb);
    m_thumb->setAlignment(Qt::AlignCenter);
    m_thumb->setVisible(false);
    row->addWidget(m_thumb);

    auto *text = new QVBoxLayout;
    text->setContentsMargins(0, 0, 0, 0);
    text->setSpacing(1);
    auto *kicker = new QLabel(tr("SPONSORED"), this);
    kicker->setObjectName(QStringLiteral("AdKicker"));
    // Ad copy arrives from the server. PlainText so a promo can only ever be
    // words, never markup drawn into the app's own chrome.
    m_title = new QLabel(this);
    m_title->setObjectName(QStringLiteral("AdTitle"));
    m_title->setTextFormat(Qt::PlainText);
    m_body = new QLabel(this);
    m_body->setObjectName(QStringLiteral("AdBody"));
    // Ad copy comes off the network. QLabel defaults to Qt::AutoText, so its
    // mightBeRichText() heuristic would render anything containing markup as
    // HTML — letting whoever controls the ad feed restyle the banner, or forge
    // UI inside it. These are captions; say so.
    m_title->setTextFormat(Qt::PlainText);
    m_body->setTextFormat(Qt::PlainText);
    text->addWidget(kicker);
    text->addWidget(m_title);
    text->addWidget(m_body);
    row->addLayout(text, 1);

    m_cta = new QPushButton(this);
    m_cta->setObjectName(QStringLiteral("AdCta"));
    m_cta->setCursor(Qt::PointingHandCursor);
    row->addWidget(m_cta);

    // The honest way out of the ads: the plan that removes them.
    m_remove = new QPushButton(tr("Remove ads"), this);
    m_remove->setObjectName(QStringLiteral("AdRemove"));
    m_remove->setCursor(Qt::PointingHandCursor);
    m_remove->setToolTip(tr("Nexa Pro and Team are ad-free."));
    row->addWidget(m_remove);

    connect(m_cta, &QPushButton::clicked, this, &AdBanner::openTarget);
    connect(m_remove, &QPushButton::clicked, this, []() {
        QDesktopServices::openUrl(QUrl(QLatin1String(kPricingUrl)));
    });
    if (m_ads)
        connect(m_ads, &AdService::adChanged, this, &AdBanner::showAd);
}

void AdBanner::showAd(bool has)
{
    if (!has || !m_ads) {
        setVisible(false);
        m_shownAdId = 0;
        return;
    }
    const Ad ad = m_ads->current();
    if (ad.id <= 0) {
        setVisible(false);
        return;
    }

    m_title->setText(ad.title);
    m_body->setText(ad.body);
    m_body->setVisible(!ad.body.isEmpty());
    m_cta->setText(ad.ctaLabel);

    if (ad.imageUrl.isEmpty()) {
        m_thumb->setVisible(false);
        m_thumb->clear();
    } else {
        loadThumbnail(ad.imageUrl);
    }

    setVisible(true);
    // Count one impression per ad shown, not per repaint or re-layout.
    if (m_shownAdId != ad.id) {
        m_shownAdId = ad.id;
        m_ads->reportImpression();
    }
}

void AdBanner::loadThumbnail(const QString &url)
{
    if (m_imageReply) {
        m_imageReply->disconnect(this);
        m_imageReply->abort();
        m_imageReply->deleteLater();
        m_imageReply = nullptr;
    }
    QNetworkRequest request((QUrl(url)));
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                         QNetworkRequest::NoLessSafeRedirectPolicy);
    request.setTransferTimeout(10000);
    m_imageReply = m_network->get(request);
    connect(m_imageReply, &QNetworkReply::finished, this, [this]() {
        QNetworkReply *reply = m_imageReply;
        m_imageReply = nullptr;
        if (!reply)
            return;
        const QByteArray data = reply->error() == QNetworkReply::NoError ? reply->readAll() : QByteArray();
        reply->deleteLater();
        QPixmap raw;
        if (data.isEmpty() || data.size() > kMaxImageBytes || !raw.loadFromData(data)) {
            m_thumb->setVisible(false);      // no artwork is fine; the ad still reads
            return;
        }
        // Rounded thumbnail, drawn rather than styled so it works on any theme.
        const QPixmap scaled = raw.scaled(kThumb, kThumb, Qt::KeepAspectRatioByExpanding,
                                          Qt::SmoothTransformation);
        QPixmap rounded(scaled.size());
        rounded.fill(Qt::transparent);
        QPainter painter(&rounded);
        painter.setRenderHint(QPainter::Antialiasing, true);
        QPainterPath clip;
        clip.addRoundedRect(QRectF(0, 0, scaled.width(), scaled.height()), 8, 8);
        painter.setClipPath(clip);
        painter.drawPixmap(0, 0, scaled);
        painter.end();
        m_thumb->setPixmap(rounded);
        m_thumb->setVisible(true);
    });
}

void AdBanner::openTarget()
{
    if (!m_ads)
        return;
    const Ad ad = m_ads->current();
    if (ad.targetUrl.isEmpty())
        return;
    m_ads->reportClick();
    QDesktopServices::openUrl(QUrl(ad.targetUrl));
}

} // namespace nexa
