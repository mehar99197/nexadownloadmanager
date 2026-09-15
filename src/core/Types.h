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

// Make a filename safe on Windows, wherever it was produced.
//
// Two Win32 rules that no amount of character filtering catches:
//
//  - A handful of legacy DEVICE names are reserved — CON, PRN, AUX, NUL,
//    COM0-9, LPT0-9 — and they stay reserved with an extension attached.
//    Opening "NUL.mp4" for writing does not create a file; it writes to the
//    null device. A download named that by its Content-Disposition, its page,
//    or a torrent would report complete with nothing on disk.
//  - Trailing dots and spaces are silently stripped, so "video." and "video"
//    are the same file. Two downloads that look distinct then clobber one
//    another, and a name that ends in a dot never matches what was asked for.
//
// Applied on every platform deliberately. A name that is dangerous on Windows
// is merely odd on Linux, and a Downloads folder is routinely synced or shared
// between the two — what lands there should not depend on which machine wrote
// it. A reserved name is prefixed rather than dropped so the user still
// recognises their file.
//
// Callers own their own character filtering: the engine strips shell-ish
// punctuation from untrusted names, while an explicit user rename keeps
// parentheses and commas. Only these two rules are shared.
inline QString makeFileNamePortable(QString name)
{
    while (!name.isEmpty() && (name.endsWith(QLatin1Char('.')) || name.endsWith(QLatin1Char(' '))))
        name.chop(1);
    if (name.isEmpty())
        return name;

    static const char *const kReserved[] = {
        "CON", "PRN", "AUX", "NUL",
        "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    };
    // Win32 matches on the stem before the FIRST dot, so "NUL.tar.gz" is the
    // null device too.
    const int dot = name.indexOf(QLatin1Char('.'));
    const QString stem = (dot < 0 ? name : name.left(dot)).toUpper();
    for (const char *reserved : kReserved) {
        if (stem == QLatin1String(reserved))
            return QLatin1Char('_') + name;
    }
    return name;
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
