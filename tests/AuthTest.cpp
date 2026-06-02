// Self-contained runtime tests for the AuthenticationManager / CookieFile auth
// layer. No QtTest dependency — a tiny CHECK macro keeps it buildable with just
// Qt6::Core + Qt6::Network. Run via the `nexa_auth_test` target.

#include "auth/AuthenticationManager.h"
#include "auth/CookieFile.h"
#include "auth/AuthUtils.h"

#include <QCoreApplication>
#include <QTemporaryDir>
#include <QNetworkRequest>
#include <QFile>
#include <QDateTime>
#include <QtGlobal>
#include <cstdio>

using namespace nexa;

static int g_fail = 0, g_pass = 0;
#define CHECK(cond, msg) do { \
    if (cond) { ++g_pass; } \
    else { ++g_fail; std::fprintf(stderr, "FAIL: %s  (%s:%d)\n", msg, __FILE__, __LINE__); } \
} while (0)

static QString writeFile(const QString &path, const QString &contents)
{
    QFile f(path);
    f.open(QIODevice::WriteOnly | QIODevice::Truncate);
    f.write(contents.toUtf8());
    f.close();
    return path;
}

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    QTemporaryDir tmp;
    const qint64 future = QDateTime::currentSecsSinceEpoch() + 86400;
    const qint64 past   = QDateTime::currentSecsSinceEpoch() - 86400;

    // ---- Netscape cookies.txt parsing -----------------------------------
    const QString good = writeFile(tmp.filePath("good.txt"),
        QStringLiteral("# Netscape HTTP Cookie File\n"
                       ".udemy.com\tTRUE\t/\tTRUE\t%1\taccess_token\tSECRET123\n"
                       "#HttpOnly_www.udemy.com\tFALSE\t/course\tTRUE\t%1\tsess\tABC\n").arg(future));
    {
        AuthenticationManager m;
        const AuthResult r = m.registerCookieFile(QStringLiteral("udemy.com"), good);
        CHECK(r.ok, "valid cookies.txt should register");

        // host-suffix matching
        CHECK(m.resolve(QUrl("https://www.udemy.com/course/x")).kind == DomainAuth::Kind::CookieFile,
              "udemy.com credential matches www.udemy.com");
        CHECK(m.resolve(QUrl("https://evil-udemy.com/")).kind == DomainAuth::Kind::None,
              "must NOT match evil-udemy.com (suffix boundary)");

        // yt-dlp arg form: cookie file = path only (no secret on the arg boundary)
        const QStringList a = m.ytDlpArgs(QUrl("https://www.udemy.com/x"));
        CHECK(a.size() == 2 && a.at(0) == "--cookies" && a.at(1) == good,
              "cookie file -> {--cookies, abspath}");

        // native header form + RFC6265 path matching
        const HeaderList h = m.headerAuthFor(QUrl("https://www.udemy.com/course/lesson"));
        bool hasCookie = false; QByteArray cookieVal;
        for (const auto &p : h) if (p.first == "Cookie") { hasCookie = true; cookieVal = p.second; }
        CHECK(hasCookie, "cookie header produced for udemy");
        CHECK(cookieVal.contains("access_token=SECRET123"), "root-path cookie included");
        CHECK(cookieVal.contains("sess=ABC"), "/course cookie included on /course/lesson");

        const HeaderList h2 = m.headerAuthFor(QUrl("https://www.udemy.com/coursework"));
        QByteArray v2; for (const auto &p : h2) if (p.first == "Cookie") v2 = p.second;
        CHECK(!v2.contains("sess=ABC"), "/course cookie NOT sent to /coursework (no false prefix match)");

        // applyTo on a real request
        QNetworkRequest req(QUrl("https://www.udemy.com/x"));
        CHECK(m.applyTo(req, QUrl("https://www.udemy.com/x")), "applyTo reports applied");
        CHECK(!req.rawHeader("Cookie").isEmpty(), "applyTo set a Cookie header");
    }

    // ---- malformed / expired cookie files -------------------------------
    {
        AuthenticationManager m;
        const QString bad6 = writeFile(tmp.filePath("bad6.txt"),
            QStringLiteral(".x.com\tTRUE\t/\tTRUE\t%1\tonlysixfields\n").arg(future));
        CHECK(m.registerCookieFile("x.com", bad6).code == AuthError::MalformedFormat,
              "6-field line -> MalformedFormat");

        const QString allExp = writeFile(tmp.filePath("exp.txt"),
            QStringLiteral(".x.com\tTRUE\t/\tFALSE\t%1\tk\tv\n").arg(past));
        CHECK(m.registerCookieFile("x.com", allExp).code == AuthError::AllExpired,
              "all-expired cookies -> AllExpired (distinct from malformed)");

        const QString ctrl = writeFile(tmp.filePath("ctrl.txt"),
            QStringLiteral(".x.com\tTRUE\t/\tFALSE\t%1\tk\tval\rinjected\n").arg(future));
        CHECK(m.registerCookieFile("x.com", ctrl).code == AuthError::MalformedFormat,
              "control char in cookie value -> MalformedFormat (no header injection)");

        CHECK(m.registerCookieFile("x.com", tmp.filePath("nope.txt")).code == AuthError::FileNotFound,
              "missing file -> FileNotFound");
    }

    // ---- registerCookieData: cookie TEXT (extension path) ---------------
    {
        AuthenticationManager m;
        const QString txt = QStringLiteral(
            "# Netscape HTTP Cookie File\n"
            ".udemy.com\tTRUE\t/\tTRUE\t%1\taccess_token\tTOKENXYZ\n").arg(future);
        const AuthResult r = m.registerCookieData(QStringLiteral("udemy.com"), txt);
        CHECK(r.ok, "valid cookie TEXT registers via registerCookieData");

        // round-trips to a real --cookies temp file that exists and is 0600
        const QStringList a = m.ytDlpArgs(QUrl("https://www.udemy.com/course/x/learn/lecture/1"));
        CHECK(a.size() == 2 && a.at(0) == "--cookies", "cookie data -> {--cookies, tempPath}");
        CHECK(QFile::exists(a.value(1)), "registerCookieData wrote a temp cookies.txt");
        const auto perms = QFile(a.value(1)).permissions();
        CHECK(!(perms & (QFile::ReadGroup | QFile::ReadOther | QFile::WriteGroup | QFile::WriteOther)),
              "temp cookies.txt is owner-only (0600)");

        CHECK(m.registerCookieData("x.com", QString()).code == AuthError::EmptyFile,
              "empty cookie text -> EmptyFile");
        CHECK(m.registerCookieData("x.com",
                  QStringLiteral(".x.com\tTRUE\t/\tTRUE\t%1\tonlysix\n").arg(future)).code
                  == AuthError::MalformedFormat,
              "6-field cookie text -> MalformedFormat");
        CHECK(m.registerCookieData("x.com", QString(6 * 1024 * 1024, QLatin1Char('a'))).code
                  == AuthError::MalformedFormat,
              "oversized cookie text (>5 MB) rejected before write");
        CHECK(m.registerCookieData(QString(), txt).code == AuthError::UnknownDomain,
              "empty domain rejected");
    }

    // ---- browser cookies (--cookies-from-browser) -----------------------
    {
        AuthenticationManager m;
        CHECK(m.registerBrowserCookies("udemy.com", "chrome").ok,
              "registerBrowserCookies(chrome) succeeds");
        const QStringList a = m.ytDlpArgs(QUrl("https://www.udemy.com/course/x/learn/lecture/1"));
        CHECK(a.size() == 2 && a.at(0) == "--cookies-from-browser" && a.at(1) == "chrome",
              "browser cookies -> {--cookies-from-browser, chrome}");
        CHECK(m.validateFor(QUrl("https://www.udemy.com/x")).ok,
              "browser-cookies credential validates (no expiry check)");
        CHECK(m.registerBrowserCookies("x.com", "internetexplorer").code == AuthError::MalformedFormat,
              "unsupported browser rejected");
        // never injected for an excluded host (YouTube)
        CHECK(m.ytDlpArgs(QUrl("https://youtu.be/x")).isEmpty(),
              "browser cookies never applied to a YouTube host");
    }

    // ---- bearer tokens --------------------------------------------------
    {
        AuthenticationManager m;
        CHECK(m.registerBearerToken("api.example.com", "abc.DEF-123_x~", 0).ok,
              "valid RFC6750 token registers");

        // CRLF / header-injection token is rejected
        CHECK(m.registerBearerToken("api.example.com", QStringLiteral("ab\r\nX-Evil: 1")).code
                  == AuthError::MalformedFormat,
              "CRLF token rejected (header-injection guard)");
        CHECK(m.registerBearerToken("api.example.com", "has space").code == AuthError::MalformedFormat,
              "token with space rejected");
        CHECK(m.registerBearerToken("api.example.com", "quote\"x").code == AuthError::MalformedFormat,
              "token with quote rejected (config-file injection guard)");

        // expired bearer
        CHECK(m.registerBearerToken("api.example.com", "abc", past).code == AuthError::TokenExpired,
              "past-expiry token -> TokenExpired");

        // native header form
        const HeaderList h = m.headerAuthFor(QUrl("https://api.example.com/v1"));
        bool authHdr = false; for (const auto &p : h) if (p.first == "Authorization")
            authHdr = (p.second == "Bearer abc.DEF-123_x~");
        CHECK(authHdr, "bearer -> Authorization: Bearer <token> header");

        // yt-dlp form: token must NOT appear as a process arg; goes via config file
        const QStringList a = m.ytDlpArgs(QUrl("https://api.example.com/v1"));
        CHECK(a.size() == 2 && a.at(0) == "--config-location", "bearer -> {--config-location, file}");
        QFile cfg(a.at(1));
        CHECK(cfg.exists(), "yt-dlp auth config file written");
        CHECK(cfg.open(QIODevice::ReadOnly), "auth config readable");
        const QByteArray body = cfg.readAll(); cfg.close();
        CHECK(body.contains("Authorization: Bearer abc.DEF-123_x~"), "config holds the bearer header");
        const auto perms = QFile(a.at(1)).permissions();
        CHECK(!(perms & (QFile::ReadGroup | QFile::ReadOther | QFile::WriteGroup | QFile::WriteOther)),
              "auth config is owner-only (0600)");
        bool argLeak = false; for (const QString &s : a) if (s.contains("abc.DEF-123")) argLeak = true;
        CHECK(!argLeak, "token never appears in the yt-dlp argument list");
    }

    // ---- YouTube exclusion safeguard ------------------------------------
    {
        AuthenticationManager m;
        const QString yt = writeFile(tmp.filePath("yt.txt"),
            QStringLiteral(".youtube.com\tTRUE\t/\tFALSE\t%1\tk\tv\n").arg(future));
        m.registerCookieFile("youtube.com", yt);   // even if mistakenly registered...
        CHECK(m.resolve(QUrl("https://www.youtube.com/watch?v=x")).kind == DomainAuth::Kind::None,
              "youtube host is always excluded from auth");
        CHECK(m.ytDlpArgs(QUrl("https://youtu.be/x")).isEmpty(),
              "no auth args for youtu.be (preserves extractor safeguard)");
    }

    // ---- 401/403 classifiers (AuthUtils) --------------------------------
    CHECK(authIsStatus(401) && authIsStatus(403), "401/403 are auth statuses");
    CHECK(!authIsStatus(200) && !authIsStatus(404), "200/404 are not auth statuses");
    CHECK(!authReasonFromYtDlpLine("ERROR: unable to download: HTTP Error 403: Forbidden").isEmpty(),
          "yt-dlp HTTP 403 line classified as auth");
    CHECK(authReasonFromYtDlpLine("[download] 12% of 5MiB").isEmpty(),
          "ordinary progress line is not an auth error");

    std::printf("\nAUTH TESTS: %d passed, %d failed\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
