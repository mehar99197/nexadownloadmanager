#include "web/PublicUrlPolicy.h"

#include <QElapsedTimer>
#include <QHash>
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

namespace {

// QHostInfo::fromName() is Qt's *synchronous* resolver — "this function blocks
// during the lookup, which means the GUI will freeze", as Qt's own documentation
// puts it. Every download in this app runs on the GUI thread by design (no
// worker threads, no mutexes), so each lookup freezes the window for its
// duration.
//
// That was survivable at one lookup per download. It was not survivable once a
// segmented download validated the same URL once per segment — 32 of them for a
// file over 100 MB — and then re-validated the same host again after every
// segment redirect and every retry. Those lookups ran back to back in a single
// loop that never returned to the event loop, so the window stopped repainting
// and the OS marked it "Not Responding". Caching the verdict per host collapses
// them back to one.
//
// Caching does not weaken the check. It was always time-of-check/time-of-use:
// the address resolved here is never the address the socket goes on to connect
// with, so a verdict was never a guarantee about the next connection — only
// about the name.
constexpr qint64 kVerdictTtlMs = 60 * 1000;
constexpr int    kVerdictMax   = 256;

struct Verdict {
    bool   isPublic;
    qint64 stamp;
};

QHash<QString, Verdict> &verdicts()
{
    static QHash<QString, Verdict> cache;
    return cache;
}

// Monotonic, so moving the wall clock cannot make an entry look fresh forever.
qint64 nowMs()
{
    static QElapsedTimer timer;
    if (!timer.isValid())
        timer.start();
    return timer.elapsed();
}

int g_lookups = 0;

void remember(const QString &host, bool isPublic, qint64 now)
{
    QHash<QString, Verdict> &cache = verdicts();
    if (cache.size() >= kVerdictMax) {
        for (auto it = cache.begin(); it != cache.end();) {
            if (now - it->stamp >= kVerdictTtlMs)
                it = cache.erase(it);
            else
                ++it;
        }
        // Still full of live entries: drop the lot. This is a latency cache, so
        // the only cost of throwing it away is resolving those hosts again.
        if (cache.size() >= kVerdictMax)
            cache.clear();
    }
    cache.insert(host, Verdict{isPublic, now});
}

} // namespace

void resetHostVerdictCache()
{
    verdicts().clear();
    g_lookups = 0;
}

int hostVerdictLookupCount()
{
    return g_lookups;
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

    const qint64 now = nowMs();
    const QHash<QString, Verdict> &cache = verdicts();
    const auto cached = cache.constFind(host);
    if (cached != cache.constEnd() && now - cached->stamp < kVerdictTtlMs)
        return cached->isPublic;

    ++g_lookups;
    const QHostInfo info = QHostInfo::fromName(host);
    bool isPublic = info.error() == QHostInfo::NoError && !info.addresses().isEmpty();
    if (isPublic) {
        for (const QHostAddress &address : info.addresses()) {
            if (!isPublicAddress(address)) {
                isPublic = false;
                break;
            }
        }
    }
    // Refusals are cached too. A resolver that is down must not mean a fresh
    // blocking lookup for every one of a download's 32 segments, and caching a
    // refusal is the fail-closed direction.
    remember(host, isPublic, now);
    return isPublic;
}

} // namespace nexa
