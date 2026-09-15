#include "ui/SettingsDialog.h"
#include "core/DownloadEngine.h"
#include "core/Logging.h"
#include "core/ProxyConfig.h"
#include "ui/Theme.h"
#include "ui/ThemeGalleryDialog.h"
#include "ui/Localization.h"
#include "core/VirusScanner.h"

#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QFormLayout>
#include <QLabel>
#include <QLineEdit>
#include <QSpinBox>
#include <QDoubleSpinBox>
#include <QCheckBox>
#include <QComboBox>
#include <QPushButton>
#include <QDialogButtonBox>
#include <QFileDialog>
#include <QMessageBox>
#include <QScrollArea>
#include <QFrame>
#include <QScreen>
#include <QGuiApplication>
#include <QSettings>
#include <QClipboard>
#include <QApplication>
#include <QStandardItemModel>
#include <QSignalBlocker>
#include <QDesktopServices>
#include <QFont>
#include "license/LicenseManager.h"

namespace nexa {

namespace {
// QSettings keys (org/app are set in main()). Keep in one place so the dialog
// and loadInto() can't drift apart.
constexpr auto kDir        = "downloadDir";
constexpr auto kCategorize = "autoCategorize";
constexpr auto kClipboard  = "clipboardMonitor";
constexpr auto kMaxConc    = "maxConcurrent";
constexpr auto kSpeedKB    = "speedLimitKB";
constexpr auto kStreamConc = "streamConcurrency";
constexpr auto kPlConc     = "playlistConcurrency";
constexpr auto kSubs       = "subtitlesEnabled";
constexpr auto kSubLangs   = "subtitleLangs";
constexpr auto kTorrentDl  = "torrentDlKB";
constexpr auto kTorrentUl  = "torrentUlKB";
constexpr auto kSeedRatio  = "seedRatio";
constexpr auto kAiRename   = "aiRename";
constexpr auto kErrLog     = "errorLogging";
constexpr auto kConfirmStart  = "ui/confirmBeforeStart";   // IDM-style ask-before-download
constexpr auto kShowComplete  = "ui/showCompleteDialog";   // IDM-style completion prompt
constexpr auto kNotify        = "ui/notifications";        // tray balloons on finish/fail
constexpr auto kAutoUpdate    = "updates/auto";            // silent daily check
constexpr auto kWhenDone      = "ui/whenDone";             // none|folder|sleep|shutdown
constexpr auto kDashEnabled   = "dashboard/enabled";
constexpr auto kDashPort      = "dashboard/port";
constexpr auto kDashLan       = "dashboard/lan";
constexpr auto kDashUrl       = "dashboard/currentUrl";    // written by main() when running
constexpr auto kVirusScan     = "security/virusScan";
constexpr auto kVirusCmd      = "security/virusScanCommand";
constexpr auto kLanguage      = "ui/language";             // empty = follow the system
constexpr auto kProxyMode     = "proxy/mode";              // none | system | http | socks5
constexpr auto kProxyHost     = "proxy/host";
constexpr auto kProxyPort     = "proxy/port";
constexpr auto kProxyUser     = "proxy/user";
constexpr auto kProxyPass     = "proxy/password";

QLabel *sectionHeader(const QString &text, QWidget *parent)
{
    auto *l = new QLabel(text, parent);
    l->setObjectName(QStringLiteral("SectionHead"));   // coloured by the active theme
    l->setStyleSheet(QStringLiteral("margin-top:6px;"));
    return l;
}
} // namespace

void SettingsDialog::loadInto(DownloadEngine *engine)
{
    if (!engine)
        return;
    QSettings s;
    const QString dir = s.value(QLatin1String(kDir)).toString();
    if (!dir.isEmpty())
        engine->setDownloadDir(dir);
    engine->setAutoCategorize(s.value(QLatin1String(kCategorize), true).toBool());
    engine->setMaxConcurrent(s.value(QLatin1String(kMaxConc), 4).toInt());
    engine->setSpeedLimit(qint64(s.value(QLatin1String(kSpeedKB), 0).toInt()) * 1024);
    engine->setStreamConcurrency(s.value(QLatin1String(kStreamConc), 16).toInt());
    engine->setPlaylistConcurrency(s.value(QLatin1String(kPlConc), 3).toInt());
    engine->setSubtitles(s.value(QLatin1String(kSubs), false).toBool(),
                         s.value(QLatin1String(kSubLangs), QStringLiteral("en")).toString());
    engine->setTorrentSpeedLimits(qBound(0, s.value(QLatin1String(kTorrentDl), 0).toInt(), 1048576) * 1024,
                                  qBound(0, s.value(QLatin1String(kTorrentUl), 0).toInt(), 1048576) * 1024);
    engine->setSeedRatio(s.value(QLatin1String(kSeedRatio), 0.0).toDouble());
    engine->setAiRename(s.value(QLatin1String(kAiRename), false).toBool());
    engine->setConfirmBeforeStart(s.value(QLatin1String(kConfirmStart), true).toBool());
    setLoggingEnabled(s.value(QLatin1String(kErrLog), false).toBool());
}

SettingsDialog::SettingsDialog(DownloadEngine *engine, QWidget *parent)
    : QDialog(parent), m_engine(engine)
{
    setWindowTitle(tr("Settings"));
    setMinimumWidth(460);
    // Lock the height (the scroll area handles the long form). The height is
    // FIXED so the window can't be dragged taller/shorter — vertical resizing
    // used to reflow the form and leave the bottom shifting around with a gap.
    // Kept under the screen height so it always fits.
    int h = 660;
    if (QScreen *s = QGuiApplication::primaryScreen())
        h = qMin(h, s->availableGeometry().height() - 80);
    setFixedHeight(qMax(360, h));

    auto *outer = new QVBoxLayout(this);
    outer->setContentsMargins(14, 14, 14, 14);
    outer->setSpacing(10);

    // The form is long; put it in a scroll area so the dialog fits on small
    // screens. The OK/Cancel row lives OUTSIDE the scroll area (added at the
    // end) so Save/Cancel are always reachable without scrolling.
    auto *scroll = new QScrollArea(this);
    scroll->setWidgetResizable(true);
    scroll->setFrameShape(QFrame::NoFrame);
    scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    scroll->viewport()->setStyleSheet(QStringLiteral("background:transparent;"));
    outer->addWidget(scroll, 1);

    auto *plate = new QWidget;            // QScrollArea::setWidget takes ownership
    plate->setObjectName(QStringLiteral("Plate"));
    scroll->setWidget(plate);
    auto *v = new QVBoxLayout(plate);
    v->setContentsMargins(18, 16, 18, 16);
    v->setSpacing(8);

    QSettings st;

    // ---- General ----------------------------------------------------------
    v->addWidget(sectionHeader(QStringLiteral("General"), plate));
    auto *gen = new QFormLayout;
    gen->setLabelAlignment(Qt::AlignRight);
    auto *dirRow = new QHBoxLayout;
    m_dir = new QLineEdit(m_engine->downloadDir(), plate);
    auto *browse = new QPushButton(tr("Browse…"), plate);
    browse->setCursor(Qt::PointingHandCursor);
    dirRow->addWidget(m_dir, 1);
    dirRow->addWidget(browse);
    gen->addRow(tr("Download folder"), dirRow);
    m_whenDone = new QComboBox(plate);
    m_whenDone->addItem(tr("Do nothing"), QStringLiteral("none"));
    m_whenDone->addItem(tr("Open the download folder"), QStringLiteral("folder"));
    m_whenDone->addItem(tr("Put the computer to sleep"), QStringLiteral("sleep"));
    m_whenDone->addItem(tr("Shut down the computer"), QStringLiteral("shutdown"));
    {
        const int idx = m_whenDone->findData(st.value(QLatin1String(kWhenDone), QStringLiteral("none")).toString());
        m_whenDone->setCurrentIndex(qMax(0, idx));
    }
    m_whenDone->setToolTip(tr("Runs once, after the last active download finishes (60-second countdown you can cancel)."));
    gen->addRow(tr("When all downloads finish"), m_whenDone);
    // Appearance: the full theme list inline, plus a gallery for people who
    // would rather see the looks than read their names.
    //
    // Paid themes are listed — the gallery is the upgrade's best advert — but
    // disabled and marked, and never applied. This dropdown used to be the one
    // place with no entitlement check at all: every theme the gallery locks
    // behind a PRO badge could be picked from here in two clicks and persisted.
    m_themeOnOpen = theme::savedId();
    const Entitlements &features = m_engine->license()->features();
    auto themeAllowed = [features](const QString &id) { return features.allowsTheme(id); };
    auto *themeRow = new QHBoxLayout;
    m_theme = new QComboBox(plate);
    for (const theme::ThemeInfo &t : theme::available()) {
        QString label = t.automatic
            ? t.name
            : QStringLiteral("%1 — %2").arg(t.dark ? tr("Dark") : tr("Light"), t.name);
        const bool allowed = themeAllowed(t.id);
        if (!allowed)
            label += tr(" (Pro)");
        m_theme->addItem(label, t.id);
        const int row = m_theme->count() - 1;
        m_theme->setItemData(row, allowed ? t.tagline
                                          : tr("Part of the Pro theme collection."), Qt::ToolTipRole);
        if (!allowed) {
            // Visible but not selectable: a QStandardItemModel row without the
            // enabled flag is greyed out and skipped by keyboard navigation.
            if (auto *model = qobject_cast<QStandardItemModel *>(m_theme->model()))
                if (QStandardItem *item = model->item(row))
                    item->setFlags(item->flags() & ~(Qt::ItemIsEnabled | Qt::ItemIsSelectable));
        }
    }
    m_theme->setCurrentIndex(qMax(0, m_theme->findData(theme::savedId())));
    auto *themeBrowse = new QPushButton(tr("Browse themes…"), plate);
    themeBrowse->setCursor(Qt::PointingHandCursor);
    themeBrowse->setToolTip(tr("See every theme as a live preview."));
    themeRow->addWidget(m_theme, 1);
    themeRow->addWidget(themeBrowse);
    gen->addRow(tr("Appearance"), themeRow);
    // Paid themes stay visible but unselectable — the same upsell the gallery
    // makes, without the dropdown handing them over for free. Until this ran,
    // picking any of the 64 paid themes here needed no licence at all.
    refreshThemeEntitlement();
    if (LicenseManager *license = m_engine->license()) {
        connect(license, &LicenseManager::featuresChanged, this,
                [this](const Entitlements &) { refreshThemeEntitlement(); });
    }
    // The combo previews live too — a theme you cannot see is hard to choose.
    connect(m_theme, &QComboBox::currentIndexChanged, this, [this](int) {
        const QString id = m_theme->currentData().toString();
        // Belt and braces: disabled items cannot normally be reached with the
        // mouse, but keyboard navigation and setCurrentIndex() can still land
        // on one. A locked theme must never be applied, not even as a preview.
        if (!allowsTheme(id)) {
            const QSignalBlocker block(m_theme);
            m_theme->setCurrentIndex(qMax(0, m_theme->findData(theme::savedId())));
            return;
        }
        applyThemePreview(id);
    });
    connect(themeBrowse, &QPushButton::clicked, this, [this, features]() {
        ThemeGalleryDialog dlg(this);
        // Same entitlement the main window's gallery gets; opened from here it
        // used to show every theme unlocked.
        dlg.setThemeEntitlement(features.themes == QLatin1String("all"), features.freeThemes);
        connect(&dlg, &ThemeGalleryDialog::lockedThemeChosen, this,
                [&dlg](const QString &, const QString &name) {
            QMessageBox::information(&dlg, tr("Pro theme"),
                tr("“%1” is part of the Pro theme collection.\n\nFree includes Nexa Dark and "
                   "Nexa Light. Start the free 7-day trial, or see "
                   "nexadownloadmanager.com/pricing to unlock all themes.").arg(name));
        });
        connect(&dlg, &ThemeGalleryDialog::themeApplied, this, [this](const QString &id) {
            const QSignalBlocker block(m_theme);      // already applied; just re-sync
            m_theme->setCurrentIndex(qMax(0, m_theme->findData(id)));
            emit themeChanged();                      // let the main window redraw
        });
        dlg.exec();
        const QSignalBlocker block(m_theme);
        m_theme->setCurrentIndex(qMax(0, m_theme->findData(theme::savedId())));
    });
    m_language = new QComboBox(plate);
    for (const i18n::Language &lang : i18n::available()) {
        const QString label = lang.code.isEmpty() || lang.nativeName == lang.englishName
            ? lang.englishName
            : QStringLiteral("%1 — %2").arg(lang.nativeName, lang.englishName);
        m_language->addItem(label, lang.code);
    }
    m_language->setCurrentIndex(qMax(0, m_language->findData(i18n::savedLanguage())));
    m_language->setToolTip(tr("Takes effect the next time Nexa starts."));
    gen->addRow(tr("Language"), m_language);
    v->addLayout(gen);

    m_categorize = new QCheckBox(QStringLiteral("Sort completed files into type subfolders "
                                                "(Video/, Audio/, …)"), plate);
    m_categorize->setChecked(m_engine->autoCategorize());
    v->addWidget(m_categorize);
    m_clipboard = new QCheckBox(tr("Monitor the clipboard for download links"), plate);
    m_clipboard->setChecked(st.value(QLatin1String(kClipboard), false).toBool());
    v->addWidget(m_clipboard);
    m_confirmStart = new QCheckBox(QStringLiteral("Ask before starting a download "
                                                 "(confirm the file & save location first)"), plate);
    m_confirmStart->setChecked(st.value(QLatin1String(kConfirmStart), true).toBool());
    v->addWidget(m_confirmStart);
    m_showComplete = new QCheckBox(tr("Show a dialog when a download completes"), plate);
    m_showComplete->setChecked(st.value(QLatin1String(kShowComplete), true).toBool());
    v->addWidget(m_showComplete);
    m_notify = new QCheckBox(tr("Show desktop notifications when a download finishes or fails"), plate);
    m_notify->setChecked(st.value(QLatin1String(kNotify), true).toBool());
    m_notify->setToolTip(tr("Shown from the tray icon when Nexa is in the background."));
    v->addWidget(m_notify);
    m_autoUpdate = new QCheckBox(tr("Check for updates automatically (once a day)"), plate);
    m_autoUpdate->setChecked(st.value(QLatin1String(kAutoUpdate), true).toBool());
    v->addWidget(m_autoUpdate);

    // ---- Downloads --------------------------------------------------------
    v->addWidget(sectionHeader(QStringLiteral("Downloads"), plate));
    auto *dl = new QFormLayout;
    dl->setLabelAlignment(Qt::AlignRight);
    m_maxConc = new QSpinBox(plate);
    m_maxConc->setRange(1, 32);
    m_maxConc->setValue(m_engine->maxConcurrent());
    dl->addRow(tr("Max simultaneous downloads"), m_maxConc);

    m_speedKB = new QSpinBox(plate);
    m_speedKB->setRange(0, 1024 * 1024);   // up to 1 GB/s
    m_speedKB->setSingleStep(128);
    m_speedKB->setSuffix(QStringLiteral(" KB/s"));
    m_speedKB->setSpecialValueText(tr("Unlimited"));   // shown at 0
    m_speedKB->setValue(int(m_engine->speedLimit() / 1024));
    dl->addRow(tr("Global speed limit"), m_speedKB);

    m_streamConc = new QSpinBox(plate);
    m_streamConc->setRange(1, 64);
    m_streamConc->setValue(m_engine->streamConcurrency());
    m_streamConc->setToolTip(tr("Parallel segment fetches for login-gated streams, which Nexa "
                                "downloads itself. Public streams are handled by FFmpeg, which "
                                "manages its own connections."));
    dl->addRow(tr("HLS stream connections"), m_streamConc);

    m_plConc = new QSpinBox(plate);
    m_plConc->setRange(1, 8);
    m_plConc->setValue(m_engine->playlistConcurrency());
    dl->addRow(tr("Playlist videos in parallel"), m_plConc);
    v->addLayout(dl);

    // ---- Video sites ------------------------------------------------------
    v->addWidget(sectionHeader(QStringLiteral("Video sites"), plate));
    m_subs = new QCheckBox(tr("Download and embed subtitles"), plate);
    m_subs->setChecked(m_engine->subtitlesEnabled());
    v->addWidget(m_subs);
    auto *subForm = new QFormLayout;
    subForm->setLabelAlignment(Qt::AlignRight);
    m_subLangs = new QLineEdit(m_engine->subtitleLangs(), plate);
    m_subLangs->setPlaceholderText(tr("e.g. en,en-US,ur"));
    subForm->addRow(tr("Subtitle languages"), m_subLangs);
    v->addLayout(subForm);
    auto syncSubs = [this]() { m_subLangs->setEnabled(m_subs->isChecked()); };
    connect(m_subs, &QCheckBox::toggled, this, syncSubs);
    syncSubs();

    // ---- BitTorrent -------------------------------------------------------
    v->addWidget(sectionHeader(QStringLiteral("BitTorrent"), plate));
    auto *tor = new QFormLayout;
    tor->setLabelAlignment(Qt::AlignRight);
    auto makeKB = [&](int initialBytes) {
        auto *sb = new QSpinBox(plate);
        sb->setRange(0, 1024 * 1024);
        sb->setSingleStep(128);
        sb->setSuffix(QStringLiteral(" KB/s"));
        sb->setSpecialValueText(tr("Unlimited"));
        sb->setValue(initialBytes / 1024);
        return sb;
    };
    m_torrentDlKB = makeKB(m_engine->torrentDownloadLimit());
    m_torrentUlKB = makeKB(m_engine->torrentUploadLimit());
    tor->addRow(tr("Download limit"), m_torrentDlKB);
    tor->addRow(tr("Upload limit"), m_torrentUlKB);
    m_seedRatio = new QDoubleSpinBox(plate);
    m_seedRatio->setRange(0.0, 100.0);
    m_seedRatio->setSingleStep(0.1);
    m_seedRatio->setDecimals(2);
    m_seedRatio->setSpecialValueText(tr("Don't seed"));   // shown at 0
    m_seedRatio->setValue(m_engine->seedRatio());
    tor->addRow(tr("Seed to ratio"), m_seedRatio);
    v->addLayout(tor);

    // ---- Network / proxy ----------------------------------------------------
    v->addWidget(sectionHeader(QStringLiteral("Network"), plate));
    auto *px = new QFormLayout;
    px->setLabelAlignment(Qt::AlignRight);
    m_proxyMode = new QComboBox(plate);
    m_proxyMode->addItem(tr("No proxy (direct)"), QStringLiteral("none"));
    m_proxyMode->addItem(tr("Use the system proxy"), QStringLiteral("system"));
    m_proxyMode->addItem(tr("HTTP proxy"), QStringLiteral("http"));
    m_proxyMode->addItem(tr("SOCKS5 proxy"), QStringLiteral("socks5"));
    {
        const int idx = m_proxyMode->findData(
            st.value(QLatin1String(kProxyMode), QStringLiteral("none")).toString());
        m_proxyMode->setCurrentIndex(qMax(0, idx));
    }
    px->addRow(tr("Connection"), m_proxyMode);
    auto *proxyAddr = new QHBoxLayout;
    m_proxyHost = new QLineEdit(st.value(QLatin1String(kProxyHost)).toString(), plate);
    m_proxyHost->setPlaceholderText(QStringLiteral("127.0.0.1"));
    m_proxyPort = new QSpinBox(plate);
    m_proxyPort->setRange(0, 65535);
    m_proxyPort->setValue(st.value(QLatin1String(kProxyPort), 0).toInt());
    m_proxyPort->setSpecialValueText(QStringLiteral("—"));
    proxyAddr->addWidget(m_proxyHost, 1);
    proxyAddr->addWidget(m_proxyPort);
    px->addRow(tr("Address"), proxyAddr);
    m_proxyUser = new QLineEdit(st.value(QLatin1String(kProxyUser)).toString(), plate);
    m_proxyUser->setPlaceholderText(QStringLiteral("optional"));
    px->addRow(tr("Username"), m_proxyUser);
    m_proxyPass = new QLineEdit(st.value(QLatin1String(kProxyPass)).toString(), plate);
    m_proxyPass->setEchoMode(QLineEdit::Password);
    m_proxyPass->setPlaceholderText(QStringLiteral("optional"));
    px->addRow(tr("Password"), m_proxyPass);
    v->addLayout(px);
    auto *proxyNote = new QLabel(plate);
    proxyNote->setWordWrap(true);
    proxyNote->setObjectName(QStringLiteral("Muted"));
    proxyNote->setText(QStringLiteral("Applies to downloads, video sites and licensing. "
                                      "Credentials are stored in your Nexa settings file."));
    v->addWidget(proxyNote);
    auto syncProxyRows = [this]() {
        const QString mode = m_proxyMode->currentData().toString();
        const bool explicitProxy = mode == QLatin1String("http") || mode == QLatin1String("socks5");
        for (QWidget *w : {static_cast<QWidget*>(m_proxyHost), static_cast<QWidget*>(m_proxyPort),
                           static_cast<QWidget*>(m_proxyUser), static_cast<QWidget*>(m_proxyPass)})
            w->setEnabled(explicitProxy);
    };
    syncProxyRows();
    connect(m_proxyMode, &QComboBox::currentIndexChanged, this,
            [syncProxyRows](int) { syncProxyRows(); });

    // ---- Remote dashboard ---------------------------------------------------
    v->addWidget(sectionHeader(QStringLiteral("Remote dashboard (control from your phone)"), plate));
    m_dashEnabled = new QCheckBox(tr("Run the web dashboard while Nexa is open"), plate);
    m_dashEnabled->setChecked(st.value(QLatin1String(kDashEnabled), false).toBool());
    v->addWidget(m_dashEnabled);
    auto *dash = new QFormLayout;
    dash->setLabelAlignment(Qt::AlignRight);
    m_dashPort = new QSpinBox(plate);
    m_dashPort->setRange(1024, 65535);
    m_dashPort->setValue(st.value(QLatin1String(kDashPort), 8088).toInt());
    dash->addRow(tr("Port"), m_dashPort);
    v->addLayout(dash);
    m_dashLan = new QCheckBox(tr("Reachable from other devices on my network (needs NEXA_TLS_CERT / NEXA_TLS_KEY)"), plate);
    m_dashLan->setChecked(st.value(QLatin1String(kDashLan), false).toBool());
    v->addWidget(m_dashLan);
    auto *urlRow = new QHBoxLayout;
    m_dashUrl = new QLabel(plate);
    m_dashUrl->setTextInteractionFlags(Qt::TextSelectableByMouse);
    m_dashUrl->setWordWrap(true);
    m_dashUrl->setObjectName(QStringLiteral("Muted"));
    m_dashUrl->setStyleSheet(QStringLiteral("font-family: monospace;"));
    auto *copyUrl = new QPushButton(tr("Copy link"), plate);
    copyUrl->setCursor(Qt::PointingHandCursor);
    urlRow->addWidget(m_dashUrl, 1);
    urlRow->addWidget(copyUrl);
    v->addLayout(urlRow);
    auto refreshDashUrl = [this]() {
        const QString url = QSettings().value(QLatin1String(kDashUrl)).toString();
        m_dashUrl->setText(url.isEmpty()
            ? QStringLiteral("Not running. Turn it on and press Save; the link (with its access token) appears here.")
            : url);
    };
    refreshDashUrl();
    connect(copyUrl, &QPushButton::clicked, this, [this]() {
        const QString url = QSettings().value(QLatin1String(kDashUrl)).toString();
        if (!url.isEmpty())
            QApplication::clipboard()->setText(url);
    });
    connect(this, &SettingsDialog::settingsApplied, this, refreshDashUrl);

    // ---- Account -----------------------------------------------------------
    //
    // Signing in is the way in: the plan follows the account, so a trial, an
    // upgrade or a team invitation reaches this machine with nothing to paste
    // and no key to keep secret. Manual activation still exists — an older
    // build, or a machine set up without a browser — but it is folded away
    // behind a link rather than being the first thing anybody sees.
    v->addWidget(sectionHeader(QStringLiteral("Account"), plate));
    LicenseManager *license = m_engine->license();

    m_licenseStatus = new QLabel(license->status(), plate);
    m_licenseStatus->setWordWrap(true);
    m_licenseStatus->setObjectName(QStringLiteral("Muted"));
    v->addWidget(m_licenseStatus);

    // --- signed out: sign in, or reveal the key row
    m_accountSignedOut = new QWidget(plate);
    {
        auto *col = new QVBoxLayout(m_accountSignedOut);
        col->setContentsMargins(0, 0, 0, 0);
        auto *buttons = new QHBoxLayout;
        auto *signIn = new QPushButton(tr("Sign in with Nexa"), m_accountSignedOut);
        auto *useKey = new QPushButton(tr("Use a license key instead"), m_accountSignedOut);
        useKey->setFlat(true);
        useKey->setCursor(Qt::PointingHandCursor);
        buttons->addWidget(signIn);
        buttons->addWidget(useKey);
        buttons->addStretch(1);
        col->addLayout(buttons);
        auto *hint = new QLabel(tr("Your plan follows your account — there is no key to copy. "
                                   "A browser window opens so you can approve this computer."),
                                m_accountSignedOut);
        hint->setObjectName(QStringLiteral("Muted"));
        hint->setWordWrap(true);
        col->addWidget(hint);
        connect(signIn, &QPushButton::clicked, this, [this]() {
            if (m_licenseStatus)
                m_licenseStatus->setText(tr("Starting sign-in…"));
            m_engine->license()->beginSignIn();
        });
        connect(useKey, &QPushButton::clicked, this, [this]() {
            if (m_keyRow)
                m_keyRow->setVisible(!m_keyRow->isVisible());
        });
    }
    v->addWidget(m_accountSignedOut);

    // --- waiting: the code has to match what the website shows
    m_accountWaiting = new QWidget(plate);
    {
        auto *col = new QVBoxLayout(m_accountWaiting);
        col->setContentsMargins(0, 0, 0, 0);
        auto *ask = new QLabel(tr("Approve this computer in the browser window that opened, "
                                  "after checking it shows this code:"), m_accountWaiting);
        ask->setWordWrap(true);
        col->addWidget(ask);
        m_signInCode = new QLabel(m_accountWaiting);
        QFont codeFont = m_signInCode->font();
        codeFont.setPointSize(codeFont.pointSize() + 6);
        codeFont.setBold(true);
        codeFont.setLetterSpacing(QFont::AbsoluteSpacing, 3);
        m_signInCode->setFont(codeFont);
        m_signInCode->setTextInteractionFlags(Qt::TextSelectableByMouse);
        col->addWidget(m_signInCode);
        auto *buttons = new QHBoxLayout;
        auto *openAgain = new QPushButton(tr("Open the page again"), m_accountWaiting);
        auto *copyCode = new QPushButton(tr("Copy code"), m_accountWaiting);
        auto *cancel = new QPushButton(tr("Cancel"), m_accountWaiting);
        buttons->addWidget(openAgain);
        buttons->addWidget(copyCode);
        buttons->addWidget(cancel);
        buttons->addStretch(1);
        col->addLayout(buttons);
        connect(openAgain, &QPushButton::clicked, this, [this]() {
            if (!m_signInUrl.isEmpty())
                QDesktopServices::openUrl(QUrl(m_signInUrl));
        });
        connect(copyCode, &QPushButton::clicked, this, [this]() {
            if (m_signInCode)
                QApplication::clipboard()->setText(m_signInCode->text());
        });
        connect(cancel, &QPushButton::clicked, this, [this]() {
            m_engine->license()->cancelSignIn();
        });
    }
    v->addWidget(m_accountWaiting);

    // --- signed in
    m_accountSignedIn = new QWidget(plate);
    {
        auto *row = new QHBoxLayout(m_accountSignedIn);
        row->setContentsMargins(0, 0, 0, 0);
        m_accountWho = new QLabel(m_accountSignedIn);
        m_accountWho->setWordWrap(true);
        row->addWidget(m_accountWho, 1);
        auto *signOut = new QPushButton(tr("Sign out"), m_accountSignedIn);
        row->addWidget(signOut);
        connect(signOut, &QPushButton::clicked, this, [this]() {
            m_engine->license()->signOut();
        });
    }
    v->addWidget(m_accountSignedIn);

    // --- manual activation, hidden until asked for
    m_keyRow = new QWidget(plate);
    {
        auto *licenseForm = new QFormLayout(m_keyRow);
        licenseForm->setContentsMargins(0, 0, 0, 0);
        licenseForm->setLabelAlignment(Qt::AlignRight);
        m_licenseKey = new QLineEdit(m_keyRow);
        m_licenseKey->setPlaceholderText(tr("NDM-XXXX-XXXX-XXXX"));
        m_licenseKey->setEchoMode(QLineEdit::Password);
        m_licenseKey->setText(QString());
        auto *licenseRow = new QHBoxLayout;
        licenseRow->addWidget(m_licenseKey, 1);
        auto *activate = new QPushButton(tr("Activate"), m_keyRow);
        auto *remove = new QPushButton(tr("Remove"), m_keyRow);
        licenseRow->addWidget(activate);
        licenseRow->addWidget(remove);
        licenseForm->addRow(tr("License key"), licenseRow);
        connect(activate, &QPushButton::clicked, this, [this]() {
            m_engine->license()->activate(m_licenseKey->text());
        });
        connect(remove, &QPushButton::clicked, this, [this]() {
            m_engine->license()->deactivate();
            m_licenseKey->clear();
        });
    }
    m_keyRow->setVisible(false);
    v->addWidget(m_keyRow);

    connect(license, &LicenseManager::statusChanged,
            this, [this](const QString &status) {
        if (m_licenseStatus)
            m_licenseStatus->setText(status);
    });
    connect(license, &LicenseManager::activationFinished,
            this, [this](bool, const QString &message) {
        if (m_licenseStatus)
            m_licenseStatus->setText(message);
        updateAccountSection();
    });
    // The browser is opened from here, not from LicenseManager: the licence
    // layer links no GUI module, which is what keeps it testable headless.
    connect(license, &LicenseManager::signInCodeReady, this,
            [this](const QString &code, const QString &url) {
        m_signInUrl = url;
        if (m_signInCode)
            m_signInCode->setText(code);
        if (m_licenseStatus)
            m_licenseStatus->setText(tr("Waiting for you to approve this computer…"));
        updateAccountSection();
        QDesktopServices::openUrl(QUrl(url));
    });
    connect(license, &LicenseManager::signInFinished, this,
            [this](bool, const QString &message) {
        if (m_licenseStatus)
            m_licenseStatus->setText(message);
        updateAccountSection();
    });
    connect(license, &LicenseManager::accountChanged, this,
            [this](const QString &) { updateAccountSection(); });
    updateAccountSection();

    // ---- AI + history -----------------------------------------------------
    v->addWidget(sectionHeader(QStringLiteral("AI & history"), plate));
    m_aiRename = new QCheckBox(tr("Auto-rename files to clean names on completion"), plate);
    m_aiRename->setChecked(m_engine->aiRename());
    if (!m_engine->aiAvailable()) {
        m_aiRename->setEnabled(false);
        m_aiRename->setToolTip(tr("AI features need an active Pro or Team license."));
    }
    v->addWidget(m_aiRename);

    m_virusScan = new QCheckBox(tr("Scan finished downloads for malware"), plate);
    m_virusScan->setChecked(st.value(QLatin1String(kVirusScan), false).toBool());
    v->addWidget(m_virusScan);
    m_virusCmd = new QLineEdit(st.value(QLatin1String(kVirusCmd)).toString(), plate);
    m_virusCmd->setPlaceholderText(VirusScanner::defaultCommandTemplate());
    m_virusCmd->setToolTip(tr("Command to run, with %1 standing for the downloaded file. "
                              "Leave empty to use your system's scanner."));
    v->addWidget(m_virusCmd);
    {
        auto *scanNote = new QLabel(plate);
        scanNote->setObjectName(QStringLiteral("Muted"));
        scanNote->setWordWrap(true);
        scanNote->setText(VirusScanner::scannerAvailable()
            ? tr("Scanner found on this computer.")
            : tr("No scanner found yet — install ClamAV (or set a command above) to use this."));
        v->addWidget(scanNote);
    }

    m_errLog = new QCheckBox(tr("Save error logs to a file (for troubleshooting)"), plate);
    m_errLog->setChecked(st.value(QLatin1String(kErrLog), false).toBool());
    m_errLog->setToolTip(QStringLiteral("Writes warnings/errors to a small log you can export "
                                        "from the gear menu → “Export logs…”."));
    v->addWidget(m_errLog);

    // ---- Buttons (outside the scroll area, so they're always visible) -----
    auto *btns = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel, this);
    if (auto *ok = btns->button(QDialogButtonBox::Ok)) {
        ok->setObjectName(QStringLiteral("Primary"));
        ok->setText(tr("Save"));
    }
    outer->addWidget(btns);

    connect(browse, &QPushButton::clicked, this, [this]() {
        const QString d = QFileDialog::getExistingDirectory(
            this, QStringLiteral("Choose download folder"), m_dir->text());
        if (!d.isEmpty())
            m_dir->setText(d);
    });
    connect(btns, &QDialogButtonBox::accepted, this, [this]() { apply(); accept(); });
    connect(btns, &QDialogButtonBox::rejected, this, &QDialog::reject);
    // Themes preview live, so cancelling has to undo the preview as well.
    connect(this, &QDialog::rejected, this, [this]() {
        if (theme::savedId() != m_themeOnOpen)
            applyThemePreview(m_themeOnOpen);
    });
}

// Exactly one of the three account rows is visible at a time. Driven from the
// licence manager's own state rather than from what this dialog last did, so a
// sign-in finished (or revoked) while Settings is open redraws correctly.
void SettingsDialog::updateAccountSection()
{
    const LicenseManager *license = m_engine ? m_engine->license() : nullptr;
    if (!license || !m_accountSignedOut || !m_accountWaiting || !m_accountSignedIn)
        return;
    const bool waiting = license->signInInProgress();
    const bool signedIn = license->isSignedIn();
    // A sign-in started before this dialog was opened has already emitted its
    // code, so take it from the manager rather than showing an empty card.
    if (waiting) {
        if (m_signInCode && m_signInCode->text().isEmpty())
            m_signInCode->setText(license->signInCode());
        if (m_signInUrl.isEmpty())
            m_signInUrl = license->signInUrl();
    }
    m_accountWaiting->setVisible(waiting);
    m_accountSignedIn->setVisible(signedIn && !waiting);
    m_accountSignedOut->setVisible(!signedIn && !waiting);
    if (m_accountWho) {
        m_accountWho->setText(license->accountEmail().isEmpty()
            ? tr("Signed in on this computer")
            : tr("Signed in as %1").arg(license->accountEmail()));
    }
    // Manual activation belongs to the signed-out state only: a signed-in
    // machine has no use for a key, and leaving the field on screen invites
    // somebody to paste one that would then be ignored.
    if (m_keyRow && (signedIn || waiting))
        m_keyRow->setVisible(false);
}

void SettingsDialog::apply()
{
    const QString dir = m_dir->text().trimmed();
    if (!dir.isEmpty())
        m_engine->setDownloadDir(dir);
    m_engine->setAutoCategorize(m_categorize->isChecked());
    m_engine->setMaxConcurrent(m_maxConc->value());
    m_engine->setSpeedLimit(qint64(m_speedKB->value()) * 1024);
    m_engine->setStreamConcurrency(m_streamConc->value());
    m_engine->setPlaylistConcurrency(m_plConc->value());
    m_engine->setSubtitles(m_subs->isChecked(), m_subLangs->text());
    m_engine->setTorrentSpeedLimits(m_torrentDlKB->value() * 1024,
                                    m_torrentUlKB->value() * 1024);
    m_engine->setSeedRatio(m_seedRatio->value());
    m_engine->setAiRename(m_aiRename->isChecked());
    m_engine->setConfirmBeforeStart(m_confirmStart->isChecked());   // live toggle
    setLoggingEnabled(m_errLog->isChecked());   // live toggle of the file log

    // Persist everything (clipboard included — MainWindow re-syncs it on close).
    QSettings s;
    s.setValue(QLatin1String(kDir), dir);
    s.setValue(QLatin1String(kCategorize), m_categorize->isChecked());
    s.setValue(QLatin1String(kClipboard), m_clipboard->isChecked());
    s.setValue(QLatin1String(kConfirmStart), m_confirmStart->isChecked());
    s.setValue(QLatin1String(kShowComplete), m_showComplete->isChecked());
    s.setValue(QLatin1String(kNotify), m_notify->isChecked());
    s.setValue(QLatin1String(kAutoUpdate), m_autoUpdate->isChecked());
    s.setValue(QLatin1String(kWhenDone), m_whenDone->currentData().toString());
    s.setValue(QLatin1String(kDashEnabled), m_dashEnabled->isChecked());
    s.setValue(QLatin1String(kDashPort), m_dashPort->value());
    s.setValue(QLatin1String(kDashLan), m_dashLan->isChecked());
    s.setValue(QLatin1String(kProxyMode), m_proxyMode->currentData().toString());
    s.setValue(QLatin1String(kProxyHost), m_proxyHost->text().trimmed());
    s.setValue(QLatin1String(kProxyPort), m_proxyPort->value());
    s.setValue(QLatin1String(kProxyUser), m_proxyUser->text());
    s.setValue(QLatin1String(kProxyPass), m_proxyPass->text());
    s.setValue(QLatin1String(kMaxConc), m_maxConc->value());
    s.setValue(QLatin1String(kSpeedKB), m_speedKB->value());
    s.setValue(QLatin1String(kStreamConc), m_streamConc->value());
    s.setValue(QLatin1String(kPlConc), m_plConc->value());
    s.setValue(QLatin1String(kSubs), m_subs->isChecked());
    s.setValue(QLatin1String(kSubLangs), m_subLangs->text().trimmed());
    s.setValue(QLatin1String(kTorrentDl), m_torrentDlKB->value());
    s.setValue(QLatin1String(kTorrentUl), m_torrentUlKB->value());
    s.setValue(QLatin1String(kSeedRatio), m_seedRatio->value());
    s.setValue(QLatin1String(kAiRename), m_aiRename->isChecked());
    s.setValue(QLatin1String(kVirusScan), m_virusScan->isChecked());
    s.setValue(QLatin1String(kVirusCmd), m_virusCmd->text().trimmed());
    s.setValue(QLatin1String(kErrLog), m_errLog->isChecked());
    // Appearance: already live-previewed, so this only has to make it stick —
    // unless the entitlement changed underneath us while the dialog was open,
    // in which case a locked choice is dropped rather than persisted.
    QString themeKey = m_theme->currentData().toString();
    if (!m_engine->license()->features().allowsTheme(themeKey))
        themeKey = m_themeOnOpen;
    const bool themeDirty = themeKey != theme::savedId();
    theme::setSavedId(themeKey);
    // Language: Qt would need every widget rebuilt to re-translate live, so this
    // is applied on the next launch and the user is told so.
    const QString langCode = m_language->currentData().toString();
    const bool languageChanged = langCode != i18n::savedLanguage();
    i18n::setSavedLanguage(langCode);
    s.sync();
    if (themeDirty) {
        if (auto *app = qobject_cast<QApplication *>(QCoreApplication::instance()))
            theme::apply(*app);
        emit themeChanged();
    }
    if (languageChanged)
        QMessageBox::information(this, QStringLiteral("Language"),
            QStringLiteral("Nexa will switch language the next time you start it."));
    proxyconfig::applyFromSettings();   // takes effect on the next request
    emit settingsApplied();
}

void SettingsDialog::applyThemePreview(const QString &id)
{
    if (theme::savedId() == id)
        return;
    theme::setSavedId(id);
    if (auto *app = qobject_cast<QApplication *>(QCoreApplication::instance()))
        theme::apply(*app);
    emit themeChanged();
}

bool SettingsDialog::allowsTheme(const QString &id) const
{
    const LicenseManager *license = m_engine ? m_engine->license() : nullptr;
    // No licence manager at all (tests, or a partially built engine) is the
    // fail-closed case everywhere else in the app, so it is here too: only the
    // themes every install gets.
    if (!license)
        return Entitlements{}.allowsTheme(id);
    return license->allowsTheme(id);
}

void SettingsDialog::refreshThemeEntitlement()
{
    if (!m_theme)
        return;

    // QComboBox's default model is a QStandardItemModel, which is what lets an
    // individual row be disabled. If that ever stops being true the themes are
    // left selectable rather than silently unguarded, so fall back to hiding
    // the paid ones entirely instead.
    auto *model = qobject_cast<QStandardItemModel *>(m_theme->model());

    for (int i = 0; i < m_theme->count(); ++i) {
        const QString id = m_theme->itemData(i).toString();
        const bool allowed = allowsTheme(id);
        if (model && model->item(i))
            model->item(i)->setEnabled(allowed);
        m_theme->setItemData(i, allowed
                                    ? QVariant()
                                    : QVariant(tr("Included with Pro — upgrade to use this theme")),
                             Qt::ToolTipRole);
    }

    // A theme that is no longer licensed must not stay in force: a lapsed or
    // downgraded subscription would otherwise keep painting the app in a paid
    // look until the user happened to change it.
    const QString current = theme::savedId();
    if (!allowsTheme(current)) {
        QString fallback;
        for (int i = 0; i < m_theme->count() && fallback.isEmpty(); ++i) {
            const QString id = m_theme->itemData(i).toString();
            if (allowsTheme(id))
                fallback = id;
        }
        if (!fallback.isEmpty()) {
            const QSignalBlocker block(m_theme);
            m_theme->setCurrentIndex(qMax(0, m_theme->findData(fallback)));
            applyThemePreview(fallback);
        }
    } else {
        const QSignalBlocker block(m_theme);
        m_theme->setCurrentIndex(qMax(0, m_theme->findData(current)));
    }
}

} // namespace nexa
