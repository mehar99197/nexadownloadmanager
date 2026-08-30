#pragma once

#include <QWidget>

class QLabel;
class QNetworkAccessManager;
class QNetworkReply;
class QPushButton;

namespace nexa {

class AdService;

// The in-app promo strip shown to Free installs, between the toolbar and the
// download list. It is a thin view over AdService: it never decides who sees
// an ad, it only draws whatever AdService currently holds and hides itself the
// moment there is nothing (which includes every paid plan).
class AdBanner : public QWidget {
    Q_OBJECT
public:
    explicit AdBanner(AdService *ads, QWidget *parent = nullptr);

private:
    void showAd(bool has);
    void loadThumbnail(const QString &url);
    void openTarget();

    AdService   *m_ads = nullptr;
    QLabel      *m_thumb = nullptr;
    QLabel      *m_title = nullptr;
    QLabel      *m_body = nullptr;
    QPushButton *m_cta = nullptr;
    QPushButton *m_remove = nullptr;

    QNetworkAccessManager *m_network = nullptr;
    QNetworkReply         *m_imageReply = nullptr;
    int                    m_shownAdId = 0;   // impression counted for this id
};

} // namespace nexa
