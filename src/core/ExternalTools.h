#pragma once

#include <QCoreApplication>
#include <QHash>
#include <QProcess>
#include <QStandardPaths>
#include <QString>
#include <QStringList>

namespace nexa {

// Resolve a bundled external tool (yt-dlp, ffmpeg) to an absolute path.
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

// Can this binary actually START? findExecutable() answers "a file is there and
// the +x bit is set", which a binary whose shared libraries are missing also
// satisfies: the kernel execs it, the dynamic loader fails, and it exits 127.
// A .deb once shipped an ffmpeg like that, and because the bundled copy is
// preferred it SHADOWED the working system ffmpeg — installing one changed
// nothing, and yt-dlp merged no YouTube video on any machine. Probing costs one
// short-lived process per tool per run, cached either way, so a broken bundle
// degrades to whatever is on PATH instead of disabling the feature outright.
inline bool toolCanRun(const QString &path)
{
    static QHash<QString, bool> cache;
    const auto it = cache.constFind(path);
    if (it != cache.constEnd())
        return *it;

    // ffmpeg/ffprobe take -version, yt-dlp takes --version; a loader failure
    // exits 127 for either, so one success is enough.
    bool ok = false;
    for (const QString &flag : {QStringLiteral("-version"), QStringLiteral("--version")}) {
        QProcess p;
        p.setProcessChannelMode(QProcess::MergedChannels);
        p.start(path, QStringList{flag});
        if (p.waitForStarted(2000) && p.waitForFinished(3000)
            && p.exitStatus() == QProcess::NormalExit && p.exitCode() == 0) {
            ok = true;
            break;
        }
        if (p.state() != QProcess::NotRunning) {
            p.kill();
            p.waitForFinished(1000);
        }
    }
    cache.insert(path, ok);
    return ok;
}

inline QString resolveTool(const QString &name)
{
    // findExecutable() appends the platform-native suffix (.exe on Windows)
    // itself; given an explicit search list it looks ONLY there, so probe the
    // app directory first and the real PATH second.
    const QString appDir = QCoreApplication::applicationDirPath();
    QString bundled;
    if (!appDir.isEmpty()) {
        bundled = QStandardPaths::findExecutable(name, QStringList{appDir});
        if (!bundled.isEmpty() && toolCanRun(bundled))
            return bundled;
    }
    const QString onPath = QStandardPaths::findExecutable(name);
    if (!onPath.isEmpty() && onPath != bundled && toolCanRun(onPath))
        return onPath;
    // Nothing runs. Hand back the bundled path anyway so the caller's own
    // "is it installed?" branch and the error it surfaces name a real file.
    return bundled.isEmpty() ? onPath : bundled;
}

} // namespace nexa
