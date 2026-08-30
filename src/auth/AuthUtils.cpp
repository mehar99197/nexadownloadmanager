#include "auth/AuthUtils.h"

#include <QRegularExpression>

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
        if (m.captured(1) == QLatin1String("403") && mediaStageRe.match(line).hasMatch())
            return QStringLiteral("media server refused the download (HTTP 403) — the "
                                  "stream URL expired or yt-dlp is out of date. Update "
                                  "yt-dlp, then retry (this is not a login problem)");
        return QStringLiteral("authentication required (HTTP %1)").arg(m.captured(1));
    }

    static const QRegularExpression botRe(QStringLiteral("Sign in to confirm you.*bot"),
                                          QRegularExpression::CaseInsensitiveOption);
    if (botRe.match(line).hasMatch())
        return QStringLiteral("sign-in required — re-export cookies");

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

} // namespace nexa
