#pragma once
#include <QString>
#include <QByteArray>

namespace nexa {

// Headers that must never cross a credential-scope boundary: sending them to a
// host other than the one they were captured for leaks the user's session to a
// CDN or third party. Referer is included because it discloses the originating
// page. One definition, so a new call site cannot quietly disagree with the
// download paths that already get this right.
inline bool isSensitiveHeader(const QByteArray &name)
{
    const QByteArray lower = name.toLower();
    return lower == QByteArrayLiteral("cookie")
        || lower == QByteArrayLiteral("authorization")
        || lower == QByteArrayLiteral("referer")
        || lower == QByteArrayLiteral("proxy-authorization")
        || lower == QByteArrayLiteral("x-api-key")
        || lower == QByteArrayLiteral("x-csrf-token");
}

// The subset of the above that is an actual SECRET rather than context. These
// must additionally never reach a child process's command line, because argv is
// readable by other processes on the machine. Referer/Origin are deliberately
// excluded: they are URLs, not secrets, and CDNs need them for hotlink
// protection.
inline bool isCredentialHeader(const QByteArray &name)
{
    const QByteArray lower = name.toLower();
    return lower == QByteArrayLiteral("cookie")
        || lower == QByteArrayLiteral("authorization")
        || lower == QByteArrayLiteral("proxy-authorization")
        || lower == QByteArrayLiteral("x-api-key")
        || lower == QByteArrayLiteral("x-csrf-token");
}

// Auth classification helpers, kept as free functions in a LEAF header so the
// download classes (SegmentDownloader / DownloadTask / YtDlpGrabber) can detect
// and describe auth failures while depending ONLY on this tiny header — never on
// AuthenticationManager. That preserves the one-way dependency the design
// requires: download classes -> AuthUtils, and AuthenticationManager -> AuthUtils,
// but never download classes -> AuthenticationManager.

// HTTP 401/403 are the auth-failure statuses both download paths classify
// identically. Trivial, so inline.
inline bool authIsStatus(int httpStatus) { return httpStatus == 401 || httpStatus == 403; }

// A uniform, UI-ready detail string for an auth-failed HTTP status.
QString authErrorDetail(int httpStatus);

// Scan a yt-dlp stderr line for an auth failure (HTTP 401/403, login/subscription
// required, course-access errors, YouTube's bot check). Returns a UI-ready reason,
// or an empty string if the line is not an auth error.
QString authReasonFromYtDlpLine(const QString &line);

} // namespace nexa
