// Pure helpers from the download engine and the updater: batch-pattern
// expansion, file categorisation, and version comparison. These decide what
// gets downloaded, where it lands, and whether an update is offered, so they
// are worth pinning down independently of the engine's I/O.
#include "core/DownloadEngine.h"
#include "core/UpdateChecker.h"

#include <QCoreApplication>
#include <QDebug>
#include <QSet>

using namespace nexa;

static int g_failures = 0;
#define CHECK(cond, msg) do { if (!(cond)) { qWarning() << "FAIL:" << msg; ++g_failures; } } while (0)

static void testExpandPattern()
{
    // A plain URL is itself — no expansion, no surprises.
    const auto plain = DownloadEngine::expandPattern(QStringLiteral("https://e.com/file.iso"));
    CHECK(plain.size() == 1 && plain[0] == QStringLiteral("https://e.com/file.iso"), "plain URL untouched");

    // The IDM-style numeric range.
    const auto range = DownloadEngine::expandPattern(QStringLiteral("https://e.com/f[1-5].jpg"));
    CHECK(range.size() == 5, QStringLiteral("[1-5] expands to 5, got %1").arg(range.size()));
    if (range.size() == 5) {
        CHECK(range.first() == QStringLiteral("https://e.com/f1.jpg"), "first of range");
        CHECK(range.last() == QStringLiteral("https://e.com/f5.jpg"), "last of range");
    }

    // Zero-padding in the pattern is preserved in the output.
    const auto padded = DownloadEngine::expandPattern(QStringLiteral("https://e.com/img[08-10].png"));
    CHECK(padded.size() == 3, "padded range size");
    if (padded.size() == 3) {
        CHECK(padded[0].endsWith(QStringLiteral("img08.png")), "08 keeps its padding");
        CHECK(padded[2].endsWith(QStringLiteral("img10.png")), "10 ends the range");
    }

    // A single-item range is still a range.
    CHECK(DownloadEngine::expandPattern(QStringLiteral("https://e.com/f[7-7].bin")).size() == 1,
          "[7-7] yields one");

    // Reversed and malformed ranges must not explode or loop forever.
    const auto reversed = DownloadEngine::expandPattern(QStringLiteral("https://e.com/f[9-2].bin"));
    CHECK(reversed.size() <= 1, "reversed range does not expand");
    const auto malformed = DownloadEngine::expandPattern(QStringLiteral("https://e.com/f[a-z].bin"));
    CHECK(malformed.size() == 1 && malformed[0].contains(QStringLiteral("[a-z]")),
          "non-numeric range left alone");
    CHECK(DownloadEngine::expandPattern(QString()).isEmpty() ||
          DownloadEngine::expandPattern(QString()).size() == 1, "empty input is safe");

    // A huge range must be bounded rather than queueing millions of downloads.
    const auto huge = DownloadEngine::expandPattern(QStringLiteral("https://e.com/f[1-100000].bin"));
    CHECK(huge.size() <= 10000, QStringLiteral("huge range is capped, got %1").arg(huge.size()));
}

static void testCategoryFor()
{
    struct Case { const char *name; const char *folder; };
    const Case cases[] = {
        {"movie.mp4", "Video"},   {"clip.MKV", "Video"},    {"show.webm", "Video"},
        {"song.mp3", "Audio"},    {"track.flac", "Audio"},  {"pod.m4a", "Audio"},
        {"paper.pdf", "Documents"}, {"sheet.xlsx", "Documents"},
        {"pack.zip", "Compressed"}, {"src.tar.gz", "Compressed"},
        {"setup.exe", "Programs"},  {"app.deb", "Programs"},
        {"photo.jpg", "Images"},    {"icon.PNG", "Images"},
    };
    for (const auto &c : cases) {
        const QString got = DownloadEngine::categoryFor(QString::fromLatin1(c.name));
        CHECK(got == QString::fromLatin1(c.folder),
              QStringLiteral("%1 -> %2 (got %3)").arg(QLatin1String(c.name),
                                                      QLatin1String(c.folder), got));
    }
    // Anything unrecognised must still land somewhere predictable.
    CHECK(!DownloadEngine::categoryFor(QStringLiteral("mystery.qqq")).isEmpty(),
          "unknown extension still categorised");
    CHECK(!DownloadEngine::categoryFor(QStringLiteral("noextension")).isEmpty(),
          "extension-less name still categorised");
    // Categories are folder names: never a path that could escape the download dir.
    for (const auto &c : cases) {
        const QString folder = DownloadEngine::categoryFor(QString::fromLatin1(c.name));
        CHECK(!folder.contains(QLatin1Char('/')) && !folder.contains(QLatin1Char('\\'))
              && folder != QLatin1String(".."), "category is a plain folder name");
    }
}

static void testVersionCompare()
{
    CHECK(UpdateChecker::isNewer(QStringLiteral("0.2.0"), QStringLiteral("0.1.0")), "0.2.0 > 0.1.0");
    CHECK(UpdateChecker::isNewer(QStringLiteral("1.0.0"), QStringLiteral("0.9.9")), "1.0.0 > 0.9.9");
    // The classic string-compare trap: 1.10 must beat 1.9.
    CHECK(UpdateChecker::isNewer(QStringLiteral("1.10.0"), QStringLiteral("1.9.0")), "1.10 > 1.9");
    CHECK(UpdateChecker::isNewer(QStringLiteral("0.1.10"), QStringLiteral("0.1.9")), "0.1.10 > 0.1.9");

    CHECK(!UpdateChecker::isNewer(QStringLiteral("0.1.0"), QStringLiteral("0.1.0")), "equal is not newer");
    CHECK(!UpdateChecker::isNewer(QStringLiteral("0.1.0"), QStringLiteral("0.2.0")), "older is not newer");
    // Trailing zeros and differing part counts compare numerically.
    CHECK(!UpdateChecker::isNewer(QStringLiteral("1.0"), QStringLiteral("1.0.0")), "1.0 == 1.0.0");
    CHECK(UpdateChecker::isNewer(QStringLiteral("1.0.1"), QStringLiteral("1.0")), "1.0.1 > 1.0");
    // Suffixes are stripped rather than making the compare throw or misread.
    CHECK(UpdateChecker::isNewer(QStringLiteral("2.0.0-rc1"), QStringLiteral("1.9.9")), "rc suffix ignored");
    CHECK(!UpdateChecker::isNewer(QString(), QStringLiteral("0.1.0")), "empty remote is not newer");

    // The platform key must be one the website feed understands.
    const QString key = UpdateChecker::platformKey();
    CHECK(key == QLatin1String("windows") || key == QLatin1String("linux")
          || key == QLatin1String("macos"), "platform key is a known value");
}

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    testExpandPattern();
    testCategoryFor();
    testVersionCompare();
    if (g_failures == 0) {
        qInfo() << "Engine helper tests passed";
        return 0;
    }
    qWarning() << g_failures << "failure(s)";
    return 1;
}
