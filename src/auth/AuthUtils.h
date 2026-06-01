#pragma once
#include <QString>

namespace nexa {

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
