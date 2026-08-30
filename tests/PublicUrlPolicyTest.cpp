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
    return failures == 0 ? 0 : 1;
}
