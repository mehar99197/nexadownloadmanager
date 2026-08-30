#pragma once
#include <QString>
#include <QColor>
#include "core/Types.h"   // nexa::DownloadState

class QLabel;

namespace nexa {

// Formatting + theming helpers shared by MainWindow and DownloadDetailsDialog.

QString humanSize(qint64 bytes);              // "1.5 MB"; "?" for negative
QString humanSpeed(double bytesPerSec);       // "1.5 MB/s"; "" when bps < 1.0
QString humanTime(qint64 seconds);            // "12s", "1m 23s", "2h 04m", "—" if <0

// A distinct colour per lifecycle state (status dot + progress chunk).
QColor  statusColor(DownloadState s);
// Theme-aware neutrals for table cells and secondary text (follow light/dark).
QColor mutedTextColor();
QColor valueTextColor();
// Short, mockup-style status word ("Completed" -> "Complete").
QString statusLabel(DownloadState s);

// File-type accent: a tint colour + a short uppercase extension badge.
struct Accent { QColor color; QString badge; };
Accent  fileAccent(const QString &name);

// Paint a rounded, tinted file-type tile (badge text) onto a QLabel.
void paintIcon(QLabel *icon, const QString &name);

} // namespace nexa
