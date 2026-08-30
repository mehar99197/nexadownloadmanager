#pragma once
#include <QString>
#include <QByteArray>
#include <QList>
#include <QPair>
#include <QMetaType>

namespace nexa {

// Raw HTTP headers to replay on every request for a download (cookies,
// User-Agent, Referer, Authorization, ...). Captured by the browser extension
// so authenticated / CDN-protected links don't 403.
using HeaderList = QList<QPair<QByteArray, QByteArray>>;

// Lifecycle of a single download.
enum class DownloadState {
    Queued,
    Probing,      // fetching size / range support
    Downloading,
    Paused,
    Completed,
    Error
};

inline QString stateToString(DownloadState s) {
    switch (s) {
        case DownloadState::Queued:      return QStringLiteral("Queued");
        case DownloadState::Probing:     return QStringLiteral("Probing");
        case DownloadState::Downloading: return QStringLiteral("Downloading");
        case DownloadState::Paused:      return QStringLiteral("Paused");
        case DownloadState::Completed:   return QStringLiteral("Completed");
        case DownloadState::Error:       return QStringLiteral("Error");
    }
    return QStringLiteral("Unknown");
}

// One byte-range of a download. `end` is inclusive (HTTP Range semantics).
struct SegmentInfo {
    int    index = 0;
    qint64 start = 0;
    qint64 end   = 0;   // inclusive
    qint64 done  = 0;   // bytes already written for this segment

    qint64 length() const { return end - start + 1; }
    bool   complete() const { return done >= length(); }
};

// One candidate link harvested from a web page by the browser extension
// ("Download all links" / "Grab media"), shown in the link-grabber dialog.
struct LinkItem {
    QString url;
    QString text;   // anchor text / alt text (may be empty)
    QString kind;   // "link" | "image" | "media"
};

// Hash verification result for completed downloads.
// Stores the computed SHA-256 hash and whether it matched an expected value.
struct HashVerification {
    QString sha256;              // Hex-encoded SHA-256 hash of the downloaded file
    bool    verified = false;    // True if expectedSha256 was set and matched
    bool    hasExpected = false; // True if an expected hash was provided
};

} // namespace nexa

Q_DECLARE_METATYPE(nexa::DownloadState)
