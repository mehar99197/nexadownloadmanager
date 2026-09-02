#include "web/PublicUrlPolicy.h"

#include <QCoreApplication>
#include <QDebug>

static int failures = 0;

#define CHECK(expr) do { if (!(expr)) { qCritical() << "FAIL" << __LINE__ << #expr; ++failures; } } while (false)

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    CHECK(nexa::isPublicHttpUrl(QUrl(QStringLiteral("https://8.8.8.8/file")), false));
    CHECK(nexa::isPublicHttpUrl(QUrl(QStringLiteral("https://example.com/file")), false));
    CHECK(!nexa::isPublicHttpUrl(QUrl(QStringLiteral("http://127.0.0.1/admin")), false));
    CHECK(!nexa::isPublicHttpUrl(QUrl(QStringLiteral("http://10.0.0.1/")), false));
    CHECK(!nexa::isPublicHttpUrl(QUrl(QStringLiteral("http://169.254.169.254/latest/meta-data")), false));
    CHECK(!nexa::isPublicHttpUrl(QUrl(QStringLiteral("http://[fc00::1]/internal")), false));
    CHECK(!nexa::isPublicHttpUrl(QUrl(QStringLiteral("http://localhost:8080/")), false));
    CHECK(!nexa::isPublicHttpUrl(QUrl(QStringLiteral("http://printer.local/")), false));
    CHECK(!nexa::isPublicHttpUrl(QUrl(QStringLiteral("file:///etc/passwd")), false));
    CHECK(!nexa::isPublicHttpUrl(QUrl(QStringLiteral("https://user:pass@example.com/")), false));

    // ---- the resolving branch --------------------------------------------
    // Everything above passes resolveHost=false, so until now the branch that
    // actually calls QHostInfo::fromName() — Qt's *blocking* resolver, on the
    // GUI thread — had no coverage at all. That is how the segmented-download
    // hang shipped: one download resolved the same host once per segment (32
    // for a large file), plus once more per redirect and per retry, all in a
    // loop that never returned to the event loop.
    //
    // These cases assert the number of REAL lookups, not the verdict, so they
    // are deterministic whether or not the machine running them has DNS.

    nexa::resetHostVerdictCache();
    CHECK(nexa::hostVerdictLookupCount() == 0);

    // 32 segments of one download, all validating the same URL.
    const QUrl target(QStringLiteral("https://example.com/big.iso"));
    for (int i = 0; i < 32; ++i)
        nexa::isPublicHttpUrl(target);
    CHECK(nexa::hostVerdictLookupCount() == 1);

    // A redirect target: a different path, same host (segment redirects are
    // required to be same-host), so it must not resolve again.
    nexa::isPublicHttpUrl(QUrl(QStringLiteral("https://example.com/other.bin")));
    CHECK(nexa::hostVerdictLookupCount() == 1);

    // A genuinely different host is a different verdict, so it must resolve.
    nexa::isPublicHttpUrl(QUrl(QStringLiteral("https://example.org/x")));
    CHECK(nexa::hostVerdictLookupCount() == 2);

    // An IP literal is decided arithmetically and must never reach the resolver.
    nexa::resetHostVerdictCache();
    for (int i = 0; i < 8; ++i) {
        nexa::isPublicHttpUrl(QUrl(QStringLiteral("https://8.8.8.8/file")));
        nexa::isPublicHttpUrl(QUrl(QStringLiteral("http://127.0.0.1/admin")));
    }
    CHECK(nexa::hostVerdictLookupCount() == 0);

    // Nor must an explicit resolveHost=false.
    for (int i = 0; i < 8; ++i)
        nexa::isPublicHttpUrl(QUrl(QStringLiteral("https://cdn.example.com/f")), false);
    CHECK(nexa::hostVerdictLookupCount() == 0);

    // A cached verdict must be the same verdict, not merely a fast one.
    nexa::resetHostVerdictCache();
    const QUrl repeated(QStringLiteral("https://example.com/a"));
    const bool resolved = nexa::isPublicHttpUrl(repeated);
    CHECK(nexa::isPublicHttpUrl(repeated) == resolved);
    CHECK(nexa::hostVerdictLookupCount() == 1);

    // The structural rejections must still hold on the resolving path — they
    // are decided before any lookup, so they stay free.
    nexa::resetHostVerdictCache();
    CHECK(!nexa::isPublicHttpUrl(QUrl(QStringLiteral("http://localhost:8080/"))));
    CHECK(!nexa::isPublicHttpUrl(QUrl(QStringLiteral("http://printer.local/"))));
    CHECK(!nexa::isPublicHttpUrl(QUrl(QStringLiteral("file:///etc/passwd"))));
    CHECK(!nexa::isPublicHttpUrl(QUrl(QStringLiteral("https://user:pass@example.com/"))));
    CHECK(nexa::hostVerdictLookupCount() == 0);

    return failures == 0 ? 0 : 1;
}
