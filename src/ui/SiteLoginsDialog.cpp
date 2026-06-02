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

namespace nexa {

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
        "cookies.txt below. Only content your own login can access is downloadable."));
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
    const AuthResult ar = am->registerBrowserCookies(domain, browser);
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
