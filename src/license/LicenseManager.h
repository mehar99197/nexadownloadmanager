#pragma once

#include <QObject>
#include <QString>
#include <QStringList>
#include <QDateTime>

class QNetworkAccessManager;
class QNetworkReply;
class QTimer;
class QJsonObject;

namespace nexa {

/**
 * What this installation is allowed to do, as told by the licence server.
 *
 * The server is authoritative — it sends the same values inside the signed
 * licence token — but the app keeps its own copy so every gate is a cheap local
 * check instead of a round trip. Defaults are the FREE entitlements on purpose:
 * if a response is missing, malformed, or the app is offline before its first
 * successful validation, the user gets the restricted set, never the generous one.
 */
struct Entitlements {
    int         maxConcurrentDownloads = 3;      // 0 = unlimited
    QString     themes                 = QStringLiteral("basic");  // "basic" | "all"
    QStringList freeThemes             = {QStringLiteral("system"),
                                          QStringLiteral("dark"),
                                          QStringLiteral("light")};
    bool        authSiteDownloads      = false;  // Udemy, Coursera, LinkedIn Learning…
    bool        aiRename               = false;
    bool        adFree                 = false;
    int         seats                  = 1;

    bool allowsTheme(const QString &id) const {
        return themes == QLatin1String("all") || freeThemes.contains(id, Qt::CaseInsensitive);
    }
};

class LicenseManager : public QObject {
    Q_OBJECT
public:
    explicit LicenseManager(QObject *parent = nullptr);

    void start();
    void activate(const QString &licenseKey);
    void deactivate();

    QString plan() const { return m_plan; }
    QString status() const { return m_status; }
    bool isPaid() const { return m_plan == QLatin1String("pro") || m_plan == QLatin1String("team"); }
    // True while the entitlement comes from the 7-day Pro trial (plan reads "pro").
    bool isTrial() const { return m_trial; }
    // When the current entitlement ends (invalid = no known expiry).
    QDateTime expiresAt() const { return m_expires; }
    // The short-lived signed entitlement from the last successful validation.
    // Sent as a bearer token so the server can decide plan-gated answers (e.g.
    // "no ads for a paid install") instead of trusting the client's word.
    // Empty when running on Free, offline-cached, or before the first check.
    QString licenseToken() const { return m_licenseToken; }
    // Days a paid plan keeps working without reaching the license server.
    static constexpr int kOfflineGraceDays = 7;

    // What this install may do. Always populated — Free defaults until the
    // server says otherwise, so callers never have to null-check.
    const Entitlements &features() const { return m_features; }
    bool allowsTheme(const QString &id) const { return m_features.allowsTheme(id); }
    bool allowsAuthSites() const { return m_features.authSiteDownloads; }

    // Seats are concurrent: this many machines may run the app at once.
    int seats() const { return m_features.seats; }
    int activeSeats() const { return m_activeSeats; }

    // Hand this machine's seat back. Call on shutdown; safe if not licensed.
    // Blocking is deliberate but bounded — see the implementation.
    void releaseSeat();

    static QString deviceFingerprint();
    // Short human label for this machine, shown in the account's device list.
    static QString deviceName();

signals:
    void entitlementChanged(const QString &plan);
    void statusChanged(const QString &status);
    void activationFinished(bool valid, const QString &message);
    // Every seat on the licence is in use by other machines right now. Distinct
    // from a rejected licence: nothing is wrong with the key, the user just has
    // to close the app elsewhere (or buy more seats).
    void seatLimitReached(int seats);
    // The seat was taken away deliberately (admin "Free seats", or the user
    // signing this device out from the dashboard) rather than lost to another
    // machine — a different thing to tell the user, so a different signal.
    void seatRevoked();
    // Entitlements changed — gates that cache them should re-read.
    void featuresChanged(const Entitlements &features);

private:
    void validate(const QString &licenseKey, bool userInitiated);
    void setPlan(const QString &plan, const QString &status);
    void clearCache();
    // Remember a server-confirmed entitlement so a network outage doesn't drop a
    // paying user to Free; applyCachedEntitlement() replays it within the grace window.
    void cacheEntitlement(const QString &plan, const QDateTime &expires, bool trial);
    void applyCachedEntitlement(const QString &offlineReason, bool userInitiated);
    // Read the server's `features` object, falling back to the plan's known
    // defaults for any key it does not send (older server, newer client).
    void applyFeatures(const QJsonObject &object, const QString &plan);
    void setFeaturesForPlan(const QString &plan);
    void sendHeartbeat();

    QNetworkAccessManager *m_network = nullptr;
    QNetworkReply *m_reply = nullptr;
    QString m_plan = QStringLiteral("free");
    QString m_status = QStringLiteral("Free plan");
    QString m_licenseKey;             // key in use this session (for periodic re-validation)
    QString m_licenseToken;           // server-signed entitlement (24h), for plan-gated APIs
    bool m_trial = false;
    QDateTime m_expires;
    QTimer *m_revalidate = nullptr;   // re-checks every few hours so a trial ends on time
    QTimer *m_heartbeat = nullptr;    // keeps this machine's seat lease alive
    QNetworkReply *m_heartbeatReply = nullptr;
    Entitlements m_features;          // Free by default — see the struct comment
    int m_activeSeats = 0;
};

} // namespace nexa