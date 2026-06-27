#include "auth/BrowserLogin.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QDateTime>
#include <QUuid>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QVector>
#include <QPair>

namespace nexa::browserlogin {

QStringList authSites()
{
    return {
        QStringLiteral("udemy.com"),
        QStringLiteral("coursera.org"),
        QStringLiteral("vimeo.com"),
        QStringLiteral("skillshare.com"),
        QStringLiteral("pluralsight.com"),
        QStringLiteral("linkedin.com"),
    };
}

// ---- Chromium profile / cookie-DB probing (no decryption) -----------------

// The ~/.config sub-directory each Chromium-family browser stores its profiles
// in. Firefox/Safari use a different layout, so they're absent here (callers
// fall back to "default profile only" for those).
static QString chromiumConfigDir(const QString &browser)
{
    const QString cfg = QDir::homePath() + QStringLiteral("/.config/");
    if (browser == QStringLiteral("chrome"))   return cfg + QStringLiteral("google-chrome");
    if (browser == QStringLiteral("chromium")) return cfg + QStringLiteral("chromium");
    if (browser == QStringLiteral("brave"))    return cfg + QStringLiteral("BraveSoftware/Brave-Browser");
    if (browser == QStringLiteral("edge"))     return cfg + QStringLiteral("microsoft-edge");
    if (browser == QStringLiteral("vivaldi"))  return cfg + QStringLiteral("vivaldi");
    if (browser == QStringLiteral("opera"))    return cfg + QStringLiteral("opera");
    return QString();
}

// Discover a Chromium-family browser's profiles from its "Local State" JSON
// (profile.info_cache maps the profile DIR -> {name}). Returns the profile DIR
// names, "Default" first. Empty if nothing is found.
static QStringList detectChromiumProfiles(const QString &browser)
{
    QStringList out;
    const QString base = chromiumConfigDir(browser);
    if (base.isEmpty())
        return out;
    QFile f(base + QStringLiteral("/Local State"));
    if (!f.open(QIODevice::ReadOnly))
        return out;
    const QJsonObject root = QJsonDocument::fromJson(f.readAll()).object();
    const QJsonObject cache = root.value(QStringLiteral("profile"))
                                  .toObject().value(QStringLiteral("info_cache")).toObject();
    for (auto it = cache.begin(); it != cache.end(); ++it) {
        const QString dir = it.key();                         // "Default", "Profile 2", …
        if (!QDir(base + QLatin1Char('/') + dir).exists())    // only profiles present on disk
            continue;
        if (dir == QStringLiteral("Default")) out.prepend(dir);
        else                                  out.append(dir);
    }
    return out;
}

// A profile's Cookies SQLite DB. Newer Chrome keeps it under Network/, older at
// the profile root. Returns the first that exists, or empty.
static QString cookiesDbPath(const QString &base, const QString &profileDir)
{
    const QString root = base + QLatin1Char('/') + profileDir + QLatin1Char('/');
    for (const QString &rel : {QStringLiteral("Network/Cookies"), QStringLiteral("Cookies")}) {
        const QString p = root + rel;
        if (QFile::exists(p))
            return p;
    }
    return QString();
}

// Read-only probe of a profile's cookie DB for several domains AT ONCE (one
// copy + open). The cookie VALUES are OS-keyring-encrypted, but host_key and
// last_access_utc are PLAINTEXT — enough to tell which profile is logged into a
// site and how recently, WITHOUT decrypting anything. Returns
// domain -> {count, maxLastAccess}. The DB may be locked by a running browser,
// so we read a temp copy (+WAL/+SHM sidecars so recent writes are visible).
static QHash<QString, QPair<int, qint64>> probeDb(const QString &dbPath,
                                                  const QStringList &domains)
{
    QHash<QString, QPair<int, qint64>> result;
    if (dbPath.isEmpty() || domains.isEmpty())
        return result;

    const QString stamp = QUuid::createUuid().toString(QUuid::Id128);
    const QString tmp = QDir::tempPath() + QStringLiteral("/nexa-ck-") + stamp;
    if (!QFile::copy(dbPath, tmp))
        return result;
    QFile::copy(dbPath + QStringLiteral("-wal"), tmp + QStringLiteral("-wal"));
    QFile::copy(dbPath + QStringLiteral("-shm"), tmp + QStringLiteral("-shm"));

    const QString conn = QStringLiteral("nexa_ck_") + stamp;
    {
        QSqlDatabase db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), conn);
        db.setDatabaseName(tmp);
        db.setConnectOptions(QStringLiteral("QSQLITE_OPEN_READONLY"));
        if (db.open()) {
            for (const QString &domain : domains) {
                QSqlQuery q(db);
                q.prepare(QStringLiteral(
                    "SELECT COUNT(*), COALESCE(MAX(last_access_utc),0) FROM cookies "
                    "WHERE host_key = :d OR host_key LIKE :dotd"));
                q.bindValue(QStringLiteral(":d"), domain);
                q.bindValue(QStringLiteral(":dotd"), QStringLiteral("%.") + domain);
                if (q.exec() && q.next())
                    result.insert(domain, {q.value(0).toInt(), q.value(1).toLongLong()});
            }
            db.close();
        }
    }
    QSqlDatabase::removeDatabase(conn);
    QFile::remove(tmp);
    QFile::remove(tmp + QStringLiteral("-wal"));
    QFile::remove(tmp + QStringLiteral("-shm"));
    return result;
}

QHash<QString, QString> bestProfiles(const QString &browser, const QStringList &domains)
{
    QHash<QString, QString> best;                 // domain -> profile dir
    const QString base = chromiumConfigDir(browser);
    if (base.isEmpty() || domains.isEmpty())
        return best;                              // non-Chromium: default profile only

    QHash<QString, qint64> bestAccess;            // domain -> max last_access seen
    for (const QString &prof : detectChromiumProfiles(browser)) {
        const auto probed = probeDb(cookiesDbPath(base, prof), domains);
        for (auto it = probed.constBegin(); it != probed.constEnd(); ++it) {
            const QString &domain = it.key();
            const int count = it.value().first;
            const qint64 access = it.value().second;
            if (count > 0 && access > bestAccess.value(domain, -1)) {
                bestAccess.insert(domain, access);
                best.insert(domain, prof);
            }
        }
    }
    return best;
}

QString bestProfileForDomain(const QString &browser, const QString &domain)
{
    return bestProfiles(browser, {domain}).value(domain);
}

// ---- Browser detection ----------------------------------------------------

QString detectBrowser()
{
    const QString home = QDir::homePath();
    struct Cand { const char *name; QString path; };
    const QVector<Cand> cands = {
        {"chrome",   home + QStringLiteral("/.config/google-chrome")},
        {"brave",    home + QStringLiteral("/.config/BraveSoftware/Brave-Browser")},
        {"chromium", home + QStringLiteral("/.config/chromium")},
        {"edge",     home + QStringLiteral("/.config/microsoft-edge")},
        {"vivaldi",  home + QStringLiteral("/.config/vivaldi")},
        {"opera",    home + QStringLiteral("/.config/opera")},
    };
    QString best;
    QDateTime bestMtime;
    auto consider = [&](const char *name, const QString &cookiePath) {
        const QFileInfo fi(cookiePath);
        if (!fi.exists())
            return;
        if (best.isEmpty() || fi.lastModified() > bestMtime) {
            best = QString::fromLatin1(name);
            bestMtime = fi.lastModified();
        }
    };
    for (const Cand &c : cands)
        for (const QString &prof : {QStringLiteral("Default"), QStringLiteral("Profile 1")}) {
            consider(c.name, c.path + QStringLiteral("/") + prof + QStringLiteral("/Cookies"));
            consider(c.name, c.path + QStringLiteral("/") + prof + QStringLiteral("/Network/Cookies"));
        }
    {
        const QDir ff(home + QStringLiteral("/.mozilla/firefox"));
        const auto profiles = ff.entryList(QStringList{QStringLiteral("*.default*")},
                                           QDir::Dirs | QDir::NoDotAndDotDot);
        for (const QString &p : profiles)
            consider("firefox", ff.filePath(p + QStringLiteral("/cookies.sqlite")));
    }
    return best;
}

} // namespace nexa::browserlogin
