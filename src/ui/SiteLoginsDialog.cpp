#include "ui/SiteLoginsDialog.h"
#include "ui/Theme.h"
#include "core/DownloadEngine.h"
#include "auth/AuthenticationManager.h"
#include "auth/BrowserLogin.h"

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

namespace nexa {

namespace {

// `domain` is `site` or one of its subdomains: the suffix rule the credential
// itself is scoped by (AuthenticationManager::hostMatchesDomain).
bool onSite(const QString &domain, const QString &site)
{
    const QString d = domain.toLower();
    return d == site || d.endsWith(QLatin1Char('.') + site);
}

} // namespace

SiteLoginsDialog::SiteLoginsDialog(DownloadEngine *engine, QWidget *parent)
    : QDialog(parent), m_engine(engine)
{
    setWindowTitle(tr("Site Logins"));
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

    auto *title = new QLabel(tr("Site Logins"), plate);
    title->setObjectName(QStringLiteral("Dd_title"));
    v->addWidget(title);

    // Domain row
    auto *domRow = new QHBoxLayout;
    auto *domLbl = new QLabel(tr("Site"), plate);
    domLbl->setProperty("ddRole", "label");
    domLbl->setFixedWidth(80);
    m_domain = new QComboBox(plate);
    m_domain->setEditable(true);
    m_domain->addItems({QStringLiteral("udemy.com"), QStringLiteral("coursera.org"),
                        QStringLiteral("vimeo.com"), QStringLiteral("skillshare.com"),
                        QStringLiteral("pluralsight.com"), QStringLiteral("linkedin.com"),
                        QStringLiteral("music.apple.com")});
    domRow->addWidget(domLbl);
    domRow->addWidget(m_domain, 1);
    v->addLayout(domRow);

    // Browser-login row (the easy path: yt-dlp reads the live browser cookies).
    auto *browRow = new QHBoxLayout;
    auto *browLbl = new QLabel(tr("Browser"), plate);
    browLbl->setProperty("ddRole", "label");
    browLbl->setFixedWidth(80);
    m_browser = new QComboBox(plate);
    m_browser->addItems({QStringLiteral("chrome"), QStringLiteral("firefox"),
                         QStringLiteral("brave"), QStringLiteral("chromium"),
                         QStringLiteral("edge"), QStringLiteral("opera"),
                         QStringLiteral("vivaldi")});
    auto *useBrowser = new QPushButton(tr("Use browser login"), plate);
    useBrowser->setObjectName(QStringLiteral("Primary"));
    useBrowser->setCursor(Qt::PointingHandCursor);
    browRow->addWidget(browLbl);
    browRow->addWidget(m_browser, 1);
    browRow->addWidget(useBrowser);
    v->addLayout(browRow);
    connect(useBrowser, &QPushButton::clicked, this, &SiteLoginsDialog::onUseBrowser);

    m_status = new QLabel(plate);
    m_status->setProperty("ddRole", "value");
    m_status->setWordWrap(true);
    v->addWidget(m_status);

    v->addStretch(1);

    auto *btns = new QHBoxLayout;
    auto *close = new QPushButton(tr("Close"), plate);
    close->setCursor(Qt::PointingHandCursor);
    btns->addStretch(1);
    btns->addWidget(close);
    v->addLayout(btns);

    connect(close,  &QPushButton::clicked, this, &QDialog::accept);
}

void SiteLoginsDialog::onUseBrowser()
{
    const QString domain  = m_domain->currentText().trimmed();
    const QString browser = m_browser->currentText().trimmed();
    if (domain.isEmpty()) {
        m_status->setText(tr("Pick a site first."));
        m_status->setStyleSheet(QStringLiteral("color:%1;").arg(theme::current().pausedFg));
        return;
    }
    AuthenticationManager *am = m_engine->auth();
    if (!am) {
        m_status->setText(tr("Auth subsystem unavailable."));
        m_status->setStyleSheet(QStringLiteral("color:%1;").arg(theme::current().errorFg));
        return;
    }
    // Silently pick the browser profile most recently logged into the site (no UI
    // list — the user just clicks one button). Empty -> the browser's default.
    const QString profile = browserlogin::bestProfileForDomain(browser, domain);
    // Registering REPLACES any prior credential for this domain (old cookies gone).
    const AuthResult ar = am->registerBrowserCookies(domain, browser, profile);
    if (ar.ok) {
        // What this login is good for depends on the site and the browser, so the
        // confirmation says so. Checked against the bundled yt-dlp (2026.08.19):
        //  - Apple Music is FairPlay-DRM: nothing downloads it (AuthUtils).
        //  - yt-dlp has no Coursera or Skillshare extractor (a pasted link lands
        //    in [generic]); the extension downloads what their lecture pages play.
        //  - On Windows, Chrome / Edge / Brave keep cookies under App-Bound
        //    Encryption, which yt-dlp cannot read (browserlogin::detectBrowser
        //    never offers them there); the extension's button still works.
        //  - Udemy: one lecture at a time from its page. A whole course fails in
        //    yt-dlp's udemy:course ("Udemy course download is not supported").
        //  - Elsewhere (Vimeo, LinkedIn Learning, Pluralsight, …) yt-dlp reads a
        //    pasted link with this login.
#ifdef Q_OS_WIN
        const bool unreadable = browser == QLatin1String("chrome")
                             || browser == QLatin1String("edge")
                             || browser == QLatin1String("brave");
#else
        const bool unreadable = false;
#endif
        QString text;
        bool usable = false;
        if (onSite(domain, QStringLiteral("music.apple.com"))) {
            text = tr("Apple Music tracks are DRM-protected, so no login lets Nexa download them.");
        } else if (onSite(domain, QStringLiteral("coursera.org"))
                   || onSite(domain, QStringLiteral("skillshare.com"))) {
            text = tr("yt-dlp can't read %1, so a login doesn't help there. Open each lecture in "
                      "your browser and download it with the Nexa extension instead.").arg(domain);
        } else if (unreadable) {
            text = tr("%1 locks its cookies away from other programs on Windows, so yt-dlp can't "
                      "read this login. Start downloads from the page with the “Download with NDM” "
                      "button instead, or pick Firefox.").arg(browser);
        } else if (onSite(domain, QStringLiteral("udemy.com"))) {
            text = tr("✓ Will use your %1 login for %2. Stay signed in there, then start each "
                      "lecture from its page with the “Download with NDM” button — one lecture at "
                      "a time; whole courses are not supported.").arg(browser, domain);
            usable = true;
        } else {
            text = tr("✓ Will use your %1 login for %2. Stay signed in there, then paste a video's "
                      "link in New Download, or start it from its page with the “Download with "
                      "NDM” button.").arg(browser, domain);
            usable = true;
        }
        m_status->setText(text);
        m_status->setStyleSheet(QStringLiteral("color:%1;").arg(
            usable ? theme::current().doneFg : theme::current().pausedFg));
    } else {
        m_status->setText(QStringLiteral("✕ %1").arg(ar.detail));
        m_status->setStyleSheet(QStringLiteral("color:%1;").arg(theme::current().errorFg));
    }
}

} // namespace nexa
