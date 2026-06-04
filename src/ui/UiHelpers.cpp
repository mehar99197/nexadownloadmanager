#include "ui/UiHelpers.h"

#include <QLabel>
#include <QProgressBar>
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
    switch (s) {
        case DownloadState::Completed:   return QColor(0x34d399);  // emerald
        case DownloadState::Downloading: return QColor(0x22d3ee);  // cyan (brand)
        case DownloadState::Probing:     return QColor(0xa78bfa);  // violet (brand)
        case DownloadState::Paused:      return QColor(0xfbbf24);  // amber
        case DownloadState::Error:       return QColor(0xfb7185);  // rose
        case DownloadState::Queued:      return QColor(0x94a3b8);  // grey
    }
    return QColor(0xe8edf4);
}

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
        return { QColor(0x8b5cf6), badge };                       // video  - violet
    if (has({"mp3", "m4a", "aac", "opus", "wav", "flac", "ogg"}))
        return { QColor(0xec4899), badge };                       // audio  - pink
    if (has({"png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "heic",
             "tar", "gz", "tgz"}))
        return { QColor(0x14b8a6), badge };                       // images/tar - teal
    if (has({"zip", "rar", "7z", "bz2", "xz"}))
        return { QColor(0xf59e0b), badge };                       // archives - amber
    if (has({"pdf", "doc", "docx", "txt", "rtf", "md", "csv",
             "xls", "xlsx", "ppt", "pptx"}))
        return { QColor(0x3b82f6), badge };                       // docs   - blue
    return { QColor(0x64748b), badge };                           // other  - slate
}

void paintIcon(QLabel *icon, const QString &name)
{
    const Accent a = fileAccent(name);
    icon->setText(a.badge);
    icon->setStyleSheet(QStringLiteral(
        "background: rgba(%1,%2,%3,38); color: rgb(%1,%2,%3); "
        "border-radius: 9px; font-weight: 700; font-size: 10px;")
        .arg(a.color.red()).arg(a.color.green()).arg(a.color.blue()));
}

void paintBar(QProgressBar *bar, const QColor &c)
{
    bar->setStyleSheet(QStringLiteral(
        "QProgressBar { background: #1b222c; border: 0; border-radius: 3px; } "
        "QProgressBar::chunk { background: %1; border-radius: 3px; }")
        // Active downloads use the brand cyan→purple gradient; other states keep
        // their solid semantic colour (done=emerald, paused=amber, error=rose).
        .arg(c == QColor(0x22d3ee)
                 ? QStringLiteral("qlineargradient(x1:0,y1:0,x2:1,y2:0,"
                                  "stop:0 #22d3ee, stop:1 #8b5cf6)")
                 : c.name()));
}

} // namespace nexa
