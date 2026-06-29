#pragma once

#include <QCoreApplication>
#include <QStandardPaths>
#include <QString>
#include <QStringList>

namespace nexa {

// Resolve a bundled external tool (yt-dlp, ffmpeg, aria2c) to an absolute path.
//
// Why this exists: Nexa ships these binaries NEXT TO its own executable. The
// Windows NSIS installer drops yt-dlp.exe / ffmpeg.exe into $INSTDIR alongside
// nexa.exe, and a portable build keeps them in the same folder. That directory
// is NOT on PATH on Windows, so QStandardPaths::findExecutable(name) — which
// searches PATH only — returns empty even though the tool is right there.
//
// That asymmetry was the Windows-only download bug: YtDlpGrabber::available()
// (and the IPC qualities probe) called the PATH-only lookup, reported "no
// yt-dlp", and so YouTube / Udemy / playlist URLs fell through to the plain HTTP
// path and failed with "the server returned a web page, not a file". On Linux
// the .deb wrapper puts /usr/lib/nexa on PATH, so the same lookup happened to
// work — hence the bug only showed on Windows.
//
// Fix: search the application directory FIRST, then fall back to PATH (which
// covers the Linux .deb wrapper and a dev machine's system-installed tool).
// Returns an empty string if the tool is found nowhere.
inline QString resolveTool(const QString &name)
{
    // findExecutable() appends the platform-native suffix (.exe on Windows)
    // itself; given an explicit search list it looks ONLY there, so probe the
    // app directory first and the real PATH second.
    const QString appDir = QCoreApplication::applicationDirPath();
    if (!appDir.isEmpty()) {
        const QString bundled =
            QStandardPaths::findExecutable(name, QStringList{appDir});
        if (!bundled.isEmpty())
            return bundled;
    }
    return QStandardPaths::findExecutable(name);   // PATH + system dirs
}

} // namespace nexa
