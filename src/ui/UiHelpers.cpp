#include "ui/UiHelpers.h"
#include "ui/Theme.h"

#include <QLabel>
#include <QFileInfo>
#include <initializer_list>

namespace nexa {

QString humanSize(qint64 bytes)
{
    if (bytes < 0) return QStringLiteral("?");
    const char *units[] = {"B", "KB", "MB", "GB", "TB"};
    double v = double(bytes);
    int u = 0;
    while (v >= 1024.0 && u < 4) { v /= 1024.0; ++u; }
    return QStringLiteral("%1 %2").arg(v, 0, 'f', (u == 0 ? 0 : 1)).arg(units[u]);
}

QString humanSpeed(double bps)
{
    if (bps < 1.0) return QString();
    return humanSize(qint64(bps)) + QStringLiteral("/s");
}

QString humanTime(qint64 s)
{
    if (s < 0) return QStringLiteral("—");
    if (s < 60)    return QStringLiteral("%1s").arg(s);
    if (s < 3600)  return QStringLiteral("%1m %2s").arg(s / 60).arg(s % 60, 2, 10, QChar('0'));
    if (s < 86400) return QStringLiteral("%1h %2m").arg(s / 3600).arg((s % 3600) / 60, 2, 10, QChar('0'));
    return QStringLiteral("%1d %2h").arg(s / 86400).arg((s % 86400) / 3600);
}

QColor statusColor(DownloadState s)
{
    // Taken from the active theme so the light palette's darker, contrast-checked
    // status colours are used on a white ground instead of the neon dark ones.
    const theme::Palette &p = theme::current();
    switch (s) {
        case DownloadState::Completed:   return QColor(p.doneFg);
        case DownloadState::Downloading: return QColor(p.activeFg);
        case DownloadState::Probing:     return QColor(p.accent);
        case DownloadState::Paused:      return QColor(p.pausedFg);
        case DownloadState::Error:       return QColor(p.errorFg);
        case DownloadState::Queued:      return QColor(p.queuedFg);
    }
    return QColor(p.text);
}

QColor mutedTextColor() { return QColor(theme::current().textFaint); }
QColor valueTextColor() { return QColor(theme::current().text); }

QString statusLabel(DownloadState s)
{
    return s == DownloadState::Completed ? QStringLiteral("Complete")
                                         : stateToString(s);
}

Accent fileAccent(const QString &name)
{
    const QString ext = QFileInfo(name).suffix().toLower();
    auto has = [&](std::initializer_list<const char *> xs) {
        for (auto x : xs) if (ext == QLatin1String(x)) return true;
        return false;
    };
    const QString badge = ext.isEmpty() ? QStringLiteral("FILE")
                                        : ext.left(4).toUpper();
    if (has({"mp4", "mkv", "mov", "webm", "avi", "ts", "m4v", "flv", "wmv"}))
        return { QColor(0xa374ff), badge };                       // video  - violet
    if (has({"mp3", "m4a", "aac", "opus", "wav", "flac", "ogg"}))
        return { QColor(0xf28ac8), badge };                       // audio  - pink
    if (has({"png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "heic"}))
        return { QColor(0x45dfc1), badge };                       // images - mint
    if (has({"zip", "rar", "7z", "bz2", "xz", "tar", "gz", "tgz"}))
        return { QColor(0xf6c76b), badge };                       // archives - amber
    if (has({"pdf", "doc", "docx", "txt", "rtf", "md", "csv",
             "xls", "xlsx", "ppt", "pptx"}))
        return { QColor(0x65b9ff), badge };                       // docs   - blue
    return { QColor(0x7180a2), badge };                           // other  - slate
}

void paintIcon(QLabel *icon, const QString &name)
{
    const Accent a = fileAccent(name);
    // The type hues are tuned for a dark ground; on a light theme the same hue
    // is darkened until the badge letters stay readable on their own tint.
    QColor ink = a.color;
    if (!theme::isDark())
        ink = QColor(int(ink.red() * 0.62), int(ink.green() * 0.58), int(ink.blue() * 0.62));
    icon->setText(a.badge);
    icon->setStyleSheet(QStringLiteral(
        "background: rgba(%1,%2,%3,%7); color: rgb(%4,%5,%6); "
        "border: 1px solid rgba(%1,%2,%3,90); border-radius: 9px; "
        "font-weight: 700; font-size: 10px;")
        .arg(a.color.red()).arg(a.color.green()).arg(a.color.blue())
        .arg(ink.red()).arg(ink.green()).arg(ink.blue())
        .arg(theme::isDark() ? 34 : 28));
}

} // namespace nexa
