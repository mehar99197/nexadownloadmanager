#include "shell/ShellIntegration.h"
#include "core/Portable.h"

#include <QCoreApplication>
#include <QDir>
#include <QFileInfo>
#include <QSettings>
#include <QStringList>

namespace nexa::shellint {

#ifdef Q_OS_WIN

namespace {

// One ProgId for everything Nexa opens from Explorer. Versioning it would mean
// every upgrade leaves a dead one behind.
const QString kProgId  = QStringLiteral("Nexa.Download");
// The verb key name. Prefixed, because this lives in a namespace shared with
// every other program on the machine.
const QString kVerbKey = QStringLiteral("NexaNewDownload");

// Empty except under test; see setClassesRootForTesting.
QString g_classesRootOverride;

QString classesRoot()
{
    if (!g_classesRootOverride.isEmpty())
        return g_classesRootOverride;
    return QStringLiteral("HKEY_CURRENT_USER\\Software\\Classes");
}

// The file types Nexa can actually do something with when handed a path. Kept
// short on purpose: offering to open a type we would only fail on is worse than
// not appearing in the menu at all.
QStringList handledExtensions()
{
    return { QStringLiteral(".torrent"),     // TorrentManager
             QStringLiteral(".ef2"),         // IDM export        -> DownloadImport
             QStringLiteral(".crawljob") };  // JDownloader queue -> DownloadImport
}

QString exePath()
{
    return QDir::toNativeSeparators(QCoreApplication::applicationFilePath());
}

// Wrap in double quotes. An unquoted path containing a space is the classic way
// a shell verb silently launches the wrong executable.
QString quoted(const QString &s)
{
    const QChar dq(0x22);
    return dq + s + dq;
}

bool writeDefault(const QString &path, const QString &value)
{
    QSettings s(path, QSettings::NativeFormat);
    // QSettings spells the registry's unnamed default value "." -- this is not
    // a value literally called "dot".
    s.setValue(QStringLiteral("."), value);
    s.sync();
    return s.status() == QSettings::NoError;
}

QString readDefault(const QString &path)
{
    QSettings s(path, QSettings::NativeFormat);
    return s.value(QStringLiteral(".")).toString();
}

// The command Explorer runs for the "new download here" verb. %V is the folder
// the menu was opened on; Explorer substitutes it before we ever see it, so it
// is quoted for the same reason the executable path is.
QString newDownloadCommand()
{
    return quoted(exePath()) + QStringLiteral(" --new-download --dir ")
         + quoted(QStringLiteral("%V"));
}

// Write one "New download with Nexa" verb under `parent`, a shell container key
// such as Directory\Background.
bool writeVerb(const QString &parent, const QString &label)
{
    const QString key = classesRoot() + QLatin1Char('\\') + parent
                      + QStringLiteral("\\shell\\") + kVerbKey;
    bool ok = writeDefault(key, label);
    {
        QSettings s(key, QSettings::NativeFormat);
        s.setValue(QStringLiteral("Icon"), exePath() + QStringLiteral(",0"));
        s.sync();
        ok = ok && s.status() == QSettings::NoError;
    }
    ok = writeDefault(key + QStringLiteral("\\command"), newDownloadCommand()) && ok;
    return ok;
}

bool removeKey(const QString &path)
{
    QSettings s(path, QSettings::NativeFormat);
    s.remove(QString());   // the key and everything under it
    s.sync();
    return s.status() == QSettings::NoError;
}

QString verbCommandKey(const QString &parent)
{
    return classesRoot() + QLatin1Char('\\') + parent
         + QStringLiteral("\\shell\\") + kVerbKey + QStringLiteral("\\command");
}

QStringList verbParents()
{
    return { QStringLiteral("Directory\\Background"),   // empty space in a folder
             QStringLiteral("Directory"),               // the folder icon itself
             QStringLiteral("Drive\\Background") };     // the root of a drive
}

} // namespace

void setClassesRootForTesting(const QString &root)
{
    g_classesRootOverride = root;
}

Report registerShellIntegration()
{
    Report report;

    if (portable::isPortable()) {
        report.entries.append({ QStringLiteral("Explorer integration"), false,
                                QStringLiteral("skipped in portable mode") });
        return report;
    }

    const QString exe = exePath();
    if (exe.isEmpty() || !QFileInfo::exists(exe)) {
        report.entries.append({ QStringLiteral("Explorer integration"), false,
                                QStringLiteral("this executable could not be located") });
        return report;
    }

    // ---- the ProgId every entry below points at --------------------------
    const QString progKey = classesRoot() + QLatin1Char('\\') + kProgId;
    bool progOk = writeDefault(progKey, QStringLiteral("Nexa Download Manager"));
    progOk = writeDefault(progKey + QStringLiteral("\\DefaultIcon"),
                          exe + QStringLiteral(",0")) && progOk;
    progOk = writeDefault(progKey + QStringLiteral("\\shell\\open\\command"),
                          quoted(exe) + QLatin1Char(' ')
                              + quoted(QStringLiteral("%1"))) && progOk;
    report.entries.append({ QStringLiteral("Open with Nexa"), progOk,
                            progOk ? exe : QStringLiteral("could not be written") });
    if (!progOk)
        return report;   // the extensions below would point at a ProgId that is not there

    // ---- file types, via OpenWithProgids (never stealing the default) ----
    for (const QString &ext : handledExtensions()) {
        QSettings s(classesRoot() + QLatin1Char('\\') + ext
                        + QStringLiteral("\\OpenWithProgids"),
                    QSettings::NativeFormat);
        // An EMPTY value is the documented shape here: the NAME of the value is
        // the ProgId, and its contents are ignored.
        s.setValue(kProgId, QString());
        s.sync();
        const bool ok = s.status() == QSettings::NoError;
        report.entries.append({ ext, ok,
                                ok ? QStringLiteral("listed under Open with")
                                   : QStringLiteral("could not be written") });
    }

    // ---- the folder context menus ----------------------------------------
    const bool bgOk = writeVerb(QStringLiteral("Directory\\Background"),
                                QStringLiteral("New download with Nexa"));
    report.entries.append({ QStringLiteral("Folder background menu"), bgOk,
                            bgOk ? QStringLiteral("right-click inside a folder")
                                 : QStringLiteral("could not be written") });

    const bool dirOk = writeVerb(QStringLiteral("Directory"),
                                 QStringLiteral("Download to this folder with Nexa"));
    report.entries.append({ QStringLiteral("Folder menu"), dirOk,
                            dirOk ? QStringLiteral("right-click a folder")
                                  : QStringLiteral("could not be written") });

    const bool drvOk = writeVerb(QStringLiteral("Drive\\Background"),
                                 QStringLiteral("New download with Nexa"));
    report.entries.append({ QStringLiteral("Drive background menu"), drvOk,
                            drvOk ? QStringLiteral("right-click inside a drive")
                                  : QStringLiteral("could not be written") });

    return report;
}

bool unregisterShellIntegration()
{
    bool ok = true;
    for (const QString &parent : verbParents()) {
        ok = removeKey(classesRoot() + QLatin1Char('\\') + parent
                       + QStringLiteral("\\shell\\") + kVerbKey) && ok;
    }
    for (const QString &ext : handledExtensions()) {
        QSettings s(classesRoot() + QLatin1Char('\\') + ext
                        + QStringLiteral("\\OpenWithProgids"),
                    QSettings::NativeFormat);
        // Remove only OUR value. This key is shared with every other program
        // that offers to open the type, so deleting the key itself would take
        // their entries with it.
        s.remove(kProgId);
        s.sync();
        ok = (s.status() == QSettings::NoError) && ok;
    }
    ok = removeKey(classesRoot() + QLatin1Char('\\') + kProgId) && ok;
    return ok;
}

bool isRegistered()
{
    if (portable::isPortable())
        return false;
    const QString want = quoted(exePath());
    const QString have = readDefault(classesRoot() + QLatin1Char('\\') + kProgId
                                     + QStringLiteral("\\shell\\open\\command"));
    if (!have.startsWith(want, Qt::CaseInsensitive))
        return false;
    // The verb matters as much as the ProgId: an upgrade that moved the exe
    // leaves both of them stale, and answering "registered" then would stop the
    // launch-time refresh from ever repairing it.
    const QString verb = readDefault(verbCommandKey(QStringLiteral("Directory\\Background")));
    return verb.startsWith(want, Qt::CaseInsensitive);
}

#else   // every other platform: no-ops, so callers need no #ifdef

Report registerShellIntegration()   { return {}; }
bool   unregisterShellIntegration() { return true; }
bool   isRegistered()               { return false; }
void   setClassesRootForTesting(const QString &) {}

#endif

} // namespace nexa::shellint
