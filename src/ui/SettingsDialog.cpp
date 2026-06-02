#include "ui/SettingsDialog.h"
#include "core/DownloadEngine.h"

#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QFormLayout>
#include <QLabel>
#include <QLineEdit>
#include <QSpinBox>
#include <QDoubleSpinBox>
#include <QCheckBox>
#include <QPushButton>
#include <QDialogButtonBox>
#include <QFileDialog>
#include <QMessageBox>
#include <QScrollArea>
#include <QFrame>
#include <QScreen>
#include <QGuiApplication>
#include <QSettings>

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

QLabel *sectionHeader(const QString &text, QWidget *parent)
{
    auto *l = new QLabel(text, parent);
    l->setStyleSheet(QStringLiteral("color:#c7d2fe; font-weight:700; font-size:12px; "
                                    "margin-top:6px;"));
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
    engine->setTorrentSpeedLimits(s.value(QLatin1String(kTorrentDl), 0).toInt() * 1024,
                                  s.value(QLatin1String(kTorrentUl), 0).toInt() * 1024);
    engine->setSeedRatio(s.value(QLatin1String(kSeedRatio), 0.0).toDouble());
    engine->setAiRename(s.value(QLatin1String(kAiRename), false).toBool());
}

SettingsDialog::SettingsDialog(DownloadEngine *engine, QWidget *parent)
    : QDialog(parent), m_engine(engine)
{
    setWindowTitle(QStringLiteral("Settings"));
    setMinimumWidth(460);
    // Lock the height (the scroll area handles the long form). The height is
    // FIXED so the window can't be dragged taller/shorter — vertical resizing
    // used to reflow the form and leave the bottom shifting around with a gap.
    // Kept under the screen height so it always fits.
    int h = 660;
    if (QScreen *s = QGuiApplication::primaryScreen())
        h = qMin(h, s->availableGeometry().height() - 80);
    setFixedHeight(qMax(360, h));
    // Make spin boxes / checkboxes legible on the dark theme.
    setStyleSheet(QStringLiteral(
        "QSpinBox, QDoubleSpinBox, QLineEdit { background:#0e1424; border:1px solid #232b42;"
        " border-radius:8px; padding:5px 8px; color:#e6edf3; }"
        "QSpinBox:focus, QDoubleSpinBox:focus, QLineEdit:focus { border-color:#3949ab; }"
        "QCheckBox { color:#cbd5e1; }"));

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
    auto *browse = new QPushButton(QStringLiteral("Browse…"), plate);
    browse->setCursor(Qt::PointingHandCursor);
    dirRow->addWidget(m_dir, 1);
    dirRow->addWidget(browse);
    gen->addRow(QStringLiteral("Download folder"), dirRow);
    v->addLayout(gen);

    m_categorize = new QCheckBox(QStringLiteral("Sort completed files into type subfolders "
                                                "(Video/, Audio/, …)"), plate);
    m_categorize->setChecked(m_engine->autoCategorize());
    v->addWidget(m_categorize);
    m_clipboard = new QCheckBox(QStringLiteral("Monitor the clipboard for download links"), plate);
    m_clipboard->setChecked(st.value(QLatin1String(kClipboard), false).toBool());
    v->addWidget(m_clipboard);

    // ---- Downloads --------------------------------------------------------
    v->addWidget(sectionHeader(QStringLiteral("Downloads"), plate));
    auto *dl = new QFormLayout;
    dl->setLabelAlignment(Qt::AlignRight);
    m_maxConc = new QSpinBox(plate);
    m_maxConc->setRange(1, 32);
    m_maxConc->setValue(m_engine->maxConcurrent());
    dl->addRow(QStringLiteral("Max simultaneous downloads"), m_maxConc);

    m_speedKB = new QSpinBox(plate);
    m_speedKB->setRange(0, 1024 * 1024);   // up to 1 GB/s
    m_speedKB->setSingleStep(128);
    m_speedKB->setSuffix(QStringLiteral(" KB/s"));
    m_speedKB->setSpecialValueText(QStringLiteral("Unlimited"));   // shown at 0
    m_speedKB->setValue(int(m_engine->speedLimit() / 1024));
    dl->addRow(QStringLiteral("Global speed limit"), m_speedKB);

    m_streamConc = new QSpinBox(plate);
    m_streamConc->setRange(1, 64);
    m_streamConc->setValue(m_engine->streamConcurrency());
    dl->addRow(QStringLiteral("HLS stream connections"), m_streamConc);

    m_plConc = new QSpinBox(plate);
    m_plConc->setRange(1, 8);
    m_plConc->setValue(m_engine->playlistConcurrency());
    dl->addRow(QStringLiteral("Playlist videos in parallel"), m_plConc);
    v->addLayout(dl);

    // ---- Video (yt-dlp) ---------------------------------------------------
    v->addWidget(sectionHeader(QStringLiteral("Video sites (yt-dlp)"), plate));
    m_subs = new QCheckBox(QStringLiteral("Download and embed subtitles"), plate);
    m_subs->setChecked(m_engine->subtitlesEnabled());
    v->addWidget(m_subs);
    auto *subForm = new QFormLayout;
    subForm->setLabelAlignment(Qt::AlignRight);
    m_subLangs = new QLineEdit(m_engine->subtitleLangs(), plate);
    m_subLangs->setPlaceholderText(QStringLiteral("e.g. en,en-US,ur"));
    subForm->addRow(QStringLiteral("Subtitle languages"), m_subLangs);
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
        sb->setSpecialValueText(QStringLiteral("Unlimited"));
        sb->setValue(initialBytes / 1024);
        return sb;
    };
    m_torrentDlKB = makeKB(m_engine->torrentDownloadLimit());
    m_torrentUlKB = makeKB(m_engine->torrentUploadLimit());
    tor->addRow(QStringLiteral("Download limit"), m_torrentDlKB);
    tor->addRow(QStringLiteral("Upload limit"), m_torrentUlKB);
    m_seedRatio = new QDoubleSpinBox(plate);
    m_seedRatio->setRange(0.0, 100.0);
    m_seedRatio->setSingleStep(0.1);
    m_seedRatio->setDecimals(2);
    m_seedRatio->setSpecialValueText(QStringLiteral("Don't seed"));   // shown at 0
    m_seedRatio->setValue(m_engine->seedRatio());
    tor->addRow(QStringLiteral("Seed to ratio"), m_seedRatio);
    v->addLayout(tor);

    // ---- AI + history -----------------------------------------------------
    v->addWidget(sectionHeader(QStringLiteral("AI & history"), plate));
    m_aiRename = new QCheckBox(QStringLiteral("Auto-rename files to clean names on completion"), plate);
    m_aiRename->setChecked(m_engine->aiRename());
    if (!m_engine->aiAvailable()) {
        m_aiRename->setEnabled(false);
        m_aiRename->setToolTip(QStringLiteral("Set ANTHROPIC_API_KEY and restart to enable AI features."));
    }
    v->addWidget(m_aiRename);

    auto *clearBtn = new QPushButton(QStringLiteral("Clear completed downloads"), plate);
    clearBtn->setCursor(Qt::PointingHandCursor);
    v->addWidget(clearBtn, 0, Qt::AlignLeft);

    // ---- Buttons (outside the scroll area, so they're always visible) -----
    auto *btns = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel, this);
    if (auto *ok = btns->button(QDialogButtonBox::Ok)) {
        ok->setObjectName(QStringLiteral("Primary"));
        ok->setText(QStringLiteral("Save"));
    }
    outer->addWidget(btns);

    connect(browse, &QPushButton::clicked, this, [this]() {
        const QString d = QFileDialog::getExistingDirectory(
            this, QStringLiteral("Choose download folder"), m_dir->text());
        if (!d.isEmpty())
            m_dir->setText(d);
    });
    connect(clearBtn, &QPushButton::clicked, this, [this, clearBtn]() {
        const int n = m_engine->clearCompleted();
        clearBtn->setText(QStringLiteral("Cleared %1 completed").arg(n));
        clearBtn->setEnabled(false);
    });
    connect(btns, &QDialogButtonBox::accepted, this, [this]() { apply(); accept(); });
    connect(btns, &QDialogButtonBox::rejected, this, &QDialog::reject);
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

    // Persist everything (clipboard included — MainWindow re-syncs it on close).
    QSettings s;
    s.setValue(QLatin1String(kDir), dir);
    s.setValue(QLatin1String(kCategorize), m_categorize->isChecked());
    s.setValue(QLatin1String(kClipboard), m_clipboard->isChecked());
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
}

} // namespace nexa
