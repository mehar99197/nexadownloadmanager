#include "ui/FirstRunWizard.h"
#include "ui/UiHelpers.h"
#include "ui/Theme.h"
#include "ui/Motion.h"
#include "core/DownloadEngine.h"
#include "ipc/ExtensionInstaller.h"

#include <QWizardPage>
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QCheckBox>
#include <QPushButton>
#include <QProgressBar>
#include <QFileDialog>
#include <QDesktopServices>
#include <QSettings>
#include <QDir>
#include <QFileInfo>
#include <QStandardPaths>
#include <QDateTime>
#include <QUrl>

namespace nexa {

namespace {
constexpr auto kDone = "firstRunDone";
// A small, range-capable public file: enough to show segmented speed, small
// enough to finish in seconds. Deleted again when the wizard closes.
const QString kTestUrl = QStringLiteral("https://proof.ovh.net/files/10Mb.dat");
const QString kTestName = QStringLiteral("nexa-speed-test.dat");

QLabel *para(const QString &html, QWidget *parent)
{
    auto *l = new QLabel(html, parent);
    l->setWordWrap(true);
    l->setOpenExternalLinks(true);
    l->setTextFormat(Qt::RichText);
    return l;
}
} // namespace

bool FirstRunWizard::shouldShow()
{
    return !QSettings().value(QLatin1String(kDone), false).toBool();
}

void FirstRunWizard::markDone()
{
    QSettings().setValue(QLatin1String(kDone), true);
}

QStringList FirstRunWizard::detectedBrowsers()
{
    struct Probe { const char *name; QString path; };
    QList<Probe> probes;
#if defined(Q_OS_WIN)
    const QString local = QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation); // %LOCALAPPDATA%
    const QString roaming = QStandardPaths::writableLocation(QStandardPaths::GenericConfigLocation);
    probes << Probe{"Chrome",  local + QStringLiteral("/Google/Chrome/User Data")}
           << Probe{"Edge",    local + QStringLiteral("/Microsoft/Edge/User Data")}
           << Probe{"Brave",   local + QStringLiteral("/BraveSoftware/Brave-Browser/User Data")}
           << Probe{"Chromium", local + QStringLiteral("/Chromium/User Data")}
           << Probe{"Firefox", roaming + QStringLiteral("/Mozilla/Firefox/Profiles")};
#elif defined(Q_OS_MACOS)
    const QString base = QDir::homePath() + QStringLiteral("/Library/Application Support");
    probes << Probe{"Chrome",  base + QStringLiteral("/Google/Chrome")}
           << Probe{"Edge",    base + QStringLiteral("/Microsoft Edge")}
           << Probe{"Brave",   base + QStringLiteral("/BraveSoftware/Brave-Browser")}
           << Probe{"Chromium", base + QStringLiteral("/Chromium")}
           << Probe{"Firefox", base + QStringLiteral("/Firefox/Profiles")};
#else
    const QString cfg = QDir::homePath() + QStringLiteral("/.config");
    probes << Probe{"Chrome",  cfg + QStringLiteral("/google-chrome")}
           << Probe{"Chromium", cfg + QStringLiteral("/chromium")}
           << Probe{"Edge",    cfg + QStringLiteral("/microsoft-edge")}
           << Probe{"Brave",   cfg + QStringLiteral("/BraveSoftware/Brave-Browser")}
           << Probe{"Firefox", QDir::homePath() + QStringLiteral("/.mozilla/firefox")}
           << Probe{"Firefox (snap)", QDir::homePath() + QStringLiteral("/snap/firefox")};
#endif
    QStringList found;
    for (const Probe &p : probes)
        if (QFileInfo::exists(p.path))
            found << QString::fromLatin1(p.name);
    return found;
}

FirstRunWizard::FirstRunWizard(DownloadEngine *engine, QWidget *parent)
    : QWizard(parent), m_engine(engine)
{
    setWindowTitle(tr("Welcome to Nexa"));
    setWizardStyle(QWizard::ModernStyle);
    setOption(QWizard::NoBackButtonOnStartPage, true);
    setOption(QWizard::NoCancelButtonOnLastPage, true);
    setButtonText(QWizard::FinishButton, QStringLiteral("Start using Nexa"));
    setMinimumSize(640, 460);
    addPage(welcomePage());
    addPage(browserPage());
    addPage(testPage());
}

QWizardPage *FirstRunWizard::welcomePage()
{
    auto *page = new QWizardPage(this);
    page->setTitle(tr("Where should downloads go?"));
    page->setSubTitle(QStringLiteral("Nexa splits every file into up to 16 connections and resumes "
                                     "where it left off. Pick a folder to keep things in."));
    auto *v = new QVBoxLayout(page);
    v->setSpacing(10);

    auto *row = new QHBoxLayout;
    m_dir = new QLineEdit(m_engine->downloadDir(), page);
    auto *browse = new QPushButton(tr("Browse…"), page);
    browse->setCursor(Qt::PointingHandCursor);
    row->addWidget(m_dir, 1);
    row->addWidget(browse);
    v->addLayout(row);
    connect(browse, &QPushButton::clicked, this, [this]() {
        const QString d = QFileDialog::getExistingDirectory(this, QStringLiteral("Choose download folder"), m_dir->text());
        if (!d.isEmpty())
            m_dir->setText(d);
    });

    QSettings s;
    m_categorize = new QCheckBox(tr("Sort finished files into Video/, Audio/, Documents/… subfolders"), page);
    m_categorize->setChecked(s.value(QStringLiteral("autoCategorize"), true).toBool());
    m_notify = new QCheckBox(tr("Show a desktop notification when a download finishes or fails"), page);
    m_notify->setChecked(s.value(QStringLiteral("ui/notifications"), true).toBool());
    m_clipboard = new QCheckBox(tr("Offer to download links I copy to the clipboard"), page);
    m_clipboard->setChecked(s.value(QStringLiteral("clipboardMonitor"), false).toBool());
    v->addWidget(m_categorize);
    v->addWidget(m_notify);
    v->addWidget(m_clipboard);
    v->addStretch(1);
    v->addWidget(para(QStringLiteral("<span style='color:%1'>You can change any of this later in "
                                     "Settings (Ctrl+,).</span>")
                          .arg(theme::current().textMuted), page));
    return page;
}

QWizardPage *FirstRunWizard::browserPage()
{
    auto *page = new QWizardPage(this);
    page->setTitle(tr("Connect your browser"));
    page->setSubTitle(QStringLiteral("The Nexa extension hands downloads and videos to this app — "
                                     "with your login cookies, so private files work too."));
    auto *v = new QVBoxLayout(page);
    v->setSpacing(10);

    // What the auto-installer did at startup, browser by browser. A browser is
    // "Registered" when its own store will hand it the extension on next start;
    // the other states say exactly why not, so nobody waits for magic.
    const extinstall::Report &report = extinstall::lastReport();
    if (report.entries.isEmpty()) {
        v->addWidget(para(QStringLiteral("No browser was found on this machine yet. Install one, "
                                         "restart Nexa, and it will set the extension up for you."), page));
    } else {
        const QString ok   = theme::current().doneFg;
        const QString warn = theme::current().pausedFg;
        QString rows;
        for (const extinstall::Entry &e : report.entries) {
            const bool good = e.status == extinstall::Status::Registered;
            rows += QStringLiteral("<tr><td style='padding:2px 10px 2px 0'><b>%1</b></td>"
                                   "<td style='color:%2'>%3</td></tr>")
                        .arg(e.browser.toHtmlEscaped(), good ? ok : warn, e.detail.toHtmlEscaped());
        }
        v->addWidget(para(QStringLiteral("<table cellspacing='0'>%1</table>").arg(rows), page));
        v->addWidget(para(report.anyRegistered()
            ? QStringLiteral("Nexa's native-messaging bridge is registered too, and refreshed on every "
                             "start — so once the browser has the extension, the toolbar icon says "
                             "<i>Connected</i> and downloads come straight here.")
            : QStringLiteral("The native-messaging bridge is already registered for every browser "
                             "above; only the extension itself is still to add."), page));
    }
    v->addWidget(para(QStringLiteral(
        "<b>Adding it by hand</b><br>"
        "Open <a href='https://nexadownloadmanager.com/docs/extension'>the extension guide</a> "
        "and add Nexa to Chrome, Edge, Brave, Vivaldi or Firefox. Then click the Nexa toolbar icon — "
        "it should say <i>Connected</i>."), page));
    auto *btnRow = new QHBoxLayout;
    auto *guide = new QPushButton(tr("Open the extension guide"), page);
    guide->setObjectName(QStringLiteral("Primary"));
    guide->setCursor(Qt::PointingHandCursor);
    connect(guide, &QPushButton::clicked, this, []() {
        QDesktopServices::openUrl(QUrl(QStringLiteral("https://nexadownloadmanager.com/docs/extension")));
    });
    btnRow->addWidget(guide);
    btnRow->addStretch(1);
    v->addLayout(btnRow);
    v->addStretch(1);
    v->addWidget(para(QStringLiteral("<span style='color:%1'>No extension? Paste any link into "
                                     "<b>New download</b>, or copy it with clipboard capture on.</span>")
                          .arg(theme::current().textMuted), page));
    return page;
}

QWizardPage *FirstRunWizard::testPage()
{
    auto *page = new QWizardPage(this);
    page->setTitle(tr("See it go"));
    page->setSubTitle(QStringLiteral("Run a 10 MB test download to watch the segmented engine work. "
                                     "The file is removed afterwards."));
    auto *v = new QVBoxLayout(page);
    v->setSpacing(10);

    m_testBtn = new QPushButton(tr("Run a 10 MB test download"), page);
    m_testBtn->setObjectName(QStringLiteral("Primary"));
    m_testBtn->setCursor(Qt::PointingHandCursor);
    m_testBar = new motion::ThemedBar(page);
    m_testBar->setFixedHeight(6);
    m_testBar->setRange(0, 100);
    m_testBar->setValue(0);
    m_testStatus = new QLabel(tr("Ready when you are."), page);
    m_testStatus->setWordWrap(true);

    auto *row = new QHBoxLayout;
    row->addWidget(m_testBtn);
    row->addStretch(1);
    v->addLayout(row);
    v->addWidget(m_testBar);
    v->addWidget(m_testStatus);
    v->addStretch(1);
    v->addWidget(para(QStringLiteral("<span style='color:%1'>Tip: right-click any download for "
                                     "details — the live speed graph shows every connection.</span>")
                          .arg(theme::current().textMuted), page));
    connect(m_testBtn, &QPushButton::clicked, this, &FirstRunWizard::startTestDownload);
    return page;
}

void FirstRunWizard::startTestDownload()
{
    if (m_testId >= 0)
        return;

    // Wire the engine up ONCE: a retry after a failed attempt would otherwise
    // leave the previous run's handlers connected and double-report progress.
    if (!m_testWired) {
        m_testWired = true;
        connect(m_engine, &DownloadEngine::taskProgress, this,
                [this](int id, qint64 done, qint64 total, double bps) {
            if (id != m_testId)
                return;
            if (total > 0)
                m_testBar->setValue(int(done * 100 / total));
            m_testStatus->setText(tr("%1 of %2 · %3")
                                      .arg(humanSize(done),
                                           total > 0 ? humanSize(total) : QStringLiteral("?"),
                                           humanSpeed(bps)));
        });
        connect(m_engine, &DownloadEngine::taskFinished, this, [this](int id) {
            if (id != m_testId)
                return;
            const double secs = qMax(0.001, (QDateTime::currentMSecsSinceEpoch() - m_testStartedMs) / 1000.0);
            m_testBar->setValue(100);
            m_testStatus->setText(QStringLiteral("Done — 10 MB in %1 s (about %2 average). "
                                                 "That's the segmented engine; larger files gain even more.")
                                      .arg(QString::number(secs, 'f', 1),
                                           humanSpeed(10.0 * 1024 * 1024 / secs)));
        });
        connect(m_engine, &DownloadEngine::taskStateChanged, this,
                [this](int id, DownloadState st, const QString &detail) {
            if (id != m_testId || st != DownloadState::Error)
                return;
            m_testStatus->setText(QStringLiteral("The test server didn't answer (%1). Your connection may be "
                                                 "offline — try any link from New download later.").arg(detail));
            m_testBtn->setEnabled(true);
            m_testId = -1;
        });
    }

    m_testBtn->setEnabled(false);
    m_testStatus->setText(tr("Connecting…"));
    m_testStartedMs = QDateTime::currentMSecsSinceEpoch();
    m_testId = m_engine->addDownload(QUrl(kTestUrl), QString(), {}, kTestName, QString(),
                                     false, /*userInitiated=*/true);
    if (m_testId < 0) {
        m_testStatus->setText(tr("Could not start the test download."));
        m_testBtn->setEnabled(true);
    }
}

void FirstRunWizard::accept()
{
    QSettings s;
    const QString dir = m_dir->text().trimmed();
    if (!dir.isEmpty()) {
        QDir().mkpath(dir);
        m_engine->setDownloadDir(dir);
        s.setValue(QStringLiteral("downloadDir"), dir);
    }
    m_engine->setAutoCategorize(m_categorize->isChecked());
    s.setValue(QStringLiteral("autoCategorize"), m_categorize->isChecked());
    s.setValue(QStringLiteral("ui/notifications"), m_notify->isChecked());
    s.setValue(QStringLiteral("clipboardMonitor"), m_clipboard->isChecked());
    // Tidy the test file away — the point was the speed, not the bytes.
    if (m_testId >= 0 && m_engine->stateOf(m_testId) == DownloadState::Completed)
        m_engine->remove(m_testId, /*deleteFile=*/true);
    markDone();
    QWizard::accept();
}

} // namespace nexa
