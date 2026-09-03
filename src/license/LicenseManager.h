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
    //
    // This is the cached copy, kept because the UI reads it constantly (every
    // theme card asks about itself). It is re-derived from the signed token
    // every kEntitlementRecheckMs, so overwriting it in memory buys at most
    // that long. Anything deciding something expensive should ask
    // verifiedFeatures() instead.
    const Entitlements &features() const { return m_features; }

    // Entitlements derived from the signed token *right now*, ignoring the
    // cached struct entirely.
    //
    // The point is that this and features() fail differently: features() is a
    // plain struct that a patched binary can overwrite, while this re-runs
    // Ed25519 verification against the compiled-in public key. Gates on the
    // expensive paths use this, so unlocking them means defeating a signature
    // rather than flipping a bool — and the two paths have to be defeated
    // separately, in different translation units.
    Entitlements verifiedFeatures() const;
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
    // Remember the server's signed token so a network outage doesn't drop a
    // paying user to Free; applyCachedEntitlement() replays it within the grace
    // window. The token is stored rather than a plain "pro" string precisely
    // because the settings file is user-writable: editing this cache now means
    // forging an Ed25519 signature.
    void cacheEntitlement(const QString &token, bool trial);
    void applyCachedEntitlement(const QString &offlineReason, bool userInitiated);
    // Read the signed `features` object out of a licence token, falling back to
    // the plan's known defaults for any key it does not carry (older server,
    // newer client). Takes the features object itself, not the response body —
    // entitlements must never be read from unsigned JSON.
    void applyFeatures(const QJsonObject &features, const QString &plan);
    void setFeaturesForPlan(const QString &plan);
    void sendHeartbeat();
    // Replace the held token with a fresher one from a heartbeat, after
    // verifying it exactly as strictly as one from /validate.
    void adoptRefreshedToken(const QString &token);
    // Derive plan + entitlements from the signed token — the live one, or the
    // cached one if it is still inside the offline grace window. False means
    // there is nothing valid to derive from, i.e. Free.
    bool deriveFromToken(QString *plan, Entitlements *features) const;

    // Redundant, deliberately differently-shaped re-verifications, used by the
    // guard behind verifiedFeatures(). Each re-derives ground truth from the
    // signed token on its own, so they cannot be defeated by one patch — see
    // src/license/Guard.h. Kept small and side-effect free.
    static bool isPaidPlan(const QString &plan);
    // A valid, device-bound, UNEXPIRED paid token is held right now.
    bool liveTokenGrantsPaid() const;
    // The cached token still grants a paid plan inside the offline-grace window.
    bool cachedTokenGrantsPaidInGrace() const;
    // A validly-signed, device-bound paid token EXISTS — ignoring expiry and the
    // grace window. True for a real customer whose grace has merely lapsed;
    // false for an in-memory "paid" state no signature backs. This is the line
    // between a slow network and a patched binary, so the tamper canary keys on
    // it and never on the grace window (which a legitimate user crosses).
    bool hasSignedPaidGrant() const;
    // Periodic re-derivation, so a one-shot overwrite of m_features does not
    // last. Applies quietly: no signals unless something actually changed.
    void recheckEntitlements();

    QNetworkAccessManager *m_network = nullptr;
    QNetworkReply *m_reply = nullptr;
    QString m_plan = QStringLiteral("free");
    QString m_status = QStringLiteral("Free plan");
    QString m_licenseKey;             // key in use this session (for periodic re-validation)
    QString m_licenseToken;           // server-signed entitlement (24h), for plan-gated APIs
    bool m_trial = false;
    QDateTime m_expires;
    QTimer *m_revalidate = nullptr;   // re-checks every few hours so a trial ends on time
    QTimer *m_recheck = nullptr;      // re-derives entitlements from the token
    QTimer *m_heartbeat = nullptr;    // keeps this machine's seat lease alive
    QNetworkReply *m_heartbeatReply = nullptr;
    Entitlements m_features;          // Free by default — see the struct comment
    int m_activeSeats = 0;

    // Tamper canary. Set once the guard sees the in-memory plan claim paid while
    // no signature backs it — the signature of a patched binary, never of a
    // legitimate user (whose paid state is always backed by a token, online or
    // in grace, and whose lapsed grace is downgraded cleanly before this could
    // fire). Once set it is sticky for the session and folds every entitlement
    // read to Free, so patching one gate does not hold: a distant, differently
    // shaped check trips this and the whole install quietly drops to Free. It
    // never bricks anything and never touches stored data — degrade only.
    // `mutable` because verifiedFeatures() is const but is the natural place to
    // observe tampering.
    mutable bool m_tamperObserved = false;
};

} // namespace nexa