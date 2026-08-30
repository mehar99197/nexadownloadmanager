#pragma once

#include <QObject>
#include <QString>
#include <QStringList>

namespace nexa {

// Optional post-download malware scan. Nexa does NOT bundle an engine; it drives
// whatever the machine already has (Microsoft Defender on Windows, ClamAV
// elsewhere) or any command the user configures.
//
// The command template uses %1 for the file path, e.g.
//   clamscan --no-summary %1
// A non-zero exit status means "infected/suspicious" for both Defender and
// clamscan, which is the convention this class relies on.
class VirusScanner : public QObject {
    Q_OBJECT
public:
    explicit VirusScanner(QObject *parent = nullptr);

    // Whether scanning is switched on AND a usable command exists.
    static bool enabled();
    // The configured template, or the platform default when unset.
    static QString commandTemplate();
    static QString defaultCommandTemplate();
    // True when the scanner named by the template is actually present.
    static bool scannerAvailable();

    // Scan one finished file. Emits exactly one of the signals below.
    void scan(int downloadId, const QString &filePath);

signals:
    void clean(int downloadId, const QString &filePath);
    void infected(int downloadId, const QString &filePath, const QString &detail);
    // Could not run (no scanner, timed out, crashed) — never treated as "clean".
    void unavailable(int downloadId, const QString &filePath, const QString &why);

private:
    static QStringList splitCommand(const QString &tmpl, const QString &filePath);
};

} // namespace nexa
