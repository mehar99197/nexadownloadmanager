// Pure helpers from the download engine and the updater: batch-pattern
// expansion, file categorisation, and version comparison. These decide what
// gets downloaded, where it lands, and whether an update is offered, so they
// are worth pinning down independently of the engine's I/O.
#include "core/DownloadEngine.h"
#include "core/UpdateChecker.h"
#include "grabber/HlsGrabber.h"
#include "core/Types.h"

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


// A media playlist is attacker-controlled input. HlsGrabber rewrites it into a
// local index.m3u8 and hands that to FFmpeg with `file` on the protocol
// whitelist, so any tag mirrored into it is a tag FFmpeg will act on. Only
// #EXT-X-KEY and #EXT-X-MAP have their URI validated (absolutised + checked
// against the http(s) rule and isPublicHttpUrl); every other tag is mirrored
// verbatim, so a URI-bearing one must not be mirrored at all.
//
// Regression: a rendition URI of http://127.0.0.1:9911/ was fetched by
// ffmpeg 8.1, and file:///... was opened for reading — both past every check.
static void testPlaylistTagMirroring()
{
    // The URI-bearing tags FFmpeg's HLS demuxer will open. None may pass.
    const char *dangerous[] = {
        "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"x\",URI=\"http://127.0.0.1:9911/\"",
        "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"x\",URI=\"file:///etc/passwd\"",
        "#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI=\"http://169.254.169.254/latest/meta-data/\"",
        "#EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"http://10.0.0.1/key\"",
        "#EXT-X-SESSION-DATA:DATA-ID=\"d\",URI=\"file:///proc/self/environ\"",
        "#EXT-X-PRELOAD-HINT:TYPE=PART,URI=\"http://[::1]/x\"",
        "#EXT-X-RENDITION-REPORT:URI=\"http://192.168.1.1/\"",
        "#EXT-X-PART:DURATION=1,URI=\"file:///home/u/.ssh/id_rsa\"",
    };
    for (const char *line : dangerous) {
        CHECK(!HlsGrabber::tagIsSafeToMirror(QString::fromLatin1(line)),
              QStringLiteral("URI-bearing tag must not be mirrored: %1")
                  .arg(QString::fromLatin1(line).left(28)));
    }

    // Case must not be a way around it.
    CHECK(!HlsGrabber::tagIsSafeToMirror(
              QStringLiteral("#EXT-X-MEDIA:TYPE=AUDIO,uri=\"file:///etc/passwd\"")),
          "a lower-case uri= attribute is still a URI");

    // The ordinary structural tags carry no URI and must still come through,
    // or the local playlist stops being playable.
    const char *safe[] = {
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-TARGETDURATION:10",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXTINF:9.009,",
        "#EXT-X-DISCONTINUITY",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXT-X-ENDLIST",
    };
    for (const char *line : safe) {
        CHECK(HlsGrabber::tagIsSafeToMirror(QString::fromLatin1(line)),
              QStringLiteral("structural tag must be mirrored: %1")
                  .arg(QString::fromLatin1(line)));
    }

    // Only tags. A bare segment line is handled on its own path.
    CHECK(!HlsGrabber::tagIsSafeToMirror(QStringLiteral("seg00000.ts")),
          "a non-tag line is not a tag");
}


// Windows keeps a handful of legacy DEVICE names reserved — CON, PRN, AUX, NUL,
// COM0-9, LPT0-9 — and they stay reserved with an extension attached. Opening
// "NUL.mp4" for writing does not create a file, it writes to the null device:
// the download reports complete and nothing is on disk. Win32 also strips
// trailing dots and spaces, so "video." and "video" collide.
//
// Every one of these names can arrive from outside — a Content-Disposition
// header, a page's suggested name, or a torrent's own file list.
static void testWindowsFileNameRules()
{
    // Device names, bare and with extensions, in any case.
    const char *devices[] = {
        "NUL", "CON", "PRN", "AUX", "COM1", "COM9", "LPT1", "LPT9",
        "nul", "Con", "nUl.mp4", "NUL.mp4", "CON.txt", "COM1.exe",
        "NUL.tar.gz",           // Win32 matches the stem before the FIRST dot
    };
    for (const char *d : devices) {
        const QString out = nexa::makeFileNamePortable(QString::fromLatin1(d));
        CHECK(out != QString::fromLatin1(d),
              QStringLiteral("reserved device name must be escaped: %1").arg(QLatin1String(d)));
        CHECK(out.startsWith(QLatin1Char('_')),
              QStringLiteral("escaped name keeps the original, prefixed: %1 -> %2")
                  .arg(QLatin1String(d), out));
    }

    // Trailing dots and spaces: Win32 drops them silently.
    CHECK(nexa::makeFileNamePortable(QStringLiteral("report.")) == QStringLiteral("report"),
          "a trailing dot is removed");
    CHECK(nexa::makeFileNamePortable(QStringLiteral("report...  ")) == QStringLiteral("report"),
          "a run of trailing dots and spaces is removed");
    CHECK(nexa::makeFileNamePortable(QStringLiteral("video.mp4")) == QStringLiteral("video.mp4"),
          "an ordinary extension is untouched");

    // Names that merely CONTAIN a device name are perfectly legal.
    const char *fine[] = { "CONTACT.pdf", "NULL.txt", "console.log", "MyCOM1Report.doc",
                           "AUXILIARY", "LPT.txt", "COM.txt", "COM10.txt" };
    for (const char *f : fine) {
        CHECK(nexa::makeFileNamePortable(QString::fromLatin1(f)) == QString::fromLatin1(f),
              QStringLiteral("ordinary name must be left alone: %1").arg(QLatin1String(f)));
    }

    // And the engine's own sanitiser must apply them, not just the helper.
    CHECK(!DownloadEngine::sanitizeFileName(QStringLiteral("NUL.mp4")).isEmpty(),
          "engine still yields a usable name");
    CHECK(DownloadEngine::sanitizeFileName(QStringLiteral("NUL.mp4")) != QStringLiteral("NUL.mp4"),
          "engine escapes a reserved device name");
    CHECK(DownloadEngine::sanitizeFileName(QStringLiteral("../../etc/passwd"))
              == QStringLiteral("passwd"),
          "engine still reduces a traversal attempt to its basename");
    CHECK(DownloadEngine::sanitizeFileName(QStringLiteral("clip.")) == QStringLiteral("clip"),
          "engine strips a trailing dot");
    // The cap is applied BEFORE the Win32 rules, so truncation cannot reintroduce
    // a trailing dot or manufacture a device name.
    const QString longName = QString(300, QLatin1Char('a')) + QStringLiteral(".mp4");
    CHECK(DownloadEngine::sanitizeFileName(longName).size() <= 240, "long name is capped");
    CHECK(!DownloadEngine::sanitizeFileName(QString(239, QLatin1Char('a')) + QStringLiteral("."))
               .endsWith(QLatin1Char('.')),
          "a cap landing on a dot does not leave one behind");
}


// The rule behind "refresh download address". Both directions matter: too
// strict and clicking the link again quietly starts a SECOND copy beside the
// half-finished file, which is the bug the feature exists to remove; too loose
// and an unrelated download is folded into someone else's partial file, which
// is silent corruption.
static void testRefreshAddressMatching()
{
    const auto same = [](const char *oldUrl, const char *savedName,
                         const char *newUrl, const char *suggested = "") {
        return DownloadEngine::addressLooksLikeSameFile(
            QUrl(QString::fromLatin1(oldUrl)), QString::fromLatin1(savedName),
            QUrl(QString::fromLatin1(newUrl)), QString::fromLatin1(suggested));
    };

    // The case this exists for: one object, a new signing token. Same host,
    // same path, completely different query.
    CHECK(same("https://cdn.example.com/files/app.zip?Expires=1&Signature=aaa", "app.zip",
               "https://cdn.example.com/files/app.zip?Expires=999&Signature=zzz"),
          "same host + path with a fresh token is the same file");

    // A refreshed link routinely lands on a different CDN edge. Matching the
    // name across hosts is the point, not an oversight.
    CHECK(same("https://edge7.example.com/d/video.mp4?t=1", "video.mp4",
               "https://edge3.example.com/other/path/video.mp4?t=2"),
          "same file name on a different edge still matches");

    // The saved file was de-duplicated, so it no longer equals the URL's name.
    // The OLD URL's basename is what still matches.
    CHECK(same("https://cdn.example.com/a/report.pdf", "report (2).pdf",
               "https://cdn2.example.com/b/report.pdf"),
          "a de-duplicated save name does not break the match");

    // The name can arrive only in the browser's suggestion, when the URL is
    // opaque (an id, a query-driven download endpoint).
    // Note the DIFFERENT paths: with the same path the host+path branch above
    // would answer first and this would prove nothing.
    CHECK(same("https://files.example.com/get?id=88", "lecture.mkv",
               "https://files.example.com/download?id=99", "lecture.mkv"),
          "a suggested name matching the saved file counts");

    // ---- and what must NOT match -------------------------------------
    CHECK(!same("https://cdn.example.com/a/app.zip", "app.zip",
                "https://cdn.example.com/a/setup.exe"),
          "a different file on the same host is not a refresh");
    CHECK(!same("https://cdn.example.com/a/app.zip", "app.zip",
                "https://cdn.example.com/b/app2.zip"),
          "a near-miss name is not a refresh");
    CHECK(!same("https://cdn.example.com/a/app.zip", "app.zip", "not a url at all"),
          "junk is never a refresh");
    CHECK(!same("https://cdn.example.com/a/app.zip", "app.zip", ""),
          "an empty address is never a refresh");

    // Two query-only endpoints on the same host with DIFFERENT paths and no
    // usable names must not collapse into each other just because both paths
    // are short. This is the "swallows a stranger" direction.
    CHECK(!same("https://files.example.com/get?id=88", "",
                "https://files.example.com/fetch?id=99"),
          "different paths with no names do not match");

    // An empty path on the new URL must not satisfy the host+path branch by
    // matching an equally empty old path.
    CHECK(!same("https://example.com", "", "https://example.com"),
          "two bare hosts with nothing to compare do not match");

    // Host comparison is case-insensitive (DNS is), file names on Windows too.
    CHECK(same("https://CDN.Example.com/a/App.ZIP?t=1", "App.ZIP",
               "https://cdn.example.com/a/App.ZIP?t=2"),
          "host case does not change the answer");
    CHECK(same("https://cdn.example.com/a/App.ZIP", "App.ZIP",
               "https://other.example.com/b/app.zip"),
          "file-name case does not change the answer");
}

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    testExpandPattern();
    testCategoryFor();
    testVersionCompare();
    testPlaylistTagMirroring();
    testWindowsFileNameRules();
    testRefreshAddressMatching();
    if (g_failures == 0) {
        qInfo() << "Engine helper tests passed";
        return 0;
    }
    qWarning() << g_failures << "failure(s)";
    return 1;
}
