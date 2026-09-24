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
#include <QDebug>
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
    // Checked rather than ignored: a fixture that silently fails to write
    // makes the assertion that follows fail for the wrong reason.
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        qWarning() << "FAIL: could not write fixture" << path << f.errorString();
        return path;
    }
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
#ifndef Q_OS_WIN
        // POSIX mode bits only: Qt leaves NTFS ACL lookup off, so on Windows
        // permissions() always reports group/other read and the check is moot
        // (the temp dir is already user-private there).
        const auto perms = QFile(a.value(1)).permissions();
        CHECK(!(perms & (QFile::ReadGroup | QFile::ReadOther | QFile::WriteGroup | QFile::WriteOther)),
              "temp cookies.txt is owner-only (0600)");
#endif

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
#ifndef Q_OS_WIN
        const auto perms = QFile(a.at(1)).permissions();
        CHECK(!(perms & (QFile::ReadGroup | QFile::ReadOther | QFile::WriteGroup | QFile::WriteOther)),
              "auth config is owner-only (0600)");
#endif
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

    // ---- Cookie de-dup (CookieFile::dedupe) -----------------------------
    {
        // A jar from repeated logins: access_token at BOTH .udemy.com (stale) and
        // www.udemy.com (current), two csrftoken, plus a unique #HttpOnly_ cookie.
        // dedupe() must keep ONE per name, preferring the host-specific (www) one.
        const QByteArray fut = QByteArray::number(future);
        const QByteArray jar =
            QByteArray("# Netscape HTTP Cookie File\n")
            + ".udemy.com\tTRUE\t/\tTRUE\t"     + fut + "\taccess_token\tSTALE\n"
            + "www.udemy.com\tFALSE\t/\tTRUE\t" + fut + "\taccess_token\tCURRENT\n"
            + ".udemy.com\tTRUE\t/\tTRUE\t"     + fut + "\tcsrftoken\tC1\n"
            + "www.udemy.com\tFALSE\t/\tTRUE\t" + fut + "\tcsrftoken\tC2\n"
            + "#HttpOnly_www.udemy.com\tFALSE\t/\tTRUE\t" + fut + "\tsess\tONLY\n";
        const QString s = QString::fromUtf8(CookieFile::dedupe(jar));
        CHECK(s.count(QStringLiteral("access_token")) == 1, "dedupe keeps one access_token");
        CHECK(s.contains(QStringLiteral("access_token\tCURRENT")), "dedupe keeps host-specific (www) token");
        CHECK(!s.contains(QStringLiteral("STALE")), "dedupe drops the stale .udemy.com token");
        CHECK(s.count(QStringLiteral("csrftoken")) == 1, "dedupe keeps one csrftoken");
        CHECK(s.contains(QStringLiteral("#HttpOnly_www.udemy.com")) && s.contains(QStringLiteral("sess\tONLY")),
              "dedupe preserves a unique #HttpOnly_ cookie");
        CHECK(s.startsWith(QStringLiteral("# Netscape")), "dedupe preserves a comment header");
    }

    // ---- Browser-login profile (registerBrowserCookies + ytDlpArgs) -----
    {
        AuthenticationManager m;
        CHECK(m.registerBrowserCookies("udemy.com", "chrome", "Profile 2").ok,
              "browser-login with a profile registers");
        const QStringList a = m.ytDlpArgs(QUrl("https://www.udemy.com/x"));
        CHECK(a.size() == 2 && a.at(0) == "--cookies-from-browser" && a.at(1) == "chrome:Profile 2",
              "profile -> --cookies-from-browser chrome:Profile 2");
        CHECK(m.registerBrowserCookies("udemy.com", "firefox").ok, "re-register replaces prior credential");
        CHECK(m.ytDlpArgs(QUrl("https://www.udemy.com/x")).value(1) == "firefox",
              "latest registration wins (no profile -> plain browser name)");
        CHECK(m.registerBrowserCookies("x.com", "chrome", "../etc").code == AuthError::MalformedFormat,
              "profile with a path separator is rejected");
    }

    // ---- 401/403 classifiers (AuthUtils) --------------------------------
    CHECK(authIsStatus(401) && authIsStatus(403), "401/403 are auth statuses");
    CHECK(!authIsStatus(200) && !authIsStatus(404), "200/404 are not auth statuses");
    CHECK(!authReasonFromYtDlpLine("ERROR: unable to download: HTTP Error 403: Forbidden").isEmpty(),
          "yt-dlp HTTP 403 line classified as auth");
    CHECK(authReasonFromYtDlpLine("[download] 12% of 5MiB").isEmpty(),
          "ordinary progress line is not an auth error");

    // A media-stage 403 is a CDN/expired-URL/stale-yt-dlp failure, NOT a missing
    // credential. These are the verbatim lines yt-dlp emits when a googlevideo
    // URL is refused; misreporting them as "authentication required" sent users
    // to Site Logins to fix a problem no cookie can solve.
    for (const char *mediaLine : {
             "ERROR: unable to download video data: HTTP Error 403: Forbidden",
             "[download] Got error: HTTP Error 403: Forbidden. Retrying (attempt 1 of 10)...",
             "ERROR: unable to download format: HTTP Error 403: Forbidden" }) {
        const QString why = authReasonFromYtDlpLine(QString::fromLatin1(mediaLine));
        CHECK(!why.isEmpty(), "media-stage 403 still produces a reason");
        CHECK(!why.contains("authentication required"),
              "media-stage 403 is NOT reported as an authentication failure");
        CHECK(why.contains("yt-dlp is out of date"),
              "media-stage 403 points at the real cause (stale yt-dlp / expired URL)");
    }
    // A 401, and an extractor-stage 403, remain genuine auth failures.
    CHECK(authReasonFromYtDlpLine("ERROR: HTTP Error 401: Unauthorized")
              .contains("authentication required"),
          "401 is still an authentication failure");
    CHECK(authReasonFromYtDlpLine("ERROR: [udemy] course: HTTP Error 403: Forbidden")
              .contains("authentication required"),
          "extractor-stage 403 is still an authentication failure");

    // ---- Every fix a message names is one the user can perform ------------
    // yt-dlp ships inside Nexa and changes only with a Nexa update, so a stale
    // one is fixed from Help → Check for updates…, never by "updating yt-dlp".
    const QString staleYtDlp = authReasonFromYtDlpLine(
        QStringLiteral("ERROR: unable to download video data: HTTP Error 403: Forbidden"));
    CHECK(!staleYtDlp.contains("Update yt-dlp"),
          "media-stage 403 does not ask the user to update yt-dlp by hand");
    CHECK(staleYtDlp.contains(QStringLiteral("Help → Check for updates…")),
          "media-stage 403 points at Help → Check for updates…");

    // YouTube's bot check, as yt-dlp prints it. Nexa sends YouTube no cookie at
    // all (see the exclusion safeguard above), so re-exporting one cannot help.
    const QUrl youtube(QStringLiteral("https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
    const QString botCheck = authReasonFromYtDlpLine(QStringLiteral(
        "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you’re not a bot. Use "
        "--cookies-from-browser or --cookies for the authentication."));
    CHECK(botCheck.contains("YouTube"), "bot check is reported as YouTube's");
    CHECK(!botCheck.contains("cookie", Qt::CaseInsensitive),
          "bot check does not mention cookies, which YouTube never gets");
    CHECK(botCheck.contains("later") && botCheck.contains("another network"),
          "bot check says to retry later or from another network");
    CHECK(botCheck.contains(QStringLiteral("Help → Check for updates…")),
          "bot check points at Help → Check for updates…");

    // YtDlpGrabber cuts a reason at 160 characters before showing it; the
    // control a message points at is its last words, so it must fit.
    CHECK(staleYtDlp.length() <= 160 && botCheck.length() <= 160,
          "both reasons fit the grabber's 160-character cut");

    // The "start it from the page" hint is true only where the extension's
    // login is used: a login site whose job carried no credential. Never on
    // YouTube, whose login Nexa never sends.
    const QUrl udemy(QStringLiteral("https://www.udemy.com/course/x/learn/lecture/1"));
    const QString loginWhy = QStringLiteral("login required — provide cookies or a token");
    CHECK(withCredentialHint(loginWhy, {}, udemy).contains("use the Nexa button on the page"),
          "login site, no credential on the job: hint to start it from the page");
    CHECK(withCredentialHint(loginWhy, {QStringLiteral("--cookies"), QStringLiteral("c.txt")}, udemy)
              == loginWhy,
          "login site whose job already carried a credential: no hint");
    CHECK(withCredentialHint(loginWhy, {}, youtube) == loginWhy,
          "YouTube: no hint, its login is never sent");
    CHECK(withCredentialHint(QStringLiteral("authentication required (HTTP 403)"), {},
                             QUrl(QStringLiteral("https://youtu.be/dQw4w9WgXcQ")))
              == QStringLiteral("authentication required (HTTP 403)"),
          "youtu.be: no hint either");
    CHECK(withCredentialHint(botCheck, {}, youtube) == botCheck,
          "bot check reaches the user without a login hint");
    CHECK(withCredentialHint(staleYtDlp, {}, udemy) == staleYtDlp,
          "a reason that is not a login failure gets no hint");

    // YouTube refusing one video, as yt-dlp 2026.08.19 prints it: YouTube's own
    // reason, plus yt-dlp's cookie advice whenever that reason says "sign in".
    // All three need a signed-in YouTube session, which Nexa never sends, so
    // "provide cookies" is wrong for every one of them.
    const QString ytCookieAdvice = QStringLiteral(
        " Use --cookies-from-browser or --cookies for the authentication. See  "
        "https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  for how to "
        "manually pass cookies. Also see  "
        "https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies  for tips "
        "on effectively exporting YouTube cookies");
    const QString privateVideo = authReasonFromYtDlpLine(QStringLiteral(
        "ERROR: [youtube] dQw4w9WgXcQ: Private video. Sign in if you've been granted access "
        "to this video.") + ytCookieAdvice);
    const QString membersOnly = authReasonFromYtDlpLine(QStringLiteral(
        "ERROR: [youtube] dQw4w9WgXcQ: Join this channel to get access to members-only content "
        "like this video, and other exclusive perks."));
    const QString ageGated = authReasonFromYtDlpLine(QStringLiteral(
        "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm your age. This video may be "
        "inappropriate for some users.") + ytCookieAdvice);
    CHECK(privateVideo.contains("private") && privateVideo.contains("owner")
              && privateVideo.contains("public or unlisted"),
          "private YouTube video: only its owner making it public or unlisted helps");
    CHECK(membersOnly.contains("members only"), "members-only YouTube video is named as such");
    CHECK(ageGated.contains("age-restricted"),
          "age-gated YouTube video is named as age-restricted, not as a bot check");
    for (const QString &why : {privateVideo, membersOnly, ageGated}) {
        CHECK(why.contains("YouTube") && why.contains("never sends a YouTube login"),
              "a YouTube refusal says Nexa never sends a YouTube login");
        CHECK(!why.contains("cookie", Qt::CaseInsensitive) && !why.contains("login required"),
              "a YouTube refusal asks for no cookies or login");
        CHECK(why.length() <= 160, "a YouTube refusal fits the grabber's 160-character cut");
        CHECK(withCredentialHint(why, {}, youtube) == why,
              "a YouTube refusal reaches the user without a login hint");
    }
    // The same words from a login site keep the login advice: there Nexa does
    // send the login it holds.
    CHECK(authReasonFromYtDlpLine(QStringLiteral("ERROR: [vimeo] 76979871: Private video"))
              .contains("login required"),
          "a private video on a login site still says login required");

    // The YouTube test behind both the credential exclusion and the hint:
    // the host itself or a dot-boundary subdomain, nothing that merely ends alike.
    CHECK(isYouTubeHost("youtube.com") && isYouTubeHost("www.youtube.com")
              && isYouTubeHost("music.youtube.com") && isYouTubeHost("youtu.be")
              && isYouTubeHost("WWW.YouTube.COM"),
          "YouTube hosts are recognised, case-insensitively");
    CHECK(!isYouTubeHost("notyoutube.com") && !isYouTubeHost("youtube.com.example.net")
              && !isYouTubeHost("www.udemy.com") && !isYouTubeHost(QString()),
          "look-alike and unrelated hosts are not YouTube");

    std::printf("\nAUTH TESTS: %d passed, %d failed\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
