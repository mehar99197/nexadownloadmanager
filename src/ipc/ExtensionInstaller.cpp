#include "ipc/ExtensionInstaller.h"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QSettings>
#include <QStandardPaths>

namespace nexa::extinstall {

namespace {

const QString kChromeUpdateUrl = QStringLiteral("https://clients2.google.com/service/update2/crx");
const QString kEdgeUpdateUrl   = QStringLiteral("https://edge.microsoft.com/extensionwebstorebase/v1/crx");

bool validChromeId(const QString &id)
{
    static const QRegularExpression re(QStringLiteral("\\A[a-p]{32}\\z"));
    return re.match(id).hasMatch();
}

QString firstNonEmpty(std::initializer_list<QString> values)
{
    for (const QString &v : values)
        if (!v.trimmed().isEmpty())
            return v.trimmed();
    return QString();
}

Browser make(const char *key, const char *name, Family family, bool sandboxed = false)
{
    return Browser{QString::fromLatin1(key), QString::fromLatin1(name), family, sandboxed};
}

// The store this browser installs from, and the id it needs. Edge prefers its
// own store but happily installs the Chrome Web Store copy when we have no Edge id.
bool storeFor(const Browser &b, const Ids &ids, QString &id, QString &updateUrl)
{
    if (b.family == Family::Firefox) {
        id = ids.firefoxExtId;
        updateUrl = ids.firefoxXpiUrl;
        return !id.isEmpty() && !updateUrl.isEmpty();
    }
    if (b.key == QLatin1String("edge") && validChromeId(ids.edgeStoreId)) {
        id = ids.edgeStoreId;
        updateUrl = kEdgeUpdateUrl;
        return true;
    }
    id = ids.chromeStoreId;
    updateUrl = kChromeUpdateUrl;
    return validChromeId(id);
}

QByteArray externalExtensionJson(const QString &updateUrl)
{
    QJsonObject o;
    o.insert(QStringLiteral("external_update_url"), updateUrl);
    return QJsonDocument(o).toJson(QJsonDocument::Indented);
}

// Chromium policy file: installed automatically, but the user keeps the power
// to disable or remove it ("normal_installed", not "force_installed").
QByteArray chromiumPolicyJson(const QString &id, const QString &updateUrl)
{
    QJsonObject entry;
    entry.insert(QStringLiteral("installation_mode"), QStringLiteral("normal_installed"));
    entry.insert(QStringLiteral("update_url"), updateUrl);
    QJsonObject settings;
    settings.insert(id, entry);
    QJsonObject o;
    o.insert(QStringLiteral("ExtensionSettings"), settings);
    return QJsonDocument(o).toJson(QJsonDocument::Indented);
}

QJsonObject firefoxPolicyEntry(const QString &xpiUrl)
{
    QJsonObject entry;
    entry.insert(QStringLiteral("installation_mode"), QStringLiteral("normal_installed"));
    entry.insert(QStringLiteral("install_url"), xpiUrl);
    return entry;
}

QByteArray readAll(const QString &path)
{
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) return QByteArray();
    return f.readAll();
}

bool writeAll(const QString &path, const QByteArray &data)
{
    QDir().mkpath(QFileInfo(path).absolutePath());
    QFile f(path);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) return false;
    return f.write(data) == data.size();
}

// ---- Firefox policies.json: ours is one key inside a file that may already
// carry someone else's policies, so read → set → write, never clobber.
QJsonObject loadPolicies(const QString &path)
{
    const QJsonDocument doc = QJsonDocument::fromJson(readAll(path));
    return doc.isObject() ? doc.object() : QJsonObject();
}

bool firefoxEntryInPlace(const QString &path, const QString &extId, const QJsonObject &entry)
{
    const QJsonObject root = loadPolicies(path);
    const QJsonObject settings = root.value(QStringLiteral("policies")).toObject()
                                     .value(QStringLiteral("ExtensionSettings")).toObject();
    return settings.value(extId).toObject() == entry;
}

bool mergeFirefoxEntry(const QString &path, const QString &extId, const QJsonObject &entry)
{
    QJsonObject root = loadPolicies(path);
    QJsonObject policies = root.value(QStringLiteral("policies")).toObject();
    QJsonObject settings = policies.value(QStringLiteral("ExtensionSettings")).toObject();
    settings.insert(extId, entry);
    policies.insert(QStringLiteral("ExtensionSettings"), settings);
    root.insert(QStringLiteral("policies"), policies);
    return writeAll(path, QJsonDocument(root).toJson(QJsonDocument::Indented));
}

bool removeFirefoxEntry(const QString &path, const QString &extId)
{
    if (!QFileInfo::exists(path)) return true;
    QJsonObject root = loadPolicies(path);
    QJsonObject policies = root.value(QStringLiteral("policies")).toObject();
    QJsonObject settings = policies.value(QStringLiteral("ExtensionSettings")).toObject();
    if (!settings.contains(extId)) return true;
    settings.remove(extId);
    if (settings.isEmpty()) policies.remove(QStringLiteral("ExtensionSettings"));
    else                    policies.insert(QStringLiteral("ExtensionSettings"), settings);
    root.insert(QStringLiteral("policies"), policies);
    return writeAll(path, QJsonDocument(root).toJson(QJsonDocument::Indented));
}

bool isRegistry(const Target &t) { return t.path.startsWith(QLatin1String("HKEY_")); }

Report g_last;

} // namespace

// ---------------------------------------------------------------------------

Ids parseIdsEnv(const QByteArray &envFile)
{
    Ids out;
    for (const QByteArray &rawLine : envFile.split('\n')) {
        const QString line = QString::fromUtf8(rawLine).trimmed();
        if (line.isEmpty() || line.startsWith(QLatin1Char('#'))) continue;
        const int eq = line.indexOf(QLatin1Char('='));
        if (eq <= 0) continue;
        const QString key = line.left(eq).trimmed();
        QString value = line.mid(eq + 1).trimmed();
        if (value.size() >= 2 && ((value.startsWith(QLatin1Char('"')) && value.endsWith(QLatin1Char('"')))
                               || (value.startsWith(QLatin1Char('\'')) && value.endsWith(QLatin1Char('\'')))))
            value = value.mid(1, value.size() - 2);
        if      (key == QLatin1String("NEXA_CHROME_STORE_ID"))  out.chromeStoreId  = value.toLower();
        else if (key == QLatin1String("NEXA_EDGE_STORE_ID"))    out.edgeStoreId    = value.toLower();
        else if (key == QLatin1String("NEXA_FIREFOX_XPI_URL"))  out.firefoxXpiUrl  = value;
        else if (key == QLatin1String("NEXA_FIREFOX_EXT_ID"))   out.firefoxExtId   = value;
    }
    return out;
}

Ids ids()
{
    Ids bundled = parseIdsEnv(readAll(QStringLiteral(":/extension-ids.env")));
    QSettings s;
    s.beginGroup(QStringLiteral("extension"));
    Ids out;
    out.chromeStoreId = firstNonEmpty({s.value(QStringLiteral("chromeStoreId")).toString(),
                                       qEnvironmentVariable("NEXA_CHROME_STORE_ID"),
                                       bundled.chromeStoreId}).toLower();
    out.edgeStoreId   = firstNonEmpty({s.value(QStringLiteral("edgeStoreId")).toString(),
                                       qEnvironmentVariable("NEXA_EDGE_STORE_ID"),
                                       bundled.edgeStoreId}).toLower();
    out.firefoxXpiUrl = firstNonEmpty({s.value(QStringLiteral("firefoxXpiUrl")).toString(),
                                       qEnvironmentVariable("NEXA_FIREFOX_XPI_URL"),
                                       bundled.firefoxXpiUrl});
    out.firefoxExtId  = firstNonEmpty({s.value(QStringLiteral("firefoxExtId")).toString(),
                                       qEnvironmentVariable("NEXA_FIREFOX_EXT_ID"),
                                       bundled.firefoxExtId,
                                       QStringLiteral("nexa@nexa.local")});
    // An .xpi must come over HTTPS or Firefox rejects the policy; refuse anything else.
    if (!out.firefoxXpiUrl.startsWith(QLatin1String("https://"), Qt::CaseInsensitive))
        out.firefoxXpiUrl.clear();
    if (!validChromeId(out.chromeStoreId)) out.chromeStoreId.clear();
    if (!validChromeId(out.edgeStoreId))   out.edgeStoreId.clear();
    return out;
}

// ---- Detection --------------------------------------------------------------

QVector<Browser> installedBrowsers()
{
    QVector<Browser> found;
    auto add = [&found](const Browser &b) {
        for (const Browser &f : found)
            if (f.key == b.key) return;
        found.push_back(b);
    };

#if defined(Q_OS_WIN)
    // Every installed browser registers itself under Clients\StartMenuInternet
    // (it is how "Default apps" finds them); App Paths is the fallback.
    const QStringList hives = {QStringLiteral("HKEY_LOCAL_MACHINE"), QStringLiteral("HKEY_CURRENT_USER")};
    for (const QString &hive : hives) {
        QSettings s(hive + QStringLiteral("\\SOFTWARE\\Clients\\StartMenuInternet"), QSettings::NativeFormat);
        for (const QString &g : s.childGroups()) {
            const QString n = g.toLower();
            if (n.contains(QLatin1String("chromium")))      add(make("chromium", "Chromium", Family::Chromium));
            else if (n.contains(QLatin1String("chrome")))   add(make("chrome",   "Google Chrome", Family::Chromium));
            else if (n.contains(QLatin1String("edge")))     add(make("edge",     "Microsoft Edge", Family::Chromium));
            else if (n.contains(QLatin1String("brave")))    add(make("brave",    "Brave", Family::Chromium));
            else if (n.contains(QLatin1String("vivaldi")))  add(make("vivaldi",  "Vivaldi", Family::Chromium));
            else if (n.contains(QLatin1String("firefox")))  add(make("firefox",  "Firefox", Family::Firefox));
        }
    }
    struct AppPath { const char *exe; const char *key; const char *name; Family family; };
    const AppPath apps[] = {
        {"chrome.exe",   "chrome",   "Google Chrome",  Family::Chromium},
        {"chromium.exe", "chromium", "Chromium",       Family::Chromium},
        {"msedge.exe",   "edge",     "Microsoft Edge", Family::Chromium},
        {"brave.exe",    "brave",    "Brave",          Family::Chromium},
        {"vivaldi.exe",  "vivaldi",  "Vivaldi",        Family::Chromium},
        {"firefox.exe",  "firefox",  "Firefox",        Family::Firefox},
    };
    for (const AppPath &a : apps) {
        for (const QString &hive : hives) {
            QSettings s(hive + QStringLiteral("\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\")
                            + QString::fromLatin1(a.exe), QSettings::NativeFormat);
            if (!s.value(QStringLiteral(".")).toString().isEmpty())
                add(make(a.key, a.name, a.family));
        }
    }
#elif defined(Q_OS_MACOS)
    struct App { const char *bundle; const char *key; const char *name; Family family; };
    const App apps[] = {
        {"Google Chrome.app",  "chrome",   "Google Chrome",  Family::Chromium},
        {"Chromium.app",       "chromium", "Chromium",       Family::Chromium},
        {"Microsoft Edge.app", "edge",     "Microsoft Edge", Family::Chromium},
        {"Brave Browser.app",  "brave",    "Brave",          Family::Chromium},
        {"Vivaldi.app",        "vivaldi",  "Vivaldi",        Family::Chromium},
        {"Firefox.app",        "firefox",  "Firefox",        Family::Firefox},
    };
    for (const App &a : apps) {
        const QString b = QString::fromLatin1(a.bundle);
        if (QFileInfo::exists(QStringLiteral("/Applications/") + b)
            || QFileInfo::exists(QDir::homePath() + QStringLiteral("/Applications/") + b))
            add(make(a.key, a.name, a.family));
    }
#else
    struct Exe { const char *exe; const char *key; const char *name; Family family; };
    const Exe exes[] = {
        {"google-chrome",        "chrome",   "Google Chrome",  Family::Chromium},
        {"google-chrome-stable", "chrome",   "Google Chrome",  Family::Chromium},
        {"chromium",             "chromium", "Chromium",       Family::Chromium},
        {"chromium-browser",     "chromium", "Chromium",       Family::Chromium},
        {"microsoft-edge",       "edge",     "Microsoft Edge", Family::Chromium},
        {"microsoft-edge-stable","edge",     "Microsoft Edge", Family::Chromium},
        {"brave-browser",        "brave",    "Brave",          Family::Chromium},
        {"brave",                "brave",    "Brave",          Family::Chromium},
        {"vivaldi",              "vivaldi",  "Vivaldi",        Family::Chromium},
        {"vivaldi-stable",       "vivaldi",  "Vivaldi",        Family::Chromium},
        {"firefox",              "firefox",  "Firefox",        Family::Firefox},
        {"firefox-esr",          "firefox",  "Firefox",        Family::Firefox},
    };
    for (const Exe &e : exes) {
        const QString path = QStandardPaths::findExecutable(QString::fromLatin1(e.exe));
        if (path.isEmpty()) continue;
        // A snap's launcher lives in /snap/bin; the browser inside cannot see
        // /usr/share or /etc hooks, so it needs the manual route.
        const bool snap = path.startsWith(QLatin1String("/snap/"))
                       || QFileInfo(path).canonicalFilePath().startsWith(QLatin1String("/snap/"));
        add(make(e.key, e.name, e.family, snap));
    }
    struct Flat { const char *id; const char *key; const char *name; Family family; };
    const Flat flats[] = {
        {"com.google.Chrome",     "chrome",   "Google Chrome",  Family::Chromium},
        {"org.chromium.Chromium", "chromium", "Chromium",       Family::Chromium},
        {"com.microsoft.Edge",    "edge",     "Microsoft Edge", Family::Chromium},
        {"com.brave.Browser",     "brave",    "Brave",          Family::Chromium},
        {"com.vivaldi.Vivaldi",   "vivaldi",  "Vivaldi",        Family::Chromium},
        {"org.mozilla.firefox",   "firefox",  "Firefox",        Family::Firefox},
    };
    for (const Flat &f : flats) {
        const QString id = QString::fromLatin1(f.id);
        if (QFileInfo::exists(QStringLiteral("/var/lib/flatpak/app/") + id)
            || QFileInfo::exists(QDir::homePath() + QStringLiteral("/.local/share/flatpak/app/") + id))
            add(make(f.key, f.name, f.family, /*sandboxed=*/true));
    }
#endif
    return found;
}

// ---- Planning ---------------------------------------------------------------

QVector<Target> plan(const QVector<Browser> &browsers, const Ids &ids, const QString &systemRoot)
{
    QVector<Target> out;
    for (const Browser &b : browsers) {
        if (b.sandboxed) continue;
        QString id, updateUrl;
        if (!storeFor(b, ids, id, updateUrl)) continue;

#if defined(Q_OS_WIN)
        Q_UNUSED(systemRoot);
        if (b.family == Family::Firefox) {
            Target t;
            t.browser = b.name;
            t.path = QStringLiteral("HKEY_CURRENT_USER\\Software\\Policies\\Mozilla\\Firefox\\Extensions\\Install");
            t.valueName = QStringLiteral("1");
            t.payload = updateUrl.toUtf8();
            out.push_back(t);
            continue;
        }
        static const struct { const char *key; const char *vendor; } vendors[] = {
            {"chrome",   "Google\\Chrome"},
            {"chromium", "Chromium"},
            {"edge",     "Microsoft\\Edge"},
            {"brave",    "BraveSoftware\\Brave-Browser"},
            {"vivaldi",  "Vivaldi"},
        };
        for (const auto &v : vendors) {
            if (b.key != QLatin1String(v.key)) continue;
            Target t;
            t.browser = b.name;
            t.path = QStringLiteral("HKEY_CURRENT_USER\\Software\\") + QString::fromLatin1(v.vendor)
                   + QStringLiteral("\\Extensions\\") + id;
            t.valueName = QStringLiteral("update_url");
            t.payload = updateUrl.toUtf8();
            out.push_back(t);
        }
#elif defined(Q_OS_MACOS)
        Q_UNUSED(systemRoot);
        if (b.family == Family::Firefox) continue;   // policies need root: manual on macOS
        static const struct { const char *key; const char *dir; } vendors[] = {
            {"chrome",   "Google/Chrome"},
            {"chromium", "Chromium"},
            {"edge",     "Microsoft Edge"},
            {"brave",    "BraveSoftware/Brave-Browser"},
            {"vivaldi",  "Vivaldi"},
        };
        for (const auto &v : vendors) {
            if (b.key != QLatin1String(v.key)) continue;
            Target t;
            t.browser = b.name;
            t.path = QDir::homePath() + QStringLiteral("/Library/Application Support/")
                   + QString::fromLatin1(v.dir) + QStringLiteral("/External Extensions/") + id + QStringLiteral(".json");
            t.payload = externalExtensionJson(updateUrl);
            out.push_back(t);
        }
#else
        const QString root = systemRoot.isEmpty() ? QString() : QDir(systemRoot).absolutePath();
        auto sys = [&root](const char *p) { return root + QString::fromLatin1(p); };
        if (b.family == Family::Firefox) {
            Target t;
            t.browser = b.name;
            t.path = sys("/etc/firefox/policies/policies.json");
            t.mergeFirefoxPolicy = true;
            t.firefoxExtId = id;
            t.payload = QJsonDocument(firefoxPolicyEntry(updateUrl)).toJson(QJsonDocument::Compact);
            out.push_back(t);
            continue;
        }
        // Chrome and Chromium document an external-extensions directory
        // (chrome_paths.cc: DIR_EXTERNAL_EXTENSIONS / DIR_STANDALONE_EXTERNAL_EXTENSIONS).
        QStringList externalDirs;
        if (b.key == QLatin1String("chrome"))
            externalDirs = {sys("/opt/google/chrome/extensions"), sys("/usr/share/google-chrome/extensions")};
        else if (b.key == QLatin1String("chromium"))
            externalDirs = {sys("/usr/share/chromium/extensions"), sys("/usr/share/chromium-browser/extensions")};
        for (const QString &d : externalDirs) {
            Target t;
            t.browser = b.name;
            t.path = d + QLatin1Char('/') + id + QStringLiteral(".json");
            t.payload = externalExtensionJson(updateUrl);
            out.push_back(t);
        }
        // Brave, Edge and Vivaldi document only their managed-policy directory.
        QString policyDir;
        if (b.key == QLatin1String("brave"))        policyDir = sys("/etc/brave/policies/managed");
        else if (b.key == QLatin1String("edge"))    policyDir = sys("/etc/opt/edge/policies/managed");
        else if (b.key == QLatin1String("vivaldi")) policyDir = sys("/etc/vivaldi/policies/managed");
        if (!policyDir.isEmpty()) {
            Target t;
            t.browser = b.name;
            t.path = policyDir + QStringLiteral("/nexa-extension.json");
            t.payload = chromiumPolicyJson(id, updateUrl);
            out.push_back(t);
        }
#endif
    }
    return out;
}

// ---- Applying ---------------------------------------------------------------

bool targetInPlace(const Target &t)
{
    if (isRegistry(t)) {
#if defined(Q_OS_WIN)
        QSettings s(t.path, QSettings::NativeFormat);
        return s.value(t.valueName).toString() == QString::fromUtf8(t.payload);
#else
        return false;
#endif
    }
    if (t.mergeFirefoxPolicy)
        return firefoxEntryInPlace(t.path, t.firefoxExtId, QJsonDocument::fromJson(t.payload).object());
    return QFileInfo::exists(t.path) && readAll(t.path) == t.payload;
}

bool applyTarget(const Target &t)
{
    if (targetInPlace(t)) return true;
    if (isRegistry(t)) {
#if defined(Q_OS_WIN)
        QSettings s(t.path, QSettings::NativeFormat);
        s.setValue(t.valueName, QString::fromUtf8(t.payload));
        s.sync();
        return s.status() == QSettings::NoError;
#else
        return false;
#endif
    }
    if (t.mergeFirefoxPolicy)
        return mergeFirefoxEntry(t.path, t.firefoxExtId, QJsonDocument::fromJson(t.payload).object());
    return writeAll(t.path, t.payload);
}

bool removeTarget(const Target &t)
{
    if (isRegistry(t)) {
#if defined(Q_OS_WIN)
        QSettings s(t.path, QSettings::NativeFormat);
        s.remove(t.valueName);
        s.sync();
        return true;
#else
        return false;
#endif
    }
    if (t.mergeFirefoxPolicy)
        return removeFirefoxEntry(t.path, t.firefoxExtId);
    return !QFileInfo::exists(t.path) || QFile::remove(t.path);
}

bool Report::anyRegistered() const
{
    for (const Entry &e : entries)
        if (e.status == Status::Registered) return true;
    return false;
}

Report apply(const QVector<Browser> &browsers, const Ids &ids, const QString &systemRoot)
{
    Report report;
    const QVector<Target> targets = plan(browsers, ids, systemRoot);
    for (const Browser &b : browsers) {
        Entry e;
        e.browser = b.name;
        QString id, updateUrl;
        const bool published = storeFor(b, ids, id, updateUrl);
        if (b.sandboxed) {
            e.status = Status::Manual;
            e.detail = QStringLiteral("installed as a snap or flatpak, which cannot see system extension "
                                      "hooks — add the extension from the guide");
        } else if (!published) {
            e.status = Status::WaitingForStore;
            e.detail = b.family == Family::Firefox
                ? QStringLiteral("waiting for the signed add-on listing — add it from the guide for now")
                : QStringLiteral("waiting for the store listing — add it from the guide for now");
        } else {
            int mine = 0, ok = 0, present = 0;
            for (const Target &t : targets) {
                if (t.browser != b.name) continue;
                ++mine;
                if (targetInPlace(t)) { ++ok; ++present; continue; }
                if (applyTarget(t)) ++ok;
            }
            if (mine == 0) {
                e.status = Status::Manual;
                e.detail = QStringLiteral("this system needs the extension added from the guide");
            } else if (ok == mine) {
                e.status = Status::Registered;
                e.detail = b.family == Family::Firefox
                    ? QStringLiteral("installs the Nexa add-on the next time it starts")
                    : QStringLiteral("will ask you to enable the Nexa extension the next time it starts");
                if (present == mine && systemRoot.isEmpty())
                    e.detail += QStringLiteral(" (set up by the installer)");
            } else {
#if defined(Q_OS_LINUX)
                e.status = Status::Manual;
                e.detail = QStringLiteral("needs the .deb installer or “sudo nexa --register-extensions” "
                                          "to add the system-wide hook");
#else
                e.status = Status::Failed;
                e.detail = QStringLiteral("could not write the browser's extension entry");
#endif
            }
        }
        report.entries.push_back(e);
    }
    return report;
}

Report registerExtensions()
{
    g_last = apply(installedBrowsers(), ids());
    return g_last;
}

const Report &lastReport()
{
    return g_last;
}

} // namespace nexa::extinstall
