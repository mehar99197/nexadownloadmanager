#include "web/PublicUrlPolicy.h"

#include <QHostAddress>
#include <QHostInfo>

namespace nexa {

static bool isPublicIpv4(quint32 address)
{
    const quint32 first = (address >> 24) & 0xffu;
    const quint32 second = (address >> 16) & 0xffu;
    if (first == 0 || first == 10 || first == 127 || first >= 224)
        return false;
    if (first == 100 && second >= 64 && second <= 127)
        return false;
    if (first == 169 && second == 254)
        return false;
    if (first == 172 && second >= 16 && second <= 31)
        return false;
    if (first == 192 && (second == 0 || second == 2 || second == 168))
        return false;
    if (first == 198 && (second == 18 || second == 19 || second == 51))
        return false;
    if (first == 203 && second == 0 && ((address >> 8) & 0xffu) == 113)
        return false;
    return true;
}

static bool isPublicAddress(const QHostAddress &address)
{
    bool ipv4 = false;
    const quint32 value = address.toIPv4Address(&ipv4);
    if (ipv4)
        return isPublicIpv4(value);
    if (address.isNull() || address.isLoopback() || address.isLinkLocal() ||
        address.isMulticast() || !address.isGlobal())
        return false;
    // QHostAddress::isGlobal() does not consistently exclude IPv6 unique-local
    // addresses across Qt versions. Explicitly reject fc00::/7 as private LAN
    // space so DNS names cannot bypass the public-target policy via IPv6.
    if (address.protocol() == QAbstractSocket::IPv6Protocol) {
        const Q_IPV6ADDR bytes = address.toIPv6Address();
        if ((bytes[0] & 0xfe) == 0xfc)
            return false;
    }
    return true;
}

bool isPublicHttpUrl(const QUrl &url, bool resolveHost)
{
    const QString scheme = url.scheme().toLower();
    if (!url.isValid() || (scheme != QLatin1String("http") && scheme != QLatin1String("https")) ||
        !url.userInfo().isEmpty())
        return false;

    QString host = url.host().toLower();
    if (host.endsWith(QLatin1Char('.')))
        host.chop(1);
    if (host.isEmpty() || host == QLatin1String("localhost") ||
        host.endsWith(QLatin1String(".localhost")) ||
        host.endsWith(QLatin1String(".local")) || !host.contains(QLatin1Char('.')))
        return false;

    QHostAddress literal;
    if (literal.setAddress(host))
        return isPublicAddress(literal);
    if (!resolveHost)
        return true;

    const QHostInfo info = QHostInfo::fromName(host);
    if (info.error() != QHostInfo::NoError || info.addresses().isEmpty())
        return false;
    for (const QHostAddress &address : info.addresses()) {
        if (!isPublicAddress(address))
            return false;
    }
    return true;
}

} // namespace nexa
