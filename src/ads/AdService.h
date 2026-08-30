#pragma once

#include <QObject>
#include <QString>
#include <QVector>

class QNetworkAccessManager;
class QNetworkReply;
class QTimer;

namespace nexa {

class LicenseManager;

// One promotion the server handed us. Deliberately small: the app renders a
// title, a line of body copy, an optional image and one link.
struct Ad {
    int     id = 0;
    QString title;
    QString body;
    QString imageUrl;      // https only; empty when the ad has no artwork
    QString targetUrl;     // https only; opened in the user's own browser
    QString ctaLabel;
    int     weight = 1;    // how often it comes up in the rotation
};

// Fetches the ads a FREE install should show and rotates through them.
//
// Ads are a Free-plan thing only. That is enforced twice on purpose: this
// class refuses to fetch or emit anything once the licence reports a paid
// plan, and the server independently refuses to return ads for a paid licence
// token. Either check alone would be enough for honest use; together, a bug in
// one cannot put an ad in front of somebody who paid not to see any.
class AdService : public QObject {
    Q_OBJECT
public:
    explicit AdService(LicenseManager *license, QObject *parent = nullptr);

    // Begin fetching (no-op on a paid plan). Safe to call more than once.
    void start();

    bool hasAd() const { return !m_ads.isEmpty(); }
    // The ad currently on show, or a default-constructed Ad when there is none.
    Ad current() const;
    // True when this install is entitled to no ads at all.
    bool adFree() const { return m_adFree; }

    // Tell the server the current ad was seen / followed. Both are
    // fire-and-forget: a failure never blocks the UI or retries.
    void reportImpression();
    void reportClick();

signals:
    // The ad on show changed — either a new rotation or a fresh fetch.
    // `has` is false when there is nothing to show and the banner must hide.
    void adChanged(bool has);

private:
    void fetch();
    void applyPlan(const QString &plan);
    void report(const QString &type, int adId);
    QUrl endpoint(const QString &path) const;

    LicenseManager        *m_license = nullptr;
    QNetworkAccessManager *m_network = nullptr;
    QNetworkReply         *m_reply = nullptr;
    QTimer                *m_refresh = nullptr;   // re-fetch the catalogue
    QTimer                *m_rotate = nullptr;    // move to the next ad
    QVector<Ad>            m_ads;
    int                    m_index = -1;
    bool                   m_adFree = false;
    bool                   m_started = false;
};

} // namespace nexa
