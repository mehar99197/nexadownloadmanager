#include "ui/SiteLoginsDialog.h"
#include "core/DownloadEngine.h"
#include "auth/AuthenticationManager.h"

#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QComboBox>
#include <QPushButton>
#include <QFileDialog>
#include <QFileInfo>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QVariant>
#include <QUuid>

namespace nexa {

namespace {

// The ~/.config sub-directory each Chromium-family browser stores its profiles
// in. Firefox/Safari use a different layout, so they're absent here (we fall
// back to "default profile only" for those).
QString chromiumConfigDir(const QString &browser)
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
// (profile.info_cache maps the profile DIR -> {name: "<display>"}). Returns
// {dirName, displayName} pairs, "Default" first. Empty if nothing is found.
QVector<QPair<QString, QString>> detectChromiumProfiles(const QString &browser)
{
    QVector<QPair<QString, QString>> out;
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
        const QString dir  = it.key();                        // "Default", "Profile 2", …
        const QString name = it.value().toObject()
                                 .value(QStringLiteral("name")).toString();
        // Only offer profiles whose directory actually exists on disk.
        if (!QDir(base + QLatin1Char('/') + dir).exists())
            continue;
        QPair<QString, QString> p{dir, name.isEmpty() ? dir : name};
        if (dir == QStringLiteral("Default")) out.prepend(p);
        else                                  out.append(p);
    }
    return out;
}

// A profile's Cookies SQLite DB. Newer Chrome keeps it under Network/, older
// keeps it at the profile root. Returns the first that exists, or empty.
QString cookiesDbPath(const QString &base, const QString &profileDir)
{
    const QString root = base + QLatin1Char('/') + profileDir + QLatin1Char('/');
    for (const QString &rel : {QStringLiteral("Network/Cookies"), QStringLiteral("Cookies")}) {
        const QString p = root + rel;
        if (QFile::exists(p))
            return p;
    }
    return QString();
}

// Read-only probe of a profile's cookie DB for `domain`. The cookie VALUES are
// OS-keyring-encrypted, but host_key (the domain) and last_access_utc are
// PLAINTEXT — enough to tell which profile is logged into the site and how
// recently it was used, WITHOUT decrypting anything. Returns {count, maxLastAccess}.
// The DB may be locked by a running Chrome, so we read a temp copy (+WAL/+SHM).
QPair<int, qint64> probeDomainCookies(const QString &dbPath, const QString &domain)
{
    QPair<int, qint64> result{0, 0};
    if (dbPath.isEmpty())
        return result;

    const QString stamp = QUuid::createUuid().toString(QUuid::Id128);
    const QString tmp = QDir::tempPath() + QStringLiteral("/nexa-ck-") + stamp;
    // Copy the main DB plus any WAL/SHM sidecars so recent writes are visible.
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
            QSqlQuery q(db);
            q.prepare(QStringLiteral(
                "SELECT COUNT(*), COALESCE(MAX(last_access_utc),0) FROM cookies "
                "WHERE host_key = :d OR host_key LIKE :dotd"));
            q.bindValue(QStringLiteral(":d"), domain);
            q.bindValue(QStringLiteral(":dotd"), QStringLiteral("%.") + domain);
            if (q.exec() && q.next()) {
                result.first  = q.value(0).toInt();
                result.second = q.value(1).toLongLong();
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

// Auto-pick the browser profile to use for `domain`: among profiles that hold
// cookies for the site, the one used MOST RECENTLY (max last_access) — i.e. the
// profile the user actually has the site open/logged-in on. Returns the profile
// DIR ("Profile 5"), or empty if none qualify (caller falls back to default).
QString bestProfileForDomain(const QString &browser, const QString &domain)
{
    const QString base = chromiumConfigDir(browser);
    if (base.isEmpty() || domain.isEmpty())
        return QString();
    QString bestDir;
    qint64  bestAccess = -1;
    const auto profiles = detectChromiumProfiles(browser);
    for (const auto &p : profiles) {
        const auto probe = probeDomainCookies(cookiesDbPath(base, p.first), domain);
        if (probe.first > 0 && probe.second > bestAccess) {
            bestAccess = probe.second;
            bestDir = p.first;
        }
    }
    return bestDir;
}

} // namespace

SiteLoginsDialog::SiteLoginsDialog(DownloadEngine *engine, QWidget *parent)
    : QDialog(parent), m_engine(engine)
{
    setWindowTitle(QStringLiteral("Site Logins"));
    resize(580, 400);
    buildUi();
}

void SiteLoginsDialog::buildUi()
{
    auto *outer = new QVBoxLayout(this);
    outer->setContentsMargins(14, 14, 14, 14);

    auto *plate = new QWidget(this);
    plate->setObjectName(QStringLiteral("Plate"));
    outer->addWidget(plate);

    auto *v = new QVBoxLayout(plate);
    v->setContentsMargins(18, 16, 18, 16);
    v->setSpacing(12);

    auto *title = new QLabel(QStringLiteral("Site Logins"), plate);
    title->setObjectName(QStringLiteral("Dd_title"));
    v->addWidget(title);

    auto *hint = new QLabel(plate);
    hint->setObjectName(QStringLiteral("Dd_host"));
    hint->setWordWrap(true);
    hint->setText(QStringLiteral(
        "Download courses you're enrolled in (Udemy, Coursera, Vimeo, …). Easiest: pick "
        "the browser you're logged in with and click “Use browser login” — Nexa reads "
        "that site's cookies for you, no export needed. Or register an exported "
        "cookies.txt below. Only content your own login can access is downloadable.\n\n"
        "Note: DRM-protected lectures (Widevine) can't be downloaded by any tool — they "
        "only play inside the browser. Such a course saves just its non-DRM videos."));
    v->addWidget(hint);

    // Domain row
    auto *domRow = new QHBoxLayout;
    auto *domLbl = new QLabel(QStringLiteral("Site"), plate);
    domLbl->setProperty("ddRole", "label");
    domLbl->setFixedWidth(80);
    m_domain = new QComboBox(plate);
    m_domain->setEditable(true);
    m_domain->addItems({QStringLiteral("udemy.com"), QStringLiteral("coursera.org"),
                        QStringLiteral("vimeo.com"), QStringLiteral("skillshare.com"),
                        QStringLiteral("pluralsight.com"), QStringLiteral("linkedin.com")});
    domRow->addWidget(domLbl);
    domRow->addWidget(m_domain, 1);
    v->addLayout(domRow);

    // Browser-login row (the easy path: yt-dlp reads the live browser cookies).
    auto *browRow = new QHBoxLayout;
    auto *browLbl = new QLabel(QStringLiteral("Browser"), plate);
    browLbl->setProperty("ddRole", "label");
    browLbl->setFixedWidth(80);
    m_browser = new QComboBox(plate);
    m_browser->addItems({QStringLiteral("chrome"), QStringLiteral("firefox"),
                         QStringLiteral("brave"), QStringLiteral("chromium"),
                         QStringLiteral("edge"), QStringLiteral("opera"),
                         QStringLiteral("vivaldi")});
    auto *useBrowser = new QPushButton(QStringLiteral("Use browser login"), plate);
    useBrowser->setObjectName(QStringLiteral("Primary"));
    useBrowser->setCursor(Qt::PointingHandCursor);
    browRow->addWidget(browLbl);
    browRow->addWidget(m_browser, 1);
    browRow->addWidget(useBrowser);
    v->addLayout(browRow);
    connect(useBrowser, &QPushButton::clicked, this, &SiteLoginsDialog::onUseBrowser);

    auto *orLbl = new QLabel(QStringLiteral("— or register an exported cookies.txt —"), plate);
    orLbl->setProperty("ddRole", "label");
    orLbl->setAlignment(Qt::AlignCenter);
    v->addWidget(orLbl);

    // Cookies file row
    auto *fileRow = new QHBoxLayout;
    auto *fileLbl = new QLabel(QStringLiteral("cookies.txt"), plate);
    fileLbl->setProperty("ddRole", "label");
    fileLbl->setFixedWidth(80);
    m_path = new QLineEdit(plate);
    m_path->setReadOnly(true);
    m_path->setPlaceholderText(QStringLiteral("Choose your exported cookies.txt…"));
    auto *browse = new QPushButton(QStringLiteral("Browse…"), plate);
    browse->setCursor(Qt::PointingHandCursor);
    fileRow->addWidget(fileLbl);
    fileRow->addWidget(m_path, 1);
    fileRow->addWidget(browse);
    v->addLayout(fileRow);

    m_status = new QLabel(plate);
    m_status->setProperty("ddRole", "value");
    m_status->setWordWrap(true);
    v->addWidget(m_status);

    v->addStretch(1);

    auto *btns = new QHBoxLayout;
    auto *reg = new QPushButton(QStringLiteral("Register"), plate);
    reg->setObjectName(QStringLiteral("Primary"));
    reg->setCursor(Qt::PointingHandCursor);
    auto *close = new QPushButton(QStringLiteral("Close"), plate);
    close->setCursor(Qt::PointingHandCursor);
    btns->addStretch(1);
    btns->addWidget(reg);
    btns->addWidget(close);
    v->addLayout(btns);

    connect(browse, &QPushButton::clicked, this, &SiteLoginsDialog::onBrowse);
    connect(reg,    &QPushButton::clicked, this, &SiteLoginsDialog::onRegister);
    connect(close,  &QPushButton::clicked, this, &QDialog::accept);
}

void SiteLoginsDialog::onBrowse()
{
    const QString p = QFileDialog::getOpenFileName(
        this, QStringLiteral("Select cookies.txt"), QDir::homePath(),
        QStringLiteral("Cookies (*.txt cookies.txt);;All files (*)"));
    if (!p.isEmpty())
        m_path->setText(p);
}

void SiteLoginsDialog::onUseBrowser()
{
    const QString domain  = m_domain->currentText().trimmed();
    const QString browser = m_browser->currentText().trimmed();
    if (domain.isEmpty()) {
        m_status->setText(QStringLiteral("Pick a site first."));
        m_status->setStyleSheet(QStringLiteral("color:#f59e0b;"));
        return;
    }
    AuthenticationManager *am = m_engine->auth();
    if (!am) {
        m_status->setText(QStringLiteral("Auth subsystem unavailable."));
        m_status->setStyleSheet(QStringLiteral("color:#ef4444;"));
        return;
    }
    // Silently pick the browser profile most recently logged into the site (no UI
    // list — the user just clicks one button). Empty -> the browser's default.
    const QString profile = bestProfileForDomain(browser, domain);
    // Registering REPLACES any prior credential for this domain (old cookies gone).
    const AuthResult ar = am->registerBrowserCookies(domain, browser, profile);
    if (ar.ok) {
        m_status->setText(QStringLiteral("✓ Will use your %1 login for %2. Just stay logged in, "
                                         "then paste a course/lecture URL in New Download.")
                              .arg(browser, domain));
        m_status->setStyleSheet(QStringLiteral("color:#22c55e;"));
    } else {
        m_status->setText(QStringLiteral("✕ %1").arg(ar.detail));
        m_status->setStyleSheet(QStringLiteral("color:#ef4444;"));
    }
}

void SiteLoginsDialog::onRegister()
{
    const QString domain = m_domain->currentText().trimmed();
    const QString path   = m_path->text();
    if (domain.isEmpty() || path.isEmpty()) {
        m_status->setText(QStringLiteral("Pick a site and a cookies.txt first."));
        m_status->setStyleSheet(QStringLiteral("color:#f59e0b;"));
        return;
    }
    AuthenticationManager *am = m_engine->auth();
    if (!am) {
        m_status->setText(QStringLiteral("Auth subsystem unavailable."));
        m_status->setStyleSheet(QStringLiteral("color:#ef4444;"));
        return;
    }
    const AuthResult ar = am->registerCookieFile(domain, path);
    if (ar.ok) {
        m_status->setText(QStringLiteral("✓ Registered for %1. Paste a course/lecture URL "
                                         "in New Download.").arg(domain));
        m_status->setStyleSheet(QStringLiteral("color:#22c55e;"));
    } else {
        m_status->setText(QStringLiteral("✕ %1").arg(ar.detail));   // already UI-ready
        m_status->setStyleSheet(QStringLiteral("color:#ef4444;"));
    }
}

} // namespace nexa
