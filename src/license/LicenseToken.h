#pragma once

#include <QByteArray>
#include <QDateTime>
#include <QJsonObject>
#include <QString>

namespace nexa::licensetoken {

/**
 * The claims carried by a licence token the server signed.
 *
 * Every field here is covered by the signature, so unlike the sibling JSON in
 * a /license/validate response, none of it can be rewritten by a fake server,
 * a proxy, or a hand-edited settings file.
 */
struct Claims {
    QString     licenseKey;   // "sub" — the key this token was issued for
    QString     plan;         // "free" | "pro" | "team"
    QString     device;       // the device fingerprint it was issued to
    QDateTime   issuedAt;     // "iat", UTC — server-attested, unforgeable
    QDateTime   expiresAt;    // "exp", UTC
    QJsonObject features;     // the entitlements object
};

/**
 * Verify an Ed25519 ("EdDSA") JWT against the public key compiled into this
 * build, and return its claims.
 *
 * Returns false on ANY failure — malformed input, an algorithm other than
 * EdDSA, a signature that does not verify, a missing `exp`, or a token that is
 * not of type "license". `out` is only written on success.
 *
 * Expiry is deliberately NOT checked here: offline grace needs to accept a
 * token that has expired but is still within the grace window, and that policy
 * belongs to LicenseManager. Callers must check `expiresAt` themselves.
 *
 * `error` receives a short reason when non-null — for logging, never for the
 * user, because the precise reason is useful to someone probing the check.
 */
bool verify(const QString &token, Claims *out, QString *error = nullptr);

/**
 * Whether a verified token may keep a paid plan alive while the licence server
 * is unreachable.
 *
 * Pulled out of LicenseManager so the rule is stated once and can be tested
 * without a network, a settings file, or a running app — this is the decision
 * that used to be "is the string in the settings file 'pro'?", so it is worth
 * being able to prove.
 *
 * True only when all of:
 *   - the plan is a paid one,
 *   - the token was issued to *this* device,
 *   - `iat` is present, not in the future (beyond a little clock slack),
 *   - and `iat` is within `graceDays` of `now`.
 *
 * Note `exp` is deliberately not consulted: tokens live 24h but grace is a
 * week, so an expired-but-recent token is exactly the case this allows.
 */
bool offlineGraceAllows(const Claims &claims, const QString &deviceFingerprint,
                        const QDateTime &now, int graceDays);

/**
 * Verify a detached Ed25519 signature over `message` with the same
 * build-embedded public key that licence tokens use.
 *
 * There is deliberately one vendor signing key, not one per feature: a second
 * key would be a second thing to protect and rotate for no extra safety. The
 * update feed uses this (see UpdateChecker) because it tells the app which
 * installer to run.
 *
 * `signature` is the raw 64 bytes, already base64url-decoded by the caller.
 */
bool verifyDetachedSignature(const QByteArray &message, const QByteArray &signature);

/**
 * The 32-byte Ed25519 public key this build trusts, hex encoded.
 * Exposed so the test can assert the build is not carrying the development key.
 */
QByteArray publicKeyHex();

/** True when this build trusts the publicly-known development key. */
bool usingDevelopmentKey();

} // namespace nexa::licensetoken
