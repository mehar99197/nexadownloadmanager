// Ed25519 licence-token verification.
//
// This is the check that decides whether an install is paid, running on a
// machine its owner fully controls, so every classic JWT forgery gets an
// explicit test. The mirror of this file is
// ndm-website/backend/test/licenseToken.test.js — the two verifiers must agree.
//
// Tokens here are signed with the same fixed development key the backend uses
// when LICENSE_JWT_PRIVATE_KEY is unset, so the test needs no network and no
// configuration. It asserts that key is NOT what a release build trusts.

#include "license/LicenseToken.h"
#include "license/LicenseManager.h"   // for Entitlements — a plain struct, no QObject needed

#include <QCoreApplication>
#include <QByteArray>
#include <QDateTime>
#include <QDebug>
#include <QJsonDocument>
#include <QJsonObject>

#include <openssl/evp.h>

using namespace nexa;

static int g_failures = 0;
#define CHECK(cond, msg) do { if (!(cond)) { qWarning() << "FAIL:" << msg; ++g_failures; } } while (0)

// The development seed from ndm-website/backend/src/config/licenseKeys.js:
// 32 bytes of 0x4e. Public by design — that is the whole point of the
// "a release build must not trust this key" test below.
static QByteArray developmentSeed() { return QByteArray(32, '\x4e'); }

static QByteArray base64Url(const QByteArray &raw)
{
    return raw.toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals);
}

// Sign `header.payload` with a raw Ed25519 seed, producing a JWT.
static QString makeToken(const QJsonObject &header, const QJsonObject &payload,
                         const QByteArray &seed)
{
    const QByteArray signingInput =
        base64Url(QJsonDocument(header).toJson(QJsonDocument::Compact)) + '.'
        + base64Url(QJsonDocument(payload).toJson(QJsonDocument::Compact));

    EVP_PKEY *key = EVP_PKEY_new_raw_private_key(
        EVP_PKEY_ED25519, nullptr,
        reinterpret_cast<const unsigned char *>(seed.constData()), size_t(seed.size()));
    if (!key)
        return QString();

    EVP_MD_CTX *ctx = EVP_MD_CTX_new();
    QByteArray signature(64, '\0');
    // EVP_DigestSign reads *siglen as the capacity of the buffer it is handed;
    // leaving it at 0 makes the call fail with "buffer too small".
    size_t signatureLength = size_t(signature.size());
    bool ok = ctx
        && EVP_DigestSignInit(ctx, nullptr, nullptr, nullptr, key) == 1
        && EVP_DigestSign(ctx, reinterpret_cast<unsigned char *>(signature.data()),
                          &signatureLength,
                          reinterpret_cast<const unsigned char *>(signingInput.constData()),
                          size_t(signingInput.size())) == 1;
    if (ctx) EVP_MD_CTX_free(ctx);
    EVP_PKEY_free(key);
    if (!ok)
        return QString();
    signature.truncate(int(signatureLength));

    return QString::fromLatin1(signingInput + '.' + base64Url(signature));
}

static QJsonObject validHeader() {
    return QJsonObject{{QStringLiteral("alg"), QStringLiteral("EdDSA")},
                       {QStringLiteral("typ"), QStringLiteral("JWT")}};
}

static QJsonObject validPayload()
{
    const qint64 now = QDateTime::currentSecsSinceEpoch();
    return QJsonObject{
        {QStringLiteral("sub"),    QStringLiteral("NDM-AAAA-BBBB-CCCC")},
        {QStringLiteral("plan"),   QStringLiteral("pro")},
        {QStringLiteral("device"), QStringLiteral("devicehash")},
        {QStringLiteral("typ"),    QStringLiteral("license")},
        {QStringLiteral("iat"),    now},
        {QStringLiteral("exp"),    now + 86400},
        {QStringLiteral("features"), QJsonObject{
            {QStringLiteral("aiRename"), true},
            {QStringLiteral("maxConcurrentDownloads"), 0},
            {QStringLiteral("themes"), QStringLiteral("all")},
        }},
    };
}

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);

    // This test signs with the development key, so it can only run its forgery
    // cases when that is what the build trusts. A release build (which must
    // carry a real key) checks the one thing that still matters: that it is not
    // trusting the published development key.
    if (!licensetoken::usingDevelopmentKey()) {
        CHECK(licensetoken::publicKeyHex()
                  != QByteArray("8e486e8fb79499dba2a789c6b1639d409495233c79e0eaf52e2ea1fc9dbbb73f"),
              "a release build must not trust the published development key");
        qInfo() << "Release key in use — forgery cases skipped (they need the dev key).";
        return g_failures == 0 ? 0 : 1;
    }

    // --- The happy path ----------------------------------------------------
    {
        licensetoken::Claims claims;
        const bool ok = licensetoken::verify(
            makeToken(validHeader(), validPayload(), developmentSeed()), &claims);
        CHECK(ok, "a correctly signed token verifies");
        CHECK(claims.plan == QLatin1String("pro"), "plan comes from the signed claims");
        CHECK(claims.licenseKey == QLatin1String("NDM-AAAA-BBBB-CCCC"), "sub is read");
        CHECK(claims.device == QLatin1String("devicehash"), "device binding is read");
        CHECK(claims.issuedAt.isValid() && claims.expiresAt.isValid(), "iat and exp are parsed");
        CHECK(claims.features.value(QStringLiteral("aiRename")).toBool(), "features survive");
    }

    // --- Forgeries ---------------------------------------------------------
    {
        // The attack that matters most: the public key ships in every binary,
        // so a verifier that accepted an HMAC algorithm would let anyone sign
        // a token with those published bytes.
        QJsonObject header = validHeader();
        header[QStringLiteral("alg")] = QStringLiteral("HS256");
        licensetoken::Claims claims;
        CHECK(!licensetoken::verify(makeToken(header, validPayload(), developmentSeed()), &claims),
              "an alg other than EdDSA is refused");
    }
    {
        QJsonObject header = validHeader();
        header[QStringLiteral("alg")] = QStringLiteral("none");
        const QByteArray unsignedToken =
            base64Url(QJsonDocument(header).toJson(QJsonDocument::Compact)) + '.'
            + base64Url(QJsonDocument(validPayload()).toJson(QJsonDocument::Compact)) + '.';
        licensetoken::Claims claims;
        CHECK(!licensetoken::verify(QString::fromLatin1(unsignedToken), &claims),
              "alg:none with an empty signature is refused");
    }
    {
        // Sign a Free token, then rewrite the payload to say Pro.
        QJsonObject freePayload = validPayload();
        freePayload[QStringLiteral("plan")] = QStringLiteral("free");
        const QString token = makeToken(validHeader(), freePayload, developmentSeed());
        const QStringList parts = token.split(QLatin1Char('.'));
        CHECK(parts.size() == 3, "the test's own signer produced a well-formed token");
        if (parts.size() != 3)
            return 1;
        QJsonObject upgraded = freePayload;
        upgraded[QStringLiteral("plan")] = QStringLiteral("team");
        const QString tampered = parts[0] + QLatin1Char('.')
            + QString::fromLatin1(base64Url(QJsonDocument(upgraded).toJson(QJsonDocument::Compact)))
            + QLatin1Char('.') + parts[2];
        licensetoken::Claims claims;
        CHECK(!licensetoken::verify(tampered, &claims), "a rewritten plan breaks the signature");
    }
    {
        QByteArray otherSeed(32, '\x99');
        licensetoken::Claims claims;
        CHECK(!licensetoken::verify(makeToken(validHeader(), validPayload(), otherSeed), &claims),
              "a token signed by a different key is refused");
    }
    {
        QJsonObject payload = validPayload();
        payload.remove(QStringLiteral("exp"));
        licensetoken::Claims claims;
        CHECK(!licensetoken::verify(makeToken(validHeader(), payload, developmentSeed()), &claims),
              "a token with no exp is refused, not treated as eternal");
    }
    {
        QJsonObject payload = validPayload();
        payload[QStringLiteral("typ")] = QStringLiteral("access");
        licensetoken::Claims claims;
        CHECK(!licensetoken::verify(makeToken(validHeader(), payload, developmentSeed()), &claims),
              "a token of another type cannot pass as a licence");
    }
    {
        QJsonObject payload = validPayload();
        payload[QStringLiteral("plan")] = QStringLiteral("enterprise");
        licensetoken::Claims claims;
        CHECK(!licensetoken::verify(makeToken(validHeader(), payload, developmentSeed()), &claims),
              "an unknown plan name is refused rather than trusted");
    }
    {
        // An expired token still verifies here — LicenseManager owns the expiry
        // policy, because offline grace deliberately accepts a stale token.
        QJsonObject payload = validPayload();
        const qint64 longAgo = QDateTime::currentSecsSinceEpoch() - 90 * 86400;
        payload[QStringLiteral("iat")] = longAgo;
        payload[QStringLiteral("exp")] = longAgo + 86400;
        licensetoken::Claims claims;
        CHECK(licensetoken::verify(makeToken(validHeader(), payload, developmentSeed()), &claims),
              "an expired token still verifies — expiry is the caller's policy");
        CHECK(claims.expiresAt < QDateTime::currentDateTimeUtc(),
              "…and reports an expiry in the past so the caller can act on it");
    }

    // --- Offline grace policy ----------------------------------------------
    //
    // This is the rule that replaced "is the string in the settings file
    // 'pro'?", so it gets tested directly. `verify` has already run by the time
    // these apply, i.e. the claims here are ones a real server signed.
    {
        const QString thisDevice = QStringLiteral("devicehash");
        const QDateTime now = QDateTime::currentDateTimeUtc();
        const int grace = 7;

        auto claimsFor = [&](const QString &plan, const QString &device, qint64 issuedDaysAgo) {
            licensetoken::Claims c;
            c.plan = plan;
            c.device = device;
            c.issuedAt = now.addDays(-issuedDaysAgo);
            c.expiresAt = c.issuedAt.addDays(1);
            return c;
        };

        CHECK(licensetoken::offlineGraceAllows(claimsFor(QStringLiteral("pro"), thisDevice, 0),
                                               thisDevice, now, grace),
              "a token issued today to this device keeps Pro offline");
        CHECK(licensetoken::offlineGraceAllows(claimsFor(QStringLiteral("team"), thisDevice, 6),
                                               thisDevice, now, grace),
              "…and still does on day 6 of a 7-day window");
        CHECK(!licensetoken::offlineGraceAllows(claimsFor(QStringLiteral("pro"), thisDevice, 8),
                                                thisDevice, now, grace),
              "a token older than the grace window does not");
        CHECK(!licensetoken::offlineGraceAllows(claimsFor(QStringLiteral("free"), thisDevice, 0),
                                                thisDevice, now, grace),
              "a Free token never grants a paid plan");
        CHECK(!licensetoken::offlineGraceAllows(claimsFor(QStringLiteral("pro"),
                                                          QStringLiteral("someone-elses-machine"), 0),
                                                thisDevice, now, grace),
              "a token copied from another machine is refused");
        CHECK(!licensetoken::offlineGraceAllows(claimsFor(QStringLiteral("pro"), QString(), 0),
                                                thisDevice, now, grace),
              "a token with no device binding is refused");
        CHECK(!licensetoken::offlineGraceAllows(claimsFor(QStringLiteral("pro"), thisDevice, -3),
                                                thisDevice, now, grace),
              "a token issued in the future (rolled-back clock) is refused");
        {
            // Ordinary clock skew must not lock a paying user out.
            licensetoken::Claims skewed = claimsFor(QStringLiteral("pro"), thisDevice, 0);
            skewed.issuedAt = now.addSecs(60);
            CHECK(licensetoken::offlineGraceAllows(skewed, thisDevice, now, grace),
                  "a minute of clock skew is tolerated");
        }
        {
            licensetoken::Claims noIat = claimsFor(QStringLiteral("pro"), thisDevice, 0);
            noIat.issuedAt = QDateTime();
            CHECK(!licensetoken::offlineGraceAllows(noIat, thisDevice, now, grace),
                  "a token with no iat is refused rather than treated as fresh");
        }
    }

    // --- Entitlement defaults fail closed ----------------------------------
    //
    // The struct's defaults are what an install runs on before its first
    // successful validation, and after any rejection. They must be the Free
    // set: a build that defaulted generously would hand out Pro to anyone who
    // simply stayed offline.
    {
        const Entitlements fresh;   // as constructed, no server has spoken yet
        CHECK(fresh.maxConcurrentDownloads == 3, "default concurrency is the Free cap");
        CHECK(!fresh.authSiteDownloads, "auth sites are off by default");
        CHECK(!fresh.aiRename, "AI rename is off by default");
        CHECK(!fresh.adFree, "ads are shown by default");
        CHECK(fresh.seats == 1, "one seat by default");
        CHECK(fresh.themes == QLatin1String("basic"), "only the core themes by default");

        CHECK(fresh.allowsTheme(QStringLiteral("dark")), "a free theme is allowed");
        CHECK(fresh.allowsTheme(QStringLiteral("light")), "…and so is the other one");
        CHECK(fresh.allowsTheme(QStringLiteral("system")), "…and system");
        CHECK(!fresh.allowsTheme(QStringLiteral("nebula")), "a paid theme is refused on Free");
        CHECK(!fresh.allowsTheme(QString()), "an empty theme id is refused");

        Entitlements paid;
        paid.themes = QStringLiteral("all");
        CHECK(paid.allowsTheme(QStringLiteral("nebula")), "'all' unlocks a paid theme");
        CHECK(paid.allowsTheme(QStringLiteral("NEBULA")), "theme ids compare case-insensitively");
    }

    // --- Malformed input ---------------------------------------------------
    for (const QString &bad : {QStringLiteral(""), QStringLiteral("x"), QStringLiteral("a.b"),
                               QStringLiteral("a.b.c.d"), QStringLiteral("..."),
                               QStringLiteral("a.b.c"), QStringLiteral("!!!.???.###")}) {
        licensetoken::Claims claims;
        CHECK(!licensetoken::verify(bad, &claims),
              QStringLiteral("malformed input refused: '%1'").arg(bad));
    }

    if (g_failures == 0)
        qInfo() << "LicenseToken: all checks passed";
    return g_failures == 0 ? 0 : 1;
}
