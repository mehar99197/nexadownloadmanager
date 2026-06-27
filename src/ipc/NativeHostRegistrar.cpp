#include "ipc/NativeHostRegistrar.h"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QString>
#include <QStringList>

#ifdef Q_OS_WIN
#  include <QSettings>
#endif

namespace {

// Stable identifiers — must match the shipped extensions.
//  * Chrome/Chromium/Edge/Brave: pinned by the "key" field in
//    extension-chromium/manifest.json, so the unpacked id is always this.
//  * Firefox: the gecko id from extension-firefox/manifest.json.
const QString kHostName      = QStringLiteral("com.nexa.host");
const QString kChromeExtId   = QStringLiteral("cbogjffoidaepbcbogbfibnldhkckhpb");
const QString kFirefoxExtId  = QStringLiteral("nexa@nexa.local");
const QString kDescription   = QStringLiteral("Nexa Download Manager native messaging host");

// Absolute path to the nexa-host binary that sits next to the running app.
QString hostBinaryPath()
{
    const QDir dir(QCoreApplication::applicationDirPath());
#ifdef Q_OS_WIN
    const QString bin = dir.absoluteFilePath(QStringLiteral("nexa-host.exe"));
#else
    const QString bin = dir.absoluteFilePath(QStringLiteral("nexa-host"));
#endif
    return QDir::toNativeSeparators(bin);
}

QByteArray manifestJson(const QString &hostBin, bool firefox)
{
    QJsonObject o;
    o.insert(QStringLiteral("name"),        kHostName);
    o.insert(QStringLiteral("description"), kDescription);
    o.insert(QStringLiteral("path"),        hostBin);
    o.insert(QStringLiteral("type"),        QStringLiteral("stdio"));
    if (firefox)
        o.insert(QStringLiteral("allowed_extensions"),
                 QJsonArray{ kFirefoxExtId });
    else
        o.insert(QStringLiteral("allowed_origins"),
                 QJsonArray{ QStringLiteral("chrome-extension://%1/").arg(kChromeExtId) });
    return QJsonDocument(o).toJson(QJsonDocument::Indented);
}

// Write the manifest into a browser's NativeMessagingHosts directory, but only
// rewrite when the content actually changed — keeps startup cheap and avoids
// needless disk churn on every launch.
bool writeManifestTo(const QString &dirPath, const QByteArray &json)
{
    QDir().mkpath(dirPath);
    const QString file = QDir(dirPath).absoluteFilePath(kHostName + QStringLiteral(".json"));

    QFile existing(file);
    if (existing.exists() && existing.open(QIODevice::ReadOnly)) {
        if (existing.readAll() == json)
            return true;                       // already up to date
        existing.close();
    }

    QFile f(file);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate))
        return false;
    f.write(json);
    return true;
}

} // namespace

namespace nexa {

void registerNativeHost()
{
    const QString hostBin = hostBinaryPath();
    if (!QFileInfo::exists(hostBin))
        return;   // host not built/installed beside us — nothing to point at

    const QByteArray chrome  = manifestJson(hostBin, /*firefox=*/false);
    const QByteArray firefox = manifestJson(hostBin, /*firefox=*/true);

#if defined(Q_OS_WIN)
    // Windows finds the manifest via an HKCU registry value that points at the
    // JSON file, so write the file next to the binary and register the path.
    const QDir appDir(QCoreApplication::applicationDirPath());
    const QString chromeFile  = appDir.absoluteFilePath(QStringLiteral("com.nexa.host.json"));
    const QString firefoxFile = appDir.absoluteFilePath(QStringLiteral("com.nexa.host.firefox.json"));
    { QFile f(chromeFile);  if (f.open(QIODevice::WriteOnly | QIODevice::Truncate)) f.write(chrome); }
    { QFile f(firefoxFile); if (f.open(QIODevice::WriteOnly | QIODevice::Truncate)) f.write(firefox); }

    const QString chromeNative  = QDir::toNativeSeparators(chromeFile);
    const QString firefoxNative = QDir::toNativeSeparators(firefoxFile);

    const QStringList chromeKeys = {
        QStringLiteral("HKEY_CURRENT_USER\\Software\\Google\\Chrome"),
        QStringLiteral("HKEY_CURRENT_USER\\Software\\Chromium"),
        QStringLiteral("HKEY_CURRENT_USER\\Software\\Microsoft\\Edge"),
        QStringLiteral("HKEY_CURRENT_USER\\Software\\BraveSoftware\\Brave-Browser"),
    };
    for (const QString &base : chromeKeys) {
        QSettings s(base + QStringLiteral("\\NativeMessagingHosts\\") + kHostName,
                    QSettings::NativeFormat);
        s.setValue(QStringLiteral("."), chromeNative);   // "." == the key's default value
    }
    {
        QSettings s(QStringLiteral("HKEY_CURRENT_USER\\Software\\Mozilla\\NativeMessagingHosts\\") + kHostName,
                    QSettings::NativeFormat);
        s.setValue(QStringLiteral("."), firefoxNative);
    }
#elif defined(Q_OS_MACOS)
    const QString base = QDir::homePath() + QStringLiteral("/Library/Application Support");
    const QStringList chromeDirs = {
        base + QStringLiteral("/Google/Chrome/NativeMessagingHosts"),
        base + QStringLiteral("/Chromium/NativeMessagingHosts"),
        base + QStringLiteral("/Microsoft Edge/NativeMessagingHosts"),
        base + QStringLiteral("/BraveSoftware/Brave-Browser/NativeMessagingHosts"),
    };
    for (const QString &d : chromeDirs)
        writeManifestTo(d, chrome);
    writeManifestTo(base + QStringLiteral("/Mozilla/NativeMessagingHosts"), firefox);
#else   // Linux / other unix
    const QString cfg = QDir::homePath() + QStringLiteral("/.config");
    const QStringList chromeDirs = {
        cfg + QStringLiteral("/google-chrome/NativeMessagingHosts"),
        cfg + QStringLiteral("/chromium/NativeMessagingHosts"),
        cfg + QStringLiteral("/microsoft-edge/NativeMessagingHosts"),
        cfg + QStringLiteral("/BraveSoftware/Brave-Browser/NativeMessagingHosts"),
    };
    for (const QString &d : chromeDirs)
        writeManifestTo(d, chrome);
    writeManifestTo(QDir::homePath() + QStringLiteral("/.mozilla/native-messaging-hosts"), firefox);
#endif
}

} // namespace nexa
