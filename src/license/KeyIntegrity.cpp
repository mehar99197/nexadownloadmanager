#include "license/KeyIntegrity.h"
#include "license/LicenseToken.h"

#include <QByteArray>
#include <QCryptographicHash>

namespace nexa::licensetoken {

namespace {

#ifdef NEXA_LICENSE_KEY_DIGEST
constexpr auto kExpectedDigestHex = NEXA_LICENSE_KEY_DIGEST;
constexpr bool kDigestConfigured = true;
#else
constexpr auto kExpectedDigestHex = "";
constexpr bool kDigestConfigured = false;
#endif

} // namespace

bool publicKeyIntact()
{
    // A developer build has no digest to compare against. Release builds always
    // do: CMake derives it from the same value it compiles in, so the two
    // cannot drift apart by accident.
    if (!kDigestConfigured)
        return true;

    const QByteArray expected(kExpectedDigestHex);
    const QByteArray actual = QCryptographicHash::hash(
        publicKeyHex(), QCryptographicHash::Sha256).toHex();

    if (expected.size() != actual.size())
        return false;
    // Constant-time compare. Not because a timing attack is plausible here —
    // the attacker owns the machine — but because a short-circuiting comparison
    // in a security check is the kind of thing that gets copied to somewhere it
    // does matter.
    unsigned char difference = 0;
    for (int i = 0; i < expected.size(); ++i)
        difference |= static_cast<unsigned char>(expected.at(i) ^ actual.at(i));
    return difference == 0;
}

} // namespace nexa::licensetoken
