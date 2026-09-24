#include "auth/AuthUtils.h"

#include <QRegularExpression>
#include <QUrl>

namespace nexa {

QString authErrorDetail(int httpStatus)
{
    return httpStatus == 401 ? QStringLiteral("authentication required (HTTP 401)")
                             : QStringLiteral("access forbidden (HTTP 403)");
}

QString authReasonFromYtDlpLine(const QString &line)
{
    static const QRegularExpression httpRe(QStringLiteral("HTTP Error (401|403)"),
                                           QRegularExpression::CaseInsensitiveOption);
    // A 401 always means "not authenticated". A 403 does NOT: yt-dlp reports both
    // "you are not logged in" and "the CDN refused this media URL" as HTTP Error
    // 403. The second is by far the common case on YouTube — a signed googlevideo
    // URL that expired, is IP-bound, or was built by a yt-dlp too old to solve the
    // current player challenge — and no cookie can fix it. Reporting that as
    // "authentication required" sends the user to Site Logins to chase a
    // credential problem that does not exist, so classify the two separately by
    // the download stage the line came from.
    static const QRegularExpression mediaStageRe(
        QStringLiteral("unable to download video data|unable to download media|"
                       "unable to download format|got error:|fragment \\d+|"
                       "giving up after|content too short"),
        QRegularExpression::CaseInsensitiveOption);
    if (const auto m = httpRe.match(line); m.hasMatch()) {
        // yt-dlp ships inside Nexa and changes only with a Nexa update, so a stale
        // one is fixed from Help → Check for updates…, not by "updating yt-dlp".
        // At most 160 characters: YtDlpGrabber cuts a reason there, and the menu
        // path is the part that must survive.
        if (m.captured(1) == QLatin1String("403") && mediaStageRe.match(line).hasMatch())
            return QStringLiteral("media server refused the download (HTTP 403), not a "
                                  "login problem: the stream URL expired or Nexa's yt-dlp "
                                  "is out of date. Retry, then Help → Check for updates…");
        return QStringLiteral("authentication required (HTTP %1)").arg(m.captured(1));
    }

    // YouTube's bot check ("Sign in to confirm you're not a bot"). It asks for a
    // sign-in, but Nexa never sends YouTube a cookie (isYouTubeHost), so the
    // message offers what works without one: retrying later or from another
    // network, and the newer yt-dlp that a Nexa update brings.
    static const QRegularExpression botRe(QStringLiteral("Sign in to confirm you.*bot"),
                                          QRegularExpression::CaseInsensitiveOption);
    if (botRe.match(line).hasMatch())
        return QStringLiteral("YouTube asked to confirm you're not a bot — retry later or "
                              "from another network, and check for a Nexa update "
                              "(Help → Check for updates…)");

    // Windows-specific: yt-dlp can't read cookies straight from Chrome/Edge/Brave
    // because Chromium's App-Bound Encryption (Chrome 127+) blocks DPAPI decryption
    // from an external process. This only bites the --cookies-from-browser fallback
    // (manual paste); the extension's "Download with Nexa" button reads cookies via
    // the in-browser API and is unaffected — so point the user there.
    static const QRegularExpression cookieDecryptRe(
        QStringLiteral("failed to decrypt.*(dpapi|cookie)|could not (copy|decrypt).*(chrome|cookie)|"
                       "unable to (read|decrypt).*cookies?|cookies?.*could not be decrypted|"
                       "app[- ]bound encryption"),
        QRegularExpression::CaseInsensitiveOption);
    if (cookieDecryptRe.match(line).hasMatch())
        return QStringLiteral("Windows blocked reading the browser's cookies — use the "
                              "“Download with Nexa” button in the extension (it reads your login)");

    static const QRegularExpression loginRe(
        QStringLiteral("login required|you must be logged in|requires? (a )?(subscription|login|account)|"
                       "this course requires|members[- ]only|private video|account.*(required|cookies)"),
        QRegularExpression::CaseInsensitiveOption);
    if (loginRe.match(line).hasMatch())
        return QStringLiteral("login required — provide cookies or a token");

    // Udemy: yt-dlp's extractor scrapes the course page for a course id, but
    // modern Udemy is a login-walled SPA that no longer exposes it (and course
    // videos are DRM-protected), so whole-course downloads cannot work. Give an
    // honest reason rather than yt-dlp's raw "report this issue" text.
    static const QRegularExpression udemyRe(
        QStringLiteral("udemy.*(unable to extract course id|course id)|unable to extract course id"),
        QRegularExpression::CaseInsensitiveOption);
    if (udemyRe.match(line).hasMatch())
        return QStringLiteral("Udemy course download is not supported (yt-dlp can't read "
                              "Udemy's DRM-protected course content)");
    // Apple Music: every track/album/playlist is FairPlay-DRM encrypted, so no
    // downloader (yt-dlp included) can fetch the audio — yt-dlp reports it as an
    // "Unsupported URL" rather than a DRM error, so match the host explicitly and
    // give the real reason instead of the misleading generic message.
    static const QRegularExpression appleMusicRe(
        QStringLiteral("music\\.apple\\.com|apple music"),
        QRegularExpression::CaseInsensitiveOption);
    if (appleMusicRe.match(line).hasMatch())
        return QStringLiteral("Apple Music tracks are FairPlay-DRM protected and "
                              "cannot be downloaded");

    // DRM is a hard blocker for any site: yt-dlp cannot decrypt protected media.
    static const QRegularExpression drmRe(
        QStringLiteral("DRM|widevine|fairplay|protected.*content|this video is drm"),
        QRegularExpression::CaseInsensitiveOption);
    if (drmRe.match(line).hasMatch())
        return QStringLiteral("DRM-protected video — cannot be downloaded");

    return QString();
}

QString withCredentialHint(const QString &why, const QStringList &authArgs, const QUrl &url)
{
    static const QRegularExpression loginRe(
        QStringLiteral("authentication required|login required|sign-in required"),
        QRegularExpression::CaseInsensitiveOption);
    if (!authArgs.isEmpty() || isYouTubeHost(url.host()) || !loginRe.match(why).hasMatch())
        return why;
    return why + QStringLiteral(" — use the Nexa button on the page in your browser "
                                "so your login is sent with it");
}

} // namespace nexa
