#include "license/LicenseToken.h"

#include <QJsonDocument>
#include <QJsonValue>
#include <QTimeZone>

#include <openssl/evp.h>

namespace nexa::licensetoken {

namespace {

// The Ed25519 public key this build verifies licence tokens with.
//
// It is supplied at build time by CMake (-DNEXA_LICENSE_PUBLIC_KEY=<64 hex
// chars>, or packaging/license-public-key.txt). A release build without one
// fails to configure, because the fallback below is the key derived from the
// fixed development seed in ndm-website/backend/src/config/licenseKeys.js —
// that seed is in the repository, so anyone could mint themselves a Pro
// licence against it. It exists only so `-DNEXA_DEV_BUILD=ON` works offline.
#ifdef NEXA_LICENSE_PUBLIC_KEY
constexpr auto kPublicKeyHex = NEXA_LICENSE_PUBLIC_KEY;
constexpr bool kIsDevelopmentKey = false;
#else
constexpr auto kPublicKeyHex = "8e486e8fb79499dba2a789c6b1639d409495233c79e0eaf52e2ea1fc9dbbb73f";
constexpr bool kIsDevelopmentKey = true;
#endif

constexpr int kEd25519PublicKeyBytes = 32;
constexpr int kEd25519SignatureBytes = 64;
// A licence token is a few hundred bytes. Anything far past that is not one,
// and refusing early keeps a hostile response from being parsed at all.
constexpr int kMaxTokenChars = 8 * 1024;

bool fail(QString *error, const char *why)
{
    if (error)
        *error = QString::fromLatin1(why);
    return false;
}

// Decode one base64url JWT segment. JWT omits padding, which Qt's decoder
// wants, so it is restored before decoding. Decoding is strict: anything that
// is not valid base64url is a rejected token, not a best-effort parse.
bool decodeSegment(const QByteArray &segment, QByteArray *out)
{
    QByteArray padded = segment;
    switch (padded.size() % 4) {
    case 2: padded += "=="; break;
    case 3: padded += "=";  break;
    case 1: return false;             // never a valid base64 length
    default: break;
    }
    const auto decoded = QByteArray::fromBase64Encoding(
        padded, QByteArray::Base64UrlEncoding | QByteArray::AbortOnBase64DecodingErrors);
    if (!decoded)
        return false;
    *out = *decoded;
    return true;
}

bool parseJsonObject(const QByteArray &bytes, QJsonObject *out)
{
    QJsonParseError parseError{};
    const QJsonDocument document = QJsonDocument::fromJson(bytes, &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject())
        return false;
    *out = document.object();
    return true;
}

// Ed25519 verification, one shot. No pre-hashing and no DER unpacking of the
// signature — the reason this scheme was chosen over ECDSA for a verifier that
// has to be correct in C++.
bool verifySignature(const QByteArray &signingInput, const QByteArray &signature)
{
    const QByteArray key = QByteArray::fromHex(QByteArray(kPublicKeyHex));
    if (key.size() != kEd25519PublicKeyBytes)
        return false;
    if (signature.size() != kEd25519SignatureBytes)
        return false;

    EVP_PKEY *pkey = EVP_PKEY_new_raw_public_key(
        EVP_PKEY_ED25519, nullptr,
        reinterpret_cast<const unsigned char *>(key.constData()),
        size_t(key.size()));
    if (!pkey)
        return false;

    EVP_MD_CTX *ctx = EVP_MD_CTX_new();
    if (!ctx) {
        EVP_PKEY_free(pkey);
        return false;
    }

    const bool ok = EVP_DigestVerifyInit(ctx, nullptr, nullptr, nullptr, pkey) == 1
        && EVP_DigestVerify(
               ctx,
               reinterpret_cast<const unsigned char *>(signature.constData()),
               size_t(signature.size()),
               reinterpret_cast<const unsigned char *>(signingInput.constData()),
               size_t(signingInput.size())) == 1;

    EVP_MD_CTX_free(ctx);
    EVP_PKEY_free(pkey);
    return ok;
}

QDateTime timeFromClaim(const QJsonValue &value)
{
    if (!value.isDouble())
        return QDateTime();
    return QDateTime::fromSecsSinceEpoch(qint64(value.toDouble()), QTimeZone::UTC);
}

} // namespace

bool verifyDetachedSignature(const QByteArray &message, const QByteArray &signature)
{
    return verifySignature(message, signature);
}

bool offlineGraceAllows(const Claims &claims, const QString &deviceFingerprint,
                        const QDateTime &now, int graceDays)
{
    if (claims.plan != QLatin1String("pro") && claims.plan != QLatin1String("team"))
        return false;
    // A token belongs to one machine. Without this the cache would be worth
    // copying between installs.
    if (claims.device.isEmpty() || claims.device != deviceFingerprint)
        return false;
    if (!claims.issuedAt.isValid())
        return false;
    // Issued in the future means a rolled-back clock or a doctored token.
    // Five minutes of slack covers ordinary clock skew.
    if (claims.issuedAt > now.addSecs(300))
        return false;
    return claims.issuedAt.daysTo(now) <= graceDays;
}

QByteArray publicKeyHex() { return QByteArray(kPublicKeyHex); }

bool usingDevelopmentKey() { return kIsDevelopmentKey; }

bool verify(const QString &token, Claims *out, QString *error)
{
    if (!out)
        return fail(error, "no output");
    if (token.isEmpty() || token.size() > kMaxTokenChars)
        return fail(error, "empty or oversized token");

    const QByteArray raw = token.toLatin1();
    // A JWT is exactly three base64url segments. Splitting on '.' and demanding
    // three non-empty parts rejects `alg:none` tokens (which carry an empty
    // signature) before any of this looks at the header.
    const QList<QByteArray> parts = raw.split('.');
    if (parts.size() != 3)
        return fail(error, "malformed token");
    if (parts[0].isEmpty() || parts[1].isEmpty() || parts[2].isEmpty())
        return fail(error, "malformed token");

    QByteArray headerBytes;
    if (!decodeSegment(parts[0], &headerBytes))
        return fail(error, "malformed header");
    QJsonObject header;
    if (!parseJsonObject(headerBytes, &header))
        return fail(error, "malformed header");

    // The single most important check in this file. The public key is shipped
    // in every copy of the app, so accepting an HMAC algorithm here would let
    // anyone sign a token using those published bytes as the secret.
    if (header.value(QStringLiteral("alg")).toString() != QLatin1String("EdDSA"))
        return fail(error, "unexpected algorithm");

    QByteArray signature;
    if (!decodeSegment(parts[2], &signature))
        return fail(error, "malformed signature");

    // The signature covers the received bytes verbatim — never a re-encoding of
    // the parsed claims, which would let a differently-encoded payload through.
    const QByteArray signingInput = parts[0] + '.' + parts[1];
    if (!verifySignature(signingInput, signature))
        return fail(error, "signature does not verify");

    QByteArray payloadBytes;
    if (!decodeSegment(parts[1], &payloadBytes))
        return fail(error, "malformed payload");
    QJsonObject payload;
    if (!parseJsonObject(payloadBytes, &payload))
        return fail(error, "malformed payload");

    if (payload.value(QStringLiteral("typ")).toString() != QLatin1String("license"))
        return fail(error, "not a licence token");

    // A token with no expiry is treated as forged rather than as eternal.
    const QDateTime expires = timeFromClaim(payload.value(QStringLiteral("exp")));
    if (!expires.isValid())
        return fail(error, "missing exp");

    Claims claims;
    claims.licenseKey = payload.value(QStringLiteral("sub")).toString();
    claims.plan       = payload.value(QStringLiteral("plan")).toString();
    claims.device     = payload.value(QStringLiteral("device")).toString();
    claims.issuedAt   = timeFromClaim(payload.value(QStringLiteral("iat")));
    claims.expiresAt  = expires;
    claims.features   = payload.value(QStringLiteral("features")).toObject();

    if (claims.plan != QLatin1String("free") && claims.plan != QLatin1String("pro")
        && claims.plan != QLatin1String("team"))
        return fail(error, "unknown plan");

    *out = claims;
    return true;
}

} // namespace nexa::licensetoken
