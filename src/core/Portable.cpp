#include "core/Portable.h"

#include <QCoreApplication>
#include <QDir>
#include <QFileInfo>
#include <QSettings>
#include <QStandardPaths>

namespace nexa::portable {

namespace {
bool g_checked = false;
bool g_portable = false;

QString markerPath()
{
    return QDir(QCoreApplication::applicationDirPath()).absoluteFilePath(QStringLiteral("portable.txt"));
}
} // namespace

bool isPortable()
{
    if (!g_checked) {
        g_checked = true;
        // Portable only counts when we can actually WRITE beside the executable;
        // an installed copy under /usr or Program Files must never try.
        const QFileInfo marker(markerPath());
        g_portable = marker.exists()
                     && QFileInfo(QCoreApplication::applicationDirPath()).isWritable();
    }
    return g_portable;
}

QString dataDir()
{
    if (!isPortable())
        return QString();
    const QString dir = QDir(QCoreApplication::applicationDirPath())
                            .absoluteFilePath(QStringLiteral("NexaData"));
    QDir().mkpath(dir);
    return dir;
}

QString appDataDir()
{
    if (isPortable())
        return dataDir();
    QString dir = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
    if (dir.isEmpty())
        dir = QStandardPaths::writableLocation(QStandardPaths::TempLocation);
    return dir;
}

void initialise()
{
    if (!isPortable())
        return;
    // Everything QSettings writes now lands in <app dir>/NexaData/Nexa/Nexa.ini.
    QSettings::setDefaultFormat(QSettings::IniFormat);
    QSettings::setPath(QSettings::IniFormat, QSettings::UserScope, dataDir());
    QSettings::setPath(QSettings::IniFormat, QSettings::SystemScope, dataDir());
}

} // namespace nexa::portable
