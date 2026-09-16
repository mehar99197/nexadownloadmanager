// The website grabber's decisions, isolated from the network.
//
// A crawler acts on somebody else's markup, so its dangerous parts are the
// ones that turn that markup into a filesystem path or a request. These are
// the four pure helpers behind those decisions, and the first of them is the
// reason this file exists: a URL path of "../../.." used to become a file
// write outside the folder the user picked.
#include "grabber/SiteCrawler.h"

#include <QCoreApplication>
#include <QDebug>
#include <QDir>
#include <QUrl>

using namespace nexa;

static int g_failures = 0;
#define CHECK(cond, msg) do { if (!(cond)) { qWarning() << "FAIL:" << msg; ++g_failures; } } while (0)

static const QString kBase = QStringLiteral("/tmp/grab");

static QString pathFor(const char *url, bool structure = true)
{
    return SiteCrawler::safeSavePath(kBase, QUrl(QString::fromLatin1(url)), structure);
}

static bool insideBase(const QString &p)
{
    if (p.isEmpty())
        return false;
    const QString base = QDir(kBase).absolutePath();
    return p == base || p.startsWith(base + QLatin1Char('/'));
}

static void testPathTraversalRefused()
{
    // The whole point. Each of these resolves outside the save folder if the
    // URL path is pasted into a filesystem path, which is what the first
    // version did.
    const char *attacks[] = {
        "https://evil.test/../../../../Windows/System32/evil.dll",
        "https://evil.test/a/../../../../../etc/passwd",
        "https://evil.test/%2e%2e/%2e%2e/%2e%2e/secret.txt",   // percent-encoded
        "https://evil.test/..%2f..%2f..%2fsecret.txt",
        "https://evil.test/a/./../../b/../../../x.sh",
    };
    for (const char *a : attacks) {
        const QString got = pathFor(a);
        CHECK(insideBase(got),
              QStringLiteral("escaped the save folder: %1 -> %2")
                  .arg(QLatin1String(a), got.isEmpty() ? QStringLiteral("(refused)") : got));
    }

    // A drive letter is the Windows version of the same trick.
    const QString drive = pathFor("https://evil.test/C:/Windows/evil.dll");
    CHECK(insideBase(drive), QStringLiteral("drive-letter segment escaped: %1").arg(drive));
    CHECK(!drive.contains(QLatin1String("C:/Windows")), "a drive reference survived sanitising");
}

static void testOrdinaryPathsStillWork()
{
    // Refusing everything would also pass the test above, so the ordinary
    // cases have to keep working.
    const QString nested = pathFor("https://site.test/img/2026/photo.jpg");
    CHECK(QDir(nested).absolutePath()
              == QDir(kBase + QStringLiteral("/img/2026/photo.jpg")).absolutePath(),
          QStringLiteral("structure preserved, got %1").arg(nested));

    const QString flat = pathFor("https://site.test/img/2026/photo.jpg", false);
    CHECK(QDir(flat).absolutePath() == QDir(kBase + QStringLiteral("/photo.jpg")).absolutePath(),
          QStringLiteral("structure off flattens, got %1").arg(flat));

    // A directory URL has no filename of its own.
    const QString root = pathFor("https://site.test/");
    CHECK(insideBase(root) && !root.endsWith(QLatin1Char('/')),
          QStringLiteral("a bare host gets a filename, got %1").arg(root));

    // Percent-encoded spaces come back as spaces, not as %20.
    const QString spaced = pathFor("https://site.test/my%20file.pdf");
    CHECK(spaced.endsWith(QLatin1String("my file.pdf")),
          QStringLiteral("percent-decoding, got %1").arg(spaced));

    // A Win32 device name is still a device name with an extension on it.
    const QString device = pathFor("https://site.test/NUL.mp4");
    CHECK(insideBase(device) && !device.endsWith(QLatin1String("/NUL.mp4")),
          QStringLiteral("reserved device name survived: %1").arg(device));
}

static void testPageVsFile()
{
    struct Case { const char *url; bool page; };
    static const Case kCases[] = {
        {"https://s.test/about.html", true},
        {"https://s.test/index.php",  true},
        {"https://s.test/x.aspx",     true},
        {"https://s.test/docs",       true},    // no extension
        {"https://s.test/docs/",      true},
        {"https://s.test/photo.jpg",  false},
        {"https://s.test/paper.pdf",  false},
        {"https://s.test/clip.mp4",   false},
        {"https://s.test/archive.tar.gz", false},
    };
    for (const Case &c : kCases) {
        const bool got = SiteCrawler::looksLikePage(QUrl(QString::fromLatin1(c.url)));
        CHECK(got == c.page,
              QStringLiteral("%1 should be %2").arg(QLatin1String(c.url),
                                                    c.page ? QStringLiteral("a page")
                                                           : QStringLiteral("a file")));
    }
}

static void testWildcardPatterns()
{
    // The bug this pins: Qt's default wildcard conversion treats '/' as a path
    // separator, so "*.jpg" matched nothing at all and every preset — images,
    // videos, documents — downloaded zero files while appearing to work.
    const QStringList images = {QStringLiteral("*.jpg"), QStringLiteral("*.png")};
    CHECK(SiteCrawler::matchesAnyPattern(images, QStringLiteral("photo.jpg")), "*.jpg matches photo.jpg");
    CHECK(SiteCrawler::matchesAnyPattern(images, QStringLiteral("PHOTO.JPG")), "matching is case-insensitive");
    CHECK(!SiteCrawler::matchesAnyPattern(images, QStringLiteral("paper.pdf")), "*.jpg does not match a pdf");
    CHECK(!SiteCrawler::matchesAnyPattern({}, QStringLiteral("photo.jpg")),
          "an empty pattern list matches nothing (the caller decides what that means)");
    CHECK(SiteCrawler::matchesAnyPattern({QStringLiteral("  *.jpg  ")}, QStringLiteral("a.jpg")),
          "patterns are trimmed, because people type spaces after commas");
}

static void testRobots()
{
    const QString ua = QStringLiteral("NexaGrabber/1.0");

    CHECK(SiteCrawler::robotsAllows(QString(), ua, QStringLiteral("/anything")),
          "no robots.txt means no restriction");

    const QString basic = QStringLiteral(
        "User-agent: *\n"
        "Disallow: /private\n");
    CHECK(!SiteCrawler::robotsAllows(basic, ua, QStringLiteral("/private/x")), "Disallow is honoured");
    CHECK(SiteCrawler::robotsAllows(basic, ua, QStringLiteral("/public/x")), "everything else is allowed");

    // Allow carving an exception out of a Disallow: the longest rule wins, and
    // the old version ignored Allow entirely.
    const QString carve = QStringLiteral(
        "User-agent: *\n"
        "Disallow: /files\n"
        "Allow: /files/public\n");
    CHECK(!SiteCrawler::robotsAllows(carve, ua, QStringLiteral("/files/secret.pdf")), "the Disallow still applies");
    CHECK(SiteCrawler::robotsAllows(carve, ua, QStringLiteral("/files/public/a.pdf")),
          "a longer Allow beats a shorter Disallow");

    // A section naming us wins over the wildcard section.
    const QString specific = QStringLiteral(
        "User-agent: *\n"
        "Disallow: /\n"
        "\n"
        "User-agent: NexaGrabber\n"
        "Disallow: /admin\n");
    CHECK(SiteCrawler::robotsAllows(specific, ua, QStringLiteral("/page.html")),
          "our own section replaces the wildcard one");
    CHECK(!SiteCrawler::robotsAllows(specific, ua, QStringLiteral("/admin/x")),
          "and its rules are obeyed");

    // Comments and a bare Disallow (which means "nothing is disallowed").
    const QString noisy = QStringLiteral(
        "# a comment\n"
        "User-agent: *   # trailing comment\n"
        "Disallow:\n");
    CHECK(SiteCrawler::robotsAllows(noisy, ua, QStringLiteral("/x")),
          "an empty Disallow forbids nothing");
}

static void testPresetsAreBounded()
{
    // "Offline website" used to mean depth 999 with no file cap, which is not
    // a site copy, it is an unbounded walk.
    const CrawlConfig offline = CrawlConfig::forOffline(QUrl(QStringLiteral("https://s.test/")),
                                                        QStringLiteral("/tmp/grab"));
    CHECK(offline.maxDepth <= SiteCrawler::kMaxDepthCeiling,
          QStringLiteral("offline depth is bounded, got %1").arg(offline.maxDepth));
    CHECK(offline.maxFiles > 0 && offline.maxFiles <= SiteCrawler::kMaxFilesCeiling,
          QStringLiteral("offline file count is bounded, got %1").arg(offline.maxFiles));
    CHECK(offline.sameDomainOnly, "an offline copy stays on the site it was asked for");

    const CrawlConfig images = CrawlConfig::forImages(QUrl(QStringLiteral("https://s.test/")),
                                                      QStringLiteral("/tmp/grab"));
    CHECK(!images.includePatterns.isEmpty(), "the images preset actually filters");
    CHECK(SiteCrawler::matchesAnyPattern(images.includePatterns, QStringLiteral("a.png")),
          "and its patterns match a real image name");
    CHECK(!SiteCrawler::matchesAnyPattern(images.includePatterns, QStringLiteral("a.zip")),
          "and not an archive");
}

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);

    testPathTraversalRefused();
    testOrdinaryPathsStillWork();
    testPageVsFile();
    testWildcardPatterns();
    testRobots();
    testPresetsAreBounded();

    if (g_failures == 0)
        qInfo() << "SiteCrawlerTest: all checks passed";
    else
        qWarning() << "SiteCrawlerTest:" << g_failures << "check(s) failed";
    return g_failures == 0 ? 0 : 1;
}
