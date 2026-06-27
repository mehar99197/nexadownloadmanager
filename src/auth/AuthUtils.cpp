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
    if (const auto m = httpRe.match(line); m.hasMatch())
        return QStringLiteral("authentication required (HTTP %1)").arg(m.captured(1));

    static const QRegularExpression botRe(QStringLiteral("Sign in to confirm you.*bot"),
                                          QRegularExpression::CaseInsensitiveOption);
    if (botRe.match(line).hasMatch())
        return QStringLiteral("sign-in required — re-export cookies");

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
