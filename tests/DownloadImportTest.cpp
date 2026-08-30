// Parsers for other download managers' export files. Pure text -> list, so no
// filesystem or network is involved.
#include "core/DownloadImport.h"

#include <QCoreApplication>
#include <QDebug>

using namespace nexa;
using namespace nexa::downloadimport;

static int g_failures = 0;
#define CHECK(cond, msg) do { if (!(cond)) { qWarning() << "FAIL:" << msg; ++g_failures; } } while (0)

static QString headerValue(const HeaderList &h, const char *name)
{
    for (const auto &kv : h)
        if (kv.first.toLower() == QByteArray(name).toLower())
            return QString::fromUtf8(kv.second);
    return QString();
}

static void testIdm()
{
    const QString ef2 = QStringLiteral(
        "<\r\n"
        "https://example.com/setup.exe\r\n"
        "referer: https://example.com/downloads\r\n"
        "User-Agent: Mozilla/5.0 (Windows NT 10.0)\r\n"
        "cookie: session=abc123\r\n"
        ">\r\n"
        "<\r\n"
        "https://cdn.example.com/pack.zip\r\n"
        ">\r\n");
    const auto list = parseIdmEf2(ef2);
    CHECK(list.size() == 2, "two IDM blocks parsed");
    if (list.size() == 2) {
        CHECK(list[0].url == QStringLiteral("https://example.com/setup.exe"), "first URL");
        CHECK(headerValue(list[0].headers, "Referer") == QStringLiteral("https://example.com/downloads"), "referer kept");
        CHECK(headerValue(list[0].headers, "User-Agent").startsWith(QStringLiteral("Mozilla/5.0")), "UA kept");
        CHECK(headerValue(list[0].headers, "Cookie") == QStringLiteral("session=abc123"), "cookie kept");
        CHECK(list[1].headers.isEmpty(), "second block has no headers");
    }
    // An unterminated final block is still usable.
    const auto partial = parseIdmEf2(QStringLiteral("<\nhttps://example.com/a.bin\n"));
    CHECK(partial.size() == 1, "unterminated block recovered");
    // Junk and non-URLs are ignored, not imported.
    const auto junk = parseIdmEf2(QStringLiteral("<\nnot a url\nreferer: x\n>\n"));
    CHECK(junk.isEmpty(), "block without a URL is dropped");
    // A CR inside a header line must not smuggle a second header through: the
    // line is split on CR, and only the referer/UA/cookie allowlist is kept.
    const auto evil = parseIdmEf2(QStringLiteral("<\nhttps://e.com/a\nreferer: bad\rX-Evil: 1\n>\n"));
    CHECK(evil.size() == 1, "injected block still yields one download");
    if (evil.size() == 1) {
        CHECK(evil[0].headers.size() == 1, "only the allowlisted header survives");
        CHECK(headerValue(evil[0].headers, "X-Evil").isEmpty(), "smuggled header dropped");
        for (const auto &kv : evil[0].headers)
            for (const char c : kv.second)
                CHECK(c >= 0x20 && c != 0x7f, "no control characters in a header value");
    }
}

static void testCrawljob()
{
    const QString job = QStringLiteral(
        "text=https://example.com/video.mp4\n"
        "filename=Lecture 1.mp4\n"
        "referrer=https://example.com/course\n"
        "\n"
        "text=https://example.com/notes.pdf\n"
        "\n"
        "packageName=ignored\n");
    const auto list = parseCrawljob(job);
    CHECK(list.size() == 2, "two crawljob entries");
    if (list.size() == 2) {
        CHECK(list[0].fileName == QStringLiteral("Lecture 1.mp4"), "filename kept");
        CHECK(headerValue(list[0].headers, "Referer") == QStringLiteral("https://example.com/course"), "referrer kept");
        CHECK(list[1].url.endsWith(QStringLiteral("notes.pdf")), "second entry");
    }
}

static void testPlainList()
{
    const QString text = QStringLiteral(
        "# my links\n"
        "https://example.com/a.iso\n"
        "\n"
        "; another comment\n"
        "https://example.com/b.iso\n"
        "https://example.com/a.iso\n"           // duplicate
        "magnet:?xt=urn:btih:0123456789abcdef\n"
        "not-a-url\n"
        "javascript:alert(1)\n"
        "file:///etc/passwd\n");
    const auto list = parsePlainList(text);
    CHECK(list.size() == 3, QStringLiteral("3 unique links, got %1").arg(list.size()));
    CHECK(list[0].url.endsWith(QStringLiteral("a.iso")), "first link");
    CHECK(list[2].url.startsWith(QStringLiteral("magnet:")), "magnet accepted");
    for (const auto &d : list) {
        CHECK(!d.url.startsWith(QStringLiteral("javascript:")), "javascript: rejected");
        CHECK(!d.url.startsWith(QStringLiteral("file:")), "file: rejected");
    }
    // A CSV export: take the first field.
    const auto csv = parsePlainList(QStringLiteral("https://example.com/c.zip,12345,done\n"));
    CHECK(csv.size() == 1 && csv[0].url.endsWith(QStringLiteral("c.zip")), "CSV first field used");
}

static void testSniffing()
{
    CHECK(parseAny(QStringLiteral("export.ef2"),
                   QStringLiteral("<\nhttps://e.com/a\n>\n")).size() == 1, "by .ef2 extension");
    CHECK(parseAny(QStringLiteral("links.crawljob"),
                   QStringLiteral("text=https://e.com/a\n")).size() == 1, "by .crawljob extension");
    // Renamed files are sniffed by content.
    CHECK(parseAny(QStringLiteral("mystery.dat"),
                   QStringLiteral("<\nhttps://e.com/a\n>\n")).size() == 1, "IDM sniffed");
    CHECK(parseAny(QStringLiteral("mystery.dat"),
                   QStringLiteral("text=https://e.com/a\n")).size() == 1, "crawljob sniffed");
    CHECK(parseAny(QStringLiteral("mystery.dat"),
                   QStringLiteral("https://e.com/a\n")).size() == 1, "plain list fallback");
    CHECK(parseAny(QStringLiteral("empty.txt"), QString()).isEmpty(), "empty input");
}

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    testIdm();
    testCrawljob();
    testPlainList();
    testSniffing();
    if (g_failures == 0) {
        qInfo() << "Download import tests passed";
        return 0;
    }
    qWarning() << g_failures << "failure(s)";
    return 1;
}
