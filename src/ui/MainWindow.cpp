#include "ui/MainWindow.h"
#include "ui/UiHelpers.h"
#include "ui/DownloadDetailsDialog.h"
#include "ui/SiteLoginsDialog.h"
#include "ui/SettingsDialog.h"
#include "ui/ClipboardMonitor.h"
#include "core/DownloadEngine.h"
#include "core/UpdateChecker.h"
#include "core/DownloadTask.h"
#include "core/Logging.h"

#include <QTableWidget>
#include <QHeaderView>
#include <QPushButton>
#include <QStatusBar>
#include <QLabel>
#include <QLineEdit>
#include <QProgressBar>
#include <QMenu>
#include <QShortcut>
#include <QKeySequence>
#include <QProcess>
#include <QFileDialog>
#include <QFile>
#include <QPainter>
#include <QPixmap>
#include <QPen>
#include <QPainterPath>
#include <QStorageInfo>
#include <QInputDialog>
#include <QMessageBox>
#include <QDialog>
#include <QDialogButtonBox>
#include <QCheckBox>
#include <QApplication>
#include <QClipboard>
#include <QSystemTrayIcon>
#include <QCloseEvent>
#include <QDesktopServices>
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QGridLayout>
#include <QDir>
#include <QWidget>
#include <QStackedWidget>
#include <QStyle>
#include <QFileInfo>
#include <QIcon>
#include <memory>
#include <QColor>
#include <QUrl>
#include <QSettings>
#include <QTimer>
#include <QDropEvent>
#include <QAbstractItemView>
#include <QScreen>
#include <QGuiApplication>
#include <functional>
#include <initializer_list>
#include <algorithm>

namespace nexa {

// Shared formatting/theming helpers now live in UiHelpers (reused by the
// per-download details dialog). Bring them into scope so the existing call
// sites below are unchanged.
using nexa::humanSize;
using nexa::humanSpeed;
using nexa::statusColor;
using nexa::statusLabel;
using nexa::fileAccent;
using nexa::paintIcon;
using nexa::paintBar;
using nexa::Accent;

namespace {

enum Column { ColFile = 0, ColSize, ColProgress, ColSpeed, ColStatus, ColActions, ColCount };

// The rows carry cell widgets (file tile, progress bar, status). Qt's built-in
// InternalMove reorders the underlying items but leaves those widgets behind,
// misaligning the table. So we fully own the drop: capture source/target rows
// and hand them to a callback; MainWindow then re-lays the table (rebuilding the
// widgets correctly). No Q_OBJECT needed — a std::function avoids moc on a
// .cpp-local class.
class ReorderTable : public QTableWidget {
public:
    using QTableWidget::QTableWidget;
    std::function<void(int from, int to)> onReorder;

protected:
    void dropEvent(QDropEvent *event) override
    {
        const int from = currentRow();
        const QModelIndex idx = indexAt(event->position().toPoint());
        const int to = idx.isValid() ? idx.row() : rowCount() - 1;
        // Never let the base class run its (widget-losing) move.
        event->setDropAction(Qt::IgnoreAction);
        event->accept();
        // We swallowed the event instead of chaining to the base, so reset the
        // view's drag bookkeeping ourselves — otherwise the drop indicator /
        // autoscroll timer can be left running ("stuck in drag" feel).
        setState(NoState);
        stopAutoScroll();
        viewport()->update();
        if (from >= 0 && to >= 0 && from != to && onReorder)
            onReorder(from, to);
    }
};

// ---- cell builders (children are named so the slots can find + update them) --

QWidget *buildFileCell(const QString &name, const QString &host)
{
    auto *w = new QWidget;
    w->setStyleSheet(QStringLiteral("background:transparent;"));
    auto *h = new QHBoxLayout(w);
    h->setContentsMargins(8, 6, 8, 6);
    h->setSpacing(11);

    auto *icon = new QLabel(w);
    icon->setObjectName(QStringLiteral("f_icon"));
    icon->setFixedSize(34, 34);
    icon->setAlignment(Qt::AlignCenter);

    auto *col = new QVBoxLayout;
    col->setContentsMargins(0, 0, 0, 0);
    col->setSpacing(1);
    auto *nm = new QLabel(name, w);
    nm->setObjectName(QStringLiteral("f_name"));
    auto *hs = new QLabel(host, w);
    hs->setObjectName(QStringLiteral("f_host"));
    col->addWidget(nm);
    col->addWidget(hs);

    h->addWidget(icon);
    h->addLayout(col);
    h->addStretch(1);
    return w;
}

QWidget *buildProgressCell()
{
    // Thin 3px track + a percentage label to its RIGHT (design spec).
    auto *w = new QWidget;
    w->setStyleSheet(QStringLiteral("background:transparent;"));
    auto *h = new QHBoxLayout(w);
    h->setContentsMargins(4, 0, 12, 0);
    h->setSpacing(8);
    auto *bar = new QProgressBar(w);
    bar->setObjectName(QStringLiteral("p_bar"));
    bar->setTextVisible(false);
    bar->setFixedHeight(3);
    bar->setRange(0, 100);
    bar->setValue(0);
    auto *pct = new QLabel(QStringLiteral("0%"), w);
    pct->setObjectName(QStringLiteral("p_pct"));
    pct->setFixedWidth(34);
    pct->setAlignment(Qt::AlignRight | Qt::AlignVCenter);
    h->addWidget(bar, 1);
    h->addWidget(pct);
    return w;
}

QWidget *buildStatusCell()
{
    // A pill badge whose colours come from QSS via the "st" property (set in
    // setRowStatus): #s_badge[st="active"|"paused"|"done"|"queued"|"error"].
    auto *w = new QWidget;
    w->setStyleSheet(QStringLiteral("background:transparent;"));
    auto *h = new QHBoxLayout(w);
    h->setContentsMargins(4, 0, 4, 0);
    auto *l = new QLabel(w);
    l->setObjectName(QStringLiteral("s_badge"));
    l->setAlignment(Qt::AlignCenter);
    h->addWidget(l, 0, Qt::AlignCenter);
    return w;
}

// A small monochrome magnifier for the search field's leading icon (drawn, not an
// emoji glyph, so it renders identically everywhere and matches the muted theme).
QIcon searchIcon()
{
    QPixmap pm(16, 16);
    pm.fill(Qt::transparent);
    QPainter p(&pm);
    p.setRenderHint(QPainter::Antialiasing, true);
    QPen pen(QColor(0x5c, 0x66, 0x75));
    pen.setWidth(2);
    p.setPen(pen);
    p.drawEllipse(QRectF(2.5, 2.5, 8, 8));     // lens
    p.drawLine(QPointF(10.5, 10.5), QPointF(14, 14));   // handle
    p.end();
    return QIcon(pm);
}

// Small monochrome toolbar glyphs (drawn so they render identically everywhere).
QPixmap glyphCanvas() { QPixmap pm(16, 16); pm.fill(Qt::transparent); return pm; }
QIcon pauseGlyph()
{
    QPixmap pm = glyphCanvas(); QPainter p(&pm); p.setRenderHint(QPainter::Antialiasing);
    p.fillRect(QRectF(4, 3, 3, 10), QColor(0x8a, 0x94, 0xa3));
    p.fillRect(QRectF(9, 3, 3, 10), QColor(0x8a, 0x94, 0xa3));
    p.end(); return QIcon(pm);
}
QIcon playGlyph()
{
    QPixmap pm = glyphCanvas(); QPainter p(&pm); p.setRenderHint(QPainter::Antialiasing);
    QPainterPath path; path.moveTo(5, 3); path.lineTo(13, 8); path.lineTo(5, 13); path.closeSubpath();
    p.fillPath(path, QColor(0x8a, 0x94, 0xa3)); p.end(); return QIcon(pm);
}
QIcon funnelGlyph()
{
    QPixmap pm = glyphCanvas(); QPainter p(&pm); p.setRenderHint(QPainter::Antialiasing);
    QPainterPath path; path.moveTo(3, 3); path.lineTo(13, 3); path.lineTo(9.5, 8);
    path.lineTo(9.5, 13); path.lineTo(6.5, 11); path.lineTo(6.5, 8); path.closeSubpath();
    p.fillPath(path, QColor(0x8a, 0x94, 0xa3)); p.end(); return QIcon(pm);
}
QIcon sortGlyph()
{
    QPixmap pm = glyphCanvas(); QPainter p(&pm); p.setRenderHint(QPainter::Antialiasing);
    QPen pen(QColor(0x8a, 0x94, 0xa3)); pen.setWidth(2); p.setPen(pen);
    p.drawLine(3, 4, 11, 4);   // descending bars (a "sort" depiction)
    p.drawLine(3, 8, 9, 8);
    p.drawLine(3, 12, 7, 12);
    p.end(); return QIcon(pm);
}

} // namespace

MainWindow::MainWindow(DownloadEngine *engine, QWidget *parent)
    : QMainWindow(parent), m_engine(engine)
{
    setWindowTitle(QStringLiteral("Nexa Download Manager"));
    setWindowIcon(QIcon(QStringLiteral(":/nexa.png")));
    resize(960, 600);
    // Below this the action-bar buttons + search would clip (no wrapping).
    setMinimumSize(760, 460);

    auto *central = new QWidget(this);
    central->setObjectName(QStringLiteral("Root"));
    auto *root = new QVBoxLayout(central);
    root->setContentsMargins(0, 0, 0, 0);
    root->setSpacing(0);

    // ---- Header bar: logo + brand + breadcrumb (center) + actions (right) --
    auto *header = new QWidget(central);
    header->setObjectName(QStringLiteral("HeaderBar"));
    header->setFixedHeight(48);
    auto *hl = new QHBoxLayout(header);
    hl->setContentsMargins(16, 0, 16, 0);
    hl->setSpacing(10);

    // Brand mark: the Nexa logo (same asset as the window/empty-state icon).
    auto *logo = new QLabel(header);
    logo->setObjectName(QStringLiteral("BrandLogo"));
    logo->setFixedSize(28, 28);
    logo->setAlignment(Qt::AlignCenter);
    logo->setPixmap(QIcon(QStringLiteral(":/nexa.png")).pixmap(28, 28));
    auto *brand = new QLabel(QStringLiteral("NDM"), header);
    brand->setObjectName(QStringLiteral("BrandTitle"));
    auto *crumb = new QLabel(QStringLiteral("Downloads"), header);
    crumb->setObjectName(QStringLiteral("Breadcrumb"));

    auto *settingsBtn = new QPushButton(QString::fromUtf8("⚙"), header);
    settingsBtn->setObjectName(QStringLiteral("IconBtn"));
    settingsBtn->setCursor(Qt::PointingHandCursor);
    settingsBtn->setToolTip(QStringLiteral("Settings, Site logins, Smart Add & more"));
    auto *folderBtn = new QPushButton(QString::fromUtf8("🗀"), header);
    folderBtn->setObjectName(QStringLiteral("IconBtn"));
    folderBtn->setCursor(Qt::PointingHandCursor);
    folderBtn->setToolTip(QStringLiteral("Open the download folder"));
    auto *addBtn = new QPushButton(QStringLiteral("+  New Download"), header);
    addBtn->setObjectName(QStringLiteral("NewDl"));
    addBtn->setCursor(Qt::PointingHandCursor);
    addBtn->setToolTip(QStringLiteral("Add a new download (URL, video, magnet, or playlist)"));

    hl->addWidget(logo);
    hl->addWidget(brand);
    hl->addStretch(1);
    hl->addWidget(crumb);
    hl->addStretch(1);
    hl->addWidget(settingsBtn);
    hl->addWidget(folderBtn);
    hl->addWidget(addBtn);
    root->addWidget(header);

    connect(addBtn,    &QPushButton::clicked, this, &MainWindow::promptAddUrl);
    connect(folderBtn, &QPushButton::clicked, this, &MainWindow::openDownloadFolder);
    connect(settingsBtn, &QPushButton::clicked, this, [this, settingsBtn]() {
        QMenu menu(this);
        menu.addAction(QStringLiteral("Settings…"),       this, &MainWindow::onSettings);
        menu.addAction(QStringLiteral("Smart Add (AI)…"), this, &MainWindow::promptSmartAdd);
        menu.addAction(QStringLiteral("Site logins…"),    this, &MainWindow::onSiteLogins);
        QAction *clip = menu.addAction(QStringLiteral("Monitor clipboard for links"));
        clip->setCheckable(true);
        clip->setChecked(m_clipboard && m_clipboard->isEnabled());
        connect(clip, &QAction::toggled, this, &MainWindow::setClipboardMonitoring);
        menu.addAction(QStringLiteral("Remove selected"), this, &MainWindow::removeSelected);
        menu.addSeparator();
        menu.addAction(QStringLiteral("Open download folder"), this, &MainWindow::openDownloadFolder);
        menu.addAction(QStringLiteral("Update video tools (yt-dlp)…"), this, &MainWindow::onUpdateTools);
        menu.addAction(QStringLiteral("Export logs…"), this, &MainWindow::onExportLogs);
        menu.addAction(QStringLiteral("Check for updates…"), this, &MainWindow::onCheckUpdates);
        menu.exec(settingsBtn->mapToGlobal(QPoint(0, settingsBtn->height() + 4)));
    });

    // ---- Metrics bar: 4 equal columns, 1px dividers between ----------------
    auto *metrics = new QWidget(central);
    metrics->setObjectName(QStringLiteral("MetricsBar"));
    auto *ml = new QHBoxLayout(metrics);
    ml->setContentsMargins(0, 0, 0, 0);
    ml->setSpacing(0);
    int metricIndex = 0;
    auto makeMetric = [&](const QString &label, QLabel **valOut, QLabel **subOut) {
        auto *cell = new QWidget(metrics);
        cell->setObjectName(metricIndex++ == 0 ? QStringLiteral("MetricFirst")
                                               : QStringLiteral("Metric"));
        auto *cv = new QVBoxLayout(cell);
        cv->setContentsMargins(22, 12, 22, 12);
        cv->setSpacing(3);
        auto *lab = new QLabel(label, cell);          lab->setObjectName(QStringLiteral("MetricLabel"));
        auto *val = new QLabel(QStringLiteral("—"), cell); val->setObjectName(QStringLiteral("MetricValue"));
        auto *sub = new QLabel(QString(), cell);      sub->setObjectName(QStringLiteral("MetricSub"));
        cv->addWidget(lab); cv->addWidget(val); cv->addWidget(sub);
        *valOut = val; *subOut = sub;
        ml->addWidget(cell, 1);
    };
    makeMetric(QStringLiteral("ACTIVE"),    &m_metActiveVal, &m_metActiveSub);
    makeMetric(QStringLiteral("SPEED"),     &m_metSpeedVal,  &m_metSpeedSub);
    makeMetric(QStringLiteral("COMPLETED"), &m_metDoneVal,   &m_metDoneSub);
    makeMetric(QStringLiteral("STORAGE"),   &m_metStoreVal,  &m_metStoreSub);
    root->addWidget(metrics);

    // ---- Toolbar: ghost actions (left) + search (right) -------------------
    auto *toolbar = new QWidget(central);
    toolbar->setObjectName(QStringLiteral("Toolbar"));
    toolbar->setFixedHeight(42);
    auto *tl = new QHBoxLayout(toolbar);
    tl->setContentsMargins(16, 0, 16, 0);
    tl->setSpacing(8);
    auto ghost = [&](const QString &t) {
        auto *b = new QPushButton(t, toolbar);
        b->setObjectName(QStringLiteral("Ghost"));
        b->setCursor(Qt::PointingHandCursor);
        tl->addWidget(b);
        return b;
    };
    auto *pauseBtn  = ghost(QStringLiteral("Pause All"));
    auto *resumeBtn = ghost(QStringLiteral("Resume"));
    auto *filterBtn = ghost(QStringLiteral("Filter"));
    auto *sortBtn   = ghost(QStringLiteral("Sort"));
    pauseBtn->setIcon(pauseGlyph());
    resumeBtn->setIcon(playGlyph());
    filterBtn->setIcon(funnelGlyph());
    sortBtn->setIcon(sortGlyph());
    tl->addStretch(1);
    m_search = new QLineEdit(toolbar);
    m_search->setObjectName(QStringLiteral("Search"));
    m_search->setPlaceholderText(QStringLiteral("Search..."));
    m_search->setClearButtonEnabled(true);
    m_search->setFixedWidth(240);
    m_search->addAction(searchIcon(), QLineEdit::LeadingPosition);   // magnifier inside left
    tl->addWidget(m_search);
    root->addWidget(toolbar);

    connect(pauseBtn,  &QPushButton::clicked, this, &MainWindow::pauseAll);
    connect(resumeBtn, &QPushButton::clicked, this, &MainWindow::resumeAll);
    connect(filterBtn, &QPushButton::clicked, this, &MainWindow::showFilterMenu);
    connect(sortBtn,   &QPushButton::clicked, this, &MainWindow::showSortMenu);
    connect(m_search,  &QLineEdit::textChanged, this, &MainWindow::applyFilter);

    // ---- Downloads table --------------------------------------------------
    auto *table = new ReorderTable(0, ColCount, central);
    table->onReorder = [this](int from, int to) {
        // Defer past the drop machinery: rebuilding the table mid-dropEvent
        // would delete the rows Qt is still holding.
        QTimer::singleShot(0, this, [this, from, to]() { moveRow(from, to); });
    };
    m_table = table;
    m_table->setHorizontalHeaderLabels(
        {QStringLiteral("FILE"), QStringLiteral("SIZE"), QStringLiteral("PROGRESS"),
         QStringLiteral("SPEED"), QStringLiteral("STATUS"), QString()});
    m_table->horizontalHeader()->setStretchLastSection(false);
    m_table->horizontalHeader()->setSectionResizeMode(ColFile, QHeaderView::Stretch);
    m_table->horizontalHeader()->setSectionResizeMode(ColSize, QHeaderView::Fixed);
    m_table->horizontalHeader()->setSectionResizeMode(ColProgress, QHeaderView::Fixed);
    m_table->horizontalHeader()->setSectionResizeMode(ColSpeed, QHeaderView::Fixed);
    m_table->horizontalHeader()->setSectionResizeMode(ColStatus, QHeaderView::Fixed);
    m_table->horizontalHeader()->setSectionResizeMode(ColActions, QHeaderView::Fixed);
    m_table->setColumnWidth(ColSize, 88);
    m_table->setColumnWidth(ColProgress, 150);
    m_table->setColumnWidth(ColSpeed, 80);
    m_table->setColumnWidth(ColStatus, 92);
    m_table->setColumnWidth(ColActions, 56);
    m_table->horizontalHeader()->setHighlightSections(false);
    m_table->horizontalHeader()->setFixedHeight(34);
    m_table->setSelectionBehavior(QAbstractItemView::SelectRows);
    m_table->setSelectionMode(QAbstractItemView::SingleSelection);
    m_table->setEditTriggers(QAbstractItemView::NoEditTriggers);
    // Drag a row to reorder the queue (handled by ReorderTable::dropEvent).
    m_table->setDragEnabled(true);
    m_table->setAcceptDrops(true);
    m_table->setDragDropMode(QAbstractItemView::InternalMove);
    m_table->setDropIndicatorShown(true);
    m_table->setDragDropOverwriteMode(false);
    m_table->setShowGrid(false);
    m_table->setFocusPolicy(Qt::NoFocus);
    m_table->verticalHeader()->setVisible(false);
    m_table->verticalHeader()->setDefaultSectionSize(50);
    m_table->setContextMenuPolicy(Qt::CustomContextMenu);
    connect(m_table, &QTableWidget::customContextMenuRequested,
            this, &MainWindow::showRowMenu);
    connect(m_table, &QTableWidget::cellDoubleClicked,
            this, [this](int row, int) { openDetails(idAtRow(row)); });
    // Empty-state page: shown when there are no downloads, instead of a bare
    // grid of column headers over a blank void. Centered logo + hint.
    auto *emptyPage = new QWidget(central);
    emptyPage->setObjectName(QStringLiteral("EmptyPage"));
    auto *el = new QVBoxLayout(emptyPage);
    el->setAlignment(Qt::AlignCenter);
    auto *emptyIcon = new QLabel(emptyPage);
    emptyIcon->setPixmap(QIcon(QStringLiteral(":/nexa.png")).pixmap(64, 64));
    emptyIcon->setFixedSize(64, 64);
    emptyIcon->setScaledContents(true);
    emptyIcon->setStyleSheet(QStringLiteral("opacity:0.5;"));
    emptyIcon->setAlignment(Qt::AlignCenter);
    auto *emptyTitle = new QLabel(QStringLiteral("No downloads yet"), emptyPage);
    emptyTitle->setObjectName(QStringLiteral("EmptyTitle"));
    emptyTitle->setAlignment(Qt::AlignCenter);
    auto *emptyHint = new QLabel(
        QStringLiteral("Click “＋ New Download”, paste a link, or just copy one in your "
                       "browser — Nexa catches it automatically."), emptyPage);
    emptyHint->setObjectName(QStringLiteral("EmptyHint"));
    emptyHint->setAlignment(Qt::AlignCenter);
    emptyHint->setWordWrap(true);
    emptyHint->setMaximumWidth(420);
    el->addWidget(emptyIcon, 0, Qt::AlignHCenter);
    el->addSpacing(14);
    el->addWidget(emptyTitle, 0, Qt::AlignHCenter);
    el->addSpacing(6);
    el->addWidget(emptyHint, 0, Qt::AlignHCenter);

    // Swap between the empty page and the table depending on how many downloads
    // exist (updateEmptyState()).
    m_content = new QStackedWidget(central);
    m_content->addWidget(emptyPage);   // index 0
    m_content->addWidget(m_table);     // index 1
    root->addWidget(m_content, 1);

    setCentralWidget(central);

    // ---- Footer: live stats (left) + version (right) ----------------------
    m_footerLeft  = new QLabel(this);
    m_footerLeft->setObjectName(QStringLiteral("FootStat"));
    m_footerRight = new QLabel(QStringLiteral("v%1  ·  NexaDL").arg(QApplication::applicationVersion()), this);
    m_footerRight->setObjectName(QStringLiteral("FootVer"));
    statusBar()->addWidget(m_footerLeft);
    statusBar()->addPermanentWidget(m_footerRight);
    statusBar()->setSizeGripEnabled(false);   // window resizes from its edges anyway

    auto *del = new QShortcut(QKeySequence::Delete, this);
    connect(del, &QShortcut::activated, this, &MainWindow::removeSelected);

    connect(m_engine, &DownloadEngine::taskAdded,        this, &MainWindow::onTaskAdded);
    connect(m_engine, &DownloadEngine::taskProgress,     this, &MainWindow::onTaskProgress);
    connect(m_engine, &DownloadEngine::taskStateChanged, this, &MainWindow::onTaskStateChanged);
    connect(m_engine, &DownloadEngine::taskFinished,     this, &MainWindow::onTaskFinished);
    connect(m_engine, &DownloadEngine::taskRemoved,      this, &MainWindow::onTaskRemoved);
    connect(m_engine, &DownloadEngine::taskRenamed,      this, &MainWindow::onTaskRenamed);
    // IDM-style: a held (externally-added) download asks before it starts. Resolve
    // the real filename FIRST so the prompt's "Save as" opens with it (never the
    // raw URL token). Open as soon as the probe finishes, or after a short timeout
    // if the server is slow/unavailable.
    connect(m_engine, &DownloadEngine::confirmRequested, this, [this](int id) {
        auto opened = std::make_shared<bool>(false);
        auto *ctx = new QObject(this);                 // scopes the one-shot wait
        auto open = [this, id, opened, ctx]() {
            if (*opened) return;
            *opened = true;
            ctx->deleteLater();
            if (m_engine->isHeld(id))
                showConfirmPrompt(id);
        };
        connect(m_engine, &DownloadEngine::nameResolved, ctx,
                [id, open](int rid, const QString &) { if (rid == id) open(); });
        QTimer::singleShot(2500, ctx, [open]() { open(); });
        m_engine->resolveName(id);   // AFTER wiring above (grabbers emit synchronously)
    });

    // Show downloads the engine already knows about (restored from the last
    // session by loadPersisted(), which runs before this window exists).
    // m_restoring suppresses the details-plate auto-open so a restored,
    // mid-download session doesn't pop a wall of windows on launch.
    m_restoring = true;
    for (const auto &s : m_engine->snapshot()) {
        onTaskAdded(s.id);
        if (s.done > 0 || s.total > 0)
            onTaskProgress(s.id, s.done, s.total, s.speed);
        onTaskStateChanged(s.id, s.state, m_stateDetail.value(s.id));
    }
    m_restoring = false;

    // IDM-style clipboard capture: watch for copied download links and offer
    // them via a toast. Remembers the on/off choice across sessions.
    m_clipboard = new ClipboardMonitor(this);
    connect(m_clipboard, &ClipboardMonitor::downloadableUrlDetected,
            this, &MainWindow::onClipboardUrl);
    QSettings settings;
    if (settings.value(QStringLiteral("clipboardMonitor"), false).toBool())
        m_clipboard->setEnabled(true);

    // Update checker (version notification only — never auto-installs). A silent
    // check runs shortly after launch if NEXA_UPDATE_URL is configured; the gear
    // menu's "Check for updates…" forces one with explicit feedback.
    m_updates = new UpdateChecker(this);
    connect(m_updates, &UpdateChecker::updateAvailable, this,
            [this](const QString &ver, const QString &url, const QString &notes) {
        const QString skip = QSettings().value(QStringLiteral("skipUpdateVersion")).toString();
        if (!m_manualUpdateCheck && ver == skip)
            return;   // user chose to skip this version on a prior silent check
        QMessageBox box(this);
        box.setWindowTitle(QStringLiteral("Update available"));
        box.setText(QStringLiteral("Nexa %1 is available (you have %2).")
                        .arg(ver, QApplication::applicationVersion()));
        if (!notes.isEmpty())
            box.setInformativeText(notes);
        QPushButton *get  = box.addButton(QStringLiteral("Download"), QMessageBox::AcceptRole);
        QPushButton *skipB = box.addButton(QStringLiteral("Skip this version"), QMessageBox::DestructiveRole);
        box.addButton(QStringLiteral("Later"), QMessageBox::RejectRole);
        box.exec();
        if (box.clickedButton() == get && !url.isEmpty())
            QDesktopServices::openUrl(QUrl(url));
        else if (box.clickedButton() == skipB)
            QSettings().setValue(QStringLiteral("skipUpdateVersion"), ver);
        m_manualUpdateCheck = false;
    });
    connect(m_updates, &UpdateChecker::upToDate, this, [this]() {
        if (m_manualUpdateCheck)
            QMessageBox::information(this, QStringLiteral("Up to date"),
                QStringLiteral("You're running the latest version of Nexa."));
        m_manualUpdateCheck = false;
    });
    connect(m_updates, &UpdateChecker::checkFailed, this, [this](const QString &why) {
        if (m_manualUpdateCheck)
            QMessageBox::warning(this, QStringLiteral("Update check failed"), why);
        m_manualUpdateCheck = false;
    });
    if (m_updates->isConfigured())
        QTimer::singleShot(3000, this, [this]() {
            m_manualUpdateCheck = false;
            m_updates->check(QApplication::applicationVersion());
        });

    updateStats();
}

void MainWindow::updateStats()
{
    int active = 0, paused = 0, errors = 0, queued = 0, completed = 0;
    double totalSpeed = 0.0;
    qint64 remaining = 0, used = 0;
    for (const auto &s : m_engine->snapshot()) {
        const qint64 left = (s.total > 0) ? qMax<qint64>(0, s.total - s.done) : 0;
        switch (s.state) {
            case DownloadState::Downloading:
            case DownloadState::Probing:
                ++active; totalSpeed += s.speed; remaining += left; break;
            case DownloadState::Paused:
                ++paused; remaining += left; break;
            case DownloadState::Queued:
                ++queued; remaining += left; break;
            case DownloadState::Error:
                ++errors; break;
            case DownloadState::Completed:
                ++completed; used += (s.total > 0 ? s.total : s.done); break;
            default: break;
        }
    }
    const QString spd = totalSpeed > 1.0 ? humanSpeed(totalSpeed) : QStringLiteral("0 B/s");

    auto setGood = [](QLabel *l, bool good) {
        if (l->property("good").toBool() != good) {
            l->setProperty("good", good);
            l->style()->unpolish(l); l->style()->polish(l);
        }
    };

    // ---- Metric tiles ----
    m_metActiveVal->setText(QString::number(active));
    const int threads = active * qMax(1, m_engine->streamConcurrency());
    m_metActiveSub->setText(active > 0 ? QStringLiteral("↑ %1 threads").arg(threads)
                          : queued > 0 ? QStringLiteral("%1 queued").arg(queued)
                                       : QStringLiteral("idle"));
    setGood(m_metActiveSub, active > 0);

    m_metSpeedVal->setText(spd);
    m_metSpeedSub->setText(QStringLiteral("avg per session"));

    m_metDoneVal->setText(QString::number(completed));
    m_metDoneSub->setText(QStringLiteral("+%1 today").arg(m_completedThisSession));
    setGood(m_metDoneSub, m_completedThisSession > 0);

    QString cap;
    const QStorageInfo si(m_engine->downloadDir());
    if (si.isValid() && si.bytesTotal() > 0)
        cap = humanSize(si.bytesTotal());
    m_metStoreVal->setText(humanSize(used));
    m_metStoreSub->setText(cap.isEmpty() ? QStringLiteral("on disk")
                                         : QStringLiteral("of %1").arg(cap));

    // ---- Footer: "Active: N   Queued: N   Done: N" (values brighter) -------
    auto stat = [](const QString &label, int n) {
        return QStringLiteral("<span style='color:#5c6675'>%1:</span> "
                              "<span style='color:#8a94a3'>%2</span>").arg(label).arg(n);
    };
    QStringList parts{ stat(QStringLiteral("Active"), active),
                       stat(QStringLiteral("Queued"), queued),
                       stat(QStringLiteral("Done"),   completed) };
    if (errors) parts << stat(QStringLiteral("Errors"), errors);
    m_footerLeft->setText(parts.join(QStringLiteral("&nbsp;&nbsp;&nbsp;&nbsp;")));

    updateEmptyState();   // table <-> empty page follows the row count
}

void MainWindow::updateEmptyState()
{
    if (m_content && m_table)
        m_content->setCurrentIndex(m_table->rowCount() > 0 ? 1 : 0);
}

void MainWindow::promptAddUrl()
{
    QString preset = QApplication::clipboard()->text().trimmed();
    if (!(preset.startsWith(QStringLiteral("http://")) ||
          preset.startsWith(QStringLiteral("https://")) ||
          preset.startsWith(QStringLiteral("ftp://"))))
        preset.clear();

    // A small themed dialog: URL + a "whole course / playlist" toggle. The
    // playlist flag flows to yt-dlp's --yes-playlist for course/playlist URLs.
    QDialog dlg(this);
    dlg.setWindowTitle(QStringLiteral("New Download"));
    auto *outer = new QVBoxLayout(&dlg);
    outer->setContentsMargins(14, 14, 14, 14);
    auto *plate = new QWidget(&dlg);
    plate->setObjectName(QStringLiteral("Plate"));
    outer->addWidget(plate);
    auto *v = new QVBoxLayout(plate);
    v->setContentsMargins(18, 16, 18, 16);
    v->setSpacing(10);

    auto *lbl = new QLabel(QStringLiteral("Enter URL"), plate);
    lbl->setProperty("ddRole", "label");
    auto *edit = new QLineEdit(preset, plate);
    edit->setMinimumWidth(420);
    edit->setPlaceholderText(QStringLiteral("https://…  (HTTP/FTP, video, magnet, or a course/playlist)"));
    auto *plCheck = new QCheckBox(QStringLiteral("Download whole course / playlist"), plate);
    auto *plHint = new QLabel(QStringLiteral("For Udemy/Coursera course URLs or a YouTube "
                                             "playlist — fetches every lecture/video."), plate);
    plHint->setProperty("ddRole", "label");
    plHint->setWordWrap(true);

    auto *btns = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel, plate);
    if (auto *okBtn = btns->button(QDialogButtonBox::Ok)) {
        okBtn->setObjectName(QStringLiteral("Primary"));
        okBtn->setText(QStringLiteral("Download"));
    }
    v->addWidget(lbl);
    v->addWidget(edit);
    v->addWidget(plCheck);
    v->addWidget(plHint);
    v->addStretch(1);
    v->addWidget(btns);
    connect(btns, &QDialogButtonBox::accepted, &dlg, &QDialog::accept);
    connect(btns, &QDialogButtonBox::rejected, &dlg, &QDialog::reject);
    edit->setFocus();

    if (dlg.exec() != QDialog::Accepted || edit->text().trimmed().isEmpty())
        return;

    // userInitiated=true: the user already confirmed here, so start directly
    // rather than firing the second "confirm before download" prompt.
    const int id = m_engine->addDownload(QUrl::fromUserInput(edit->text().trimmed()),
                                         QString(), {}, QString(), QString(),
                                         plCheck->isChecked(), /*userInitiated=*/true);
    if (id < 0)
        QMessageBox::warning(this, QStringLiteral("Invalid URL"),
                             QStringLiteral("That URL could not be parsed."));
}

// IDM-style "Download File Info" prompt, shown before a HELD download starts.
// Lets the user confirm, change the save location, defer, or cancel.
void MainWindow::showConfirmPrompt(int id)
{
    if (!m_engine->isHeld(id))
        return;

    const QString url   = m_engine->urlOf(id);
    // Prefer the probed real filename (resolved before we opened); fall back to the
    // URL-derived name only if the probe found nothing.
    const QString resolved = m_engine->resolvedNameOf(id);
    const QString name0 = resolved.isEmpty() ? m_engine->nameOf(id) : resolved;
    QString folder0 = QFileInfo(m_engine->savePathOf(id)).absolutePath();
    if (folder0.isEmpty())
        folder0 = QDir::homePath();

    // Top-level when the main window is hidden (browser handoff), like the plate.
    QWidget *par = (isVisible() && !isMinimized()) ? this : nullptr;
    QDialog dlg(par);
    dlg.setWindowTitle(QStringLiteral("New Download"));
    // Minimize + close enabled, maximize disabled. Qt::Window (not Dialog) so the
    // minimize button actually works on GNOME; fixed size (below) is what makes
    // the WM drop the maximize button.
    dlg.setWindowFlags(Qt::Window | Qt::CustomizeWindowHint | Qt::WindowTitleHint
                       | Qt::WindowSystemMenuHint | Qt::WindowMinimizeButtonHint
                       | Qt::WindowCloseButtonHint);

    auto *outer = new QVBoxLayout(&dlg);
    outer->setContentsMargins(14, 14, 14, 14);
    // Size to the content's natural size and make it non-resizable — robust even
    // when the dialog has no parent (browser handoff, main window hidden), where
    // adjustSize() on Wayland would otherwise balloon to the whole screen.
    outer->setSizeConstraint(QLayout::SetFixedSize);
    auto *plate = new QWidget(&dlg);
    plate->setObjectName(QStringLiteral("Plate"));
    outer->addWidget(plate);
    auto *grid = new QGridLayout(plate);
    grid->setContentsMargins(18, 16, 18, 16);
    grid->setHorizontalSpacing(14);
    grid->setVerticalSpacing(10);
    grid->setColumnStretch(1, 1);

    auto mkLabel = [&](const QString &t) {
        auto *l = new QLabel(t, plate);
        l->setProperty("ddRole", "label");
        l->setAlignment(Qt::AlignRight | Qt::AlignVCenter);
        return l;
    };

    auto *urlEdit = new QLineEdit(url, plate);   // read-only; scrolls for long URLs
    urlEdit->setReadOnly(true);
    urlEdit->setMinimumWidth(460);
    urlEdit->setCursorPosition(0);

    auto *nameEdit = new QLineEdit(name0, plate);

    auto *folderEdit = new QLineEdit(folder0, plate);
    auto *browse = new QPushButton(QStringLiteral("…"), plate);
    browse->setFixedWidth(38);
    browse->setCursor(Qt::PointingHandCursor);
    auto *folderRow = new QHBoxLayout;
    folderRow->setSpacing(8);
    folderRow->addWidget(folderEdit, 1);
    folderRow->addWidget(browse, 0);
    connect(browse, &QPushButton::clicked, &dlg, [&]() {
        const QString d = QFileDialog::getExistingDirectory(
            &dlg, QStringLiteral("Save to folder"), folderEdit->text());
        if (!d.isEmpty())
            folderEdit->setText(d);
    });

    grid->addWidget(mkLabel(QStringLiteral("URL")),     0, 0); grid->addWidget(urlEdit,  0, 1);
    grid->addWidget(mkLabel(QStringLiteral("Save as")), 1, 0); grid->addWidget(nameEdit, 1, 1);
    grid->addWidget(mkLabel(QStringLiteral("Folder")),  2, 0); grid->addLayout(folderRow, 2, 1);

    auto *btnRow = new QHBoxLayout;
    auto *later  = new QPushButton(QStringLiteral("Download Later"), plate);
    auto *cancel = new QPushButton(QStringLiteral("Cancel"), plate);
    auto *start  = new QPushButton(QString::fromUtf8("▶  Start Download"), plate);
    start->setObjectName(QStringLiteral("Primary"));
    for (auto *b : {later, cancel, start})
        b->setCursor(Qt::PointingHandCursor);
    btnRow->addWidget(later);
    btnRow->addStretch(1);
    btnRow->addWidget(cancel);
    btnRow->addSpacing(10);
    btnRow->addWidget(start);
    grid->addLayout(btnRow, 3, 0, 1, 2);

    enum { Cancelled = 0, Started = 1, Later = 2 };
    connect(start,  &QPushButton::clicked, &dlg, [&]() { dlg.done(Started); });
    connect(later,  &QPushButton::clicked, &dlg, [&]() { dlg.done(Later); });
    connect(cancel, &QPushButton::clicked, &dlg, [&]() { dlg.done(Cancelled); });

    // The name was probed before we opened (so the field already shows it). Still
    // listen for a late result (slow server that resolved after the open timeout),
    // unless the user has started typing their own name.
    bool nameEdited = false;
    connect(nameEdit, &QLineEdit::textEdited, &dlg, [&]() { nameEdited = true; });
    connect(m_engine, &DownloadEngine::nameResolved, &dlg, [&](int rid, const QString &n) {
        if (rid == id && !nameEdited && !n.isEmpty()) {
            nameEdit->setText(n);
            nameEdit->setCursorPosition(0);
        }
    });

    nameEdit->setFocus();
    nameEdit->selectAll();

    const int res = dlg.exec();   // size is fixed-to-content via SetFixedSize above
    if (!m_engine->isHeld(id))
        return;   // the download was removed out from under us
    if (res == Started || res == Later)
        m_engine->setSaveLocation(id, folderEdit->text(), nameEdit->text());
    if (res == Started)
        m_engine->startHeld(id);
    else if (res == Later)
        m_engine->holdLater(id);
    else
        m_engine->cancelHeld(id);
}

// IDM-style "Download complete" prompt with Open / Open folder / Close and a
// "don't show again" toggle (persisted).
void MainWindow::showCompleteDialog(int id)
{
    QSettings s;
    if (!s.value(QStringLiteral("ui/showCompleteDialog"), true).toBool())
        return;
    const QString path = m_engine->savePathOf(id);
    if (path.isEmpty() || !QFileInfo::exists(path))
        return;   // some grabbers don't resolve a concrete file path — skip quietly

    QWidget *par = (isVisible() && !isMinimized()) ? this : nullptr;
    QDialog dlg(par);
    dlg.setWindowTitle(QStringLiteral("Download complete"));
    // Minimize + close enabled, maximize disabled (Qt::Window so minimize works;
    // fixed size makes the WM drop the maximize button).
    dlg.setWindowFlags(Qt::Window | Qt::CustomizeWindowHint | Qt::WindowTitleHint
                       | Qt::WindowSystemMenuHint | Qt::WindowMinimizeButtonHint
                       | Qt::WindowCloseButtonHint);

    auto *outer = new QVBoxLayout(&dlg);
    outer->setContentsMargins(14, 14, 14, 14);
    // Fixed-to-content size (no fullscreen even when parentless on Wayland).
    outer->setSizeConstraint(QLayout::SetFixedSize);
    auto *plate = new QWidget(&dlg);
    plate->setObjectName(QStringLiteral("Plate"));
    outer->addWidget(plate);
    auto *v = new QVBoxLayout(plate);
    v->setContentsMargins(18, 16, 18, 16);
    v->setSpacing(8);

    auto *title = new QLabel(QString::fromUtf8("✓  Download complete"), plate);
    title->setObjectName(QStringLiteral("Dd_title"));
    auto *nameL = new QLabel(QFileInfo(path).fileName(), plate);
    nameL->setProperty("ddRole", "value");
    nameL->setWordWrap(true);
    auto *savedLbl = new QLabel(QStringLiteral("Saved to"), plate);
    savedLbl->setProperty("ddRole", "label");
    auto *pathL = new QLabel(QFileInfo(path).absolutePath(), plate);
    pathL->setObjectName(QStringLiteral("Dd_host"));
    pathL->setWordWrap(true);
    auto *dontShow = new QCheckBox(QStringLiteral("Don't show this dialog again"), plate);

    auto *btnRow = new QHBoxLayout;
    auto *folderBtn = new QPushButton(QStringLiteral("Open folder"), plate);
    auto *closeBtn  = new QPushButton(QStringLiteral("Close"), plate);
    auto *openBtn   = new QPushButton(QStringLiteral("Open"), plate);
    openBtn->setObjectName(QStringLiteral("Primary"));
    for (auto *b : {folderBtn, closeBtn, openBtn})
        b->setCursor(Qt::PointingHandCursor);
    btnRow->addWidget(folderBtn);
    btnRow->addStretch(1);
    btnRow->addWidget(closeBtn);
    btnRow->addWidget(openBtn);

    v->addWidget(title);
    v->addSpacing(2);
    v->addWidget(nameL);
    v->addWidget(savedLbl);
    v->addWidget(pathL);
    v->addSpacing(4);
    v->addWidget(dontShow);
    v->addSpacing(4);
    v->addLayout(btnRow);

    // QDesktopServices::openUrl with file:// can silently fail on Wayland or
    // when no default handler is registered. Fall back to xdg-open (Linux) or
    // the native shell on other platforms.
    auto openPath = [](const QString &p) {
#ifdef Q_OS_LINUX
        QProcess::startDetached(QStringLiteral("xdg-open"), {p});
#else
        QDesktopServices::openUrl(QUrl::fromLocalFile(p));
#endif
    };
    connect(openBtn, &QPushButton::clicked, &dlg, [&]() {
        openPath(path);
        dlg.accept();
    });
    connect(folderBtn, &QPushButton::clicked, &dlg, [&]() {
        openPath(QFileInfo(path).absolutePath());
        dlg.accept();
    });
    connect(closeBtn, &QPushButton::clicked, &dlg, &QDialog::accept);

    plate->setMinimumWidth(496);   // match the New Download prompt's width
    dlg.exec();                    // size is fixed-to-content via SetFixedSize above
    if (dontShow->isChecked())
        s.setValue(QStringLiteral("ui/showCompleteDialog"), false);
}

void MainWindow::onSiteLogins()
{
    SiteLoginsDialog dlg(m_engine, this);
    dlg.exec();
}

void MainWindow::onCheckUpdates()
{
    m_manualUpdateCheck = true;
    m_updates->check(QApplication::applicationVersion());
}

void MainWindow::onUpdateTools()
{
    // Site extractors rot as YouTube/Udemy/etc. change; let the user self-update
    // the bundled yt-dlp in place (`yt-dlp -U`) without leaving the app. Works for
    // the standalone binary; a pip/distro install just reports it can't self-update.
    auto *proc = new QProcess(this);
    proc->setProcessChannelMode(QProcess::MergedChannels);
    // Shared buffer (not a raw new/delete): freed exactly once when the last
    // capturing lambda is destroyed, so the started-vs-finished race below can't
    // double-free it.
    auto out = std::make_shared<QString>();
    statusBar()->showMessage(QStringLiteral("Updating yt-dlp…"));
    connect(proc, &QProcess::readyReadStandardOutput, this,
            [proc, out]() { *out += QString::fromUtf8(proc->readAllStandardOutput()); });
    connect(proc, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished), this,
            [this, proc, out](int code, QProcess::ExitStatus st) {
        statusBar()->clearMessage();
        const QString log = out->trimmed();
        QMessageBox box(this);
        box.setWindowTitle(QStringLiteral("Update video tools"));
        const bool ok = (st == QProcess::NormalExit && code == 0);
        box.setIcon(ok ? QMessageBox::Information : QMessageBox::Warning);
        box.setText(ok ? QStringLiteral("yt-dlp update finished.")
                       : QStringLiteral("yt-dlp update didn't complete."));
        box.setDetailedText(log.isEmpty() ? QStringLiteral("(no output)") : log);
        box.exec();
        proc->deleteLater();
    });
    proc->start(QStringLiteral("yt-dlp"), {QStringLiteral("-U")});
    if (!proc->waitForStarted(3000)) {
        statusBar()->clearMessage();
        QMessageBox::warning(this, QStringLiteral("Update video tools"),
            QStringLiteral("Couldn't launch yt-dlp — make sure it's installed and on PATH."));
        proc->disconnect(this);   // the finished lambda must not also run/clean up
        proc->deleteLater();
    }
}

void MainWindow::onExportLogs()
{
    const QString src = nexa::logFilePath();
    if (!QFileInfo::exists(src) || QFileInfo(src).size() == 0) {
        QMessageBox::information(this, QStringLiteral("Export logs"),
            QStringLiteral("No logs yet.\n\nEnable “Save error logs to a file” in Settings, "
                           "reproduce the problem, then export here."));
        return;
    }
    const QString dst = QFileDialog::getSaveFileName(
        this, QStringLiteral("Export logs"),
        QDir::homePath() + QStringLiteral("/nexa-log.txt"),
        QStringLiteral("Text files (*.txt);;All files (*)"));
    if (dst.isEmpty())
        return;
    QFile::remove(dst);                       // QFile::copy won't overwrite
    if (QFile::copy(src, dst))
        QMessageBox::information(this, QStringLiteral("Export logs"),
            QStringLiteral("Saved to:\n%1").arg(dst));
    else
        QMessageBox::warning(this, QStringLiteral("Export logs"),
            QStringLiteral("Couldn't write the file."));
}

void MainWindow::onSettings()
{
    // Single instance: if it's already open, just surface it (restore if the
    // user minimised it) instead of spawning a second window.
    if (m_settingsDlg) {
        m_settingsDlg->showNormal();
        m_settingsDlg->raise();
        m_settingsDlg->activateWindow();
        return;
    }

    // Non-modal, parentless window:
    //  * Parentless + non-modal => Qt sets NO WM_TRANSIENT_FOR, so dragging the
    //    Settings window can never move the main window (the earlier drag bug).
    //  * Non-modal so it can actually be minimised and tucked away while you keep
    //    using the main window (a minimised *modal* dialog would just freeze the
    //    app).
    auto *dlg = new SettingsDialog(m_engine, nullptr);
    dlg->setAttribute(Qt::WA_DeleteOnClose);
    // Explicit decorations: title + system menu + minimise + close, but NO
    // maximise/fullscreen button. CustomizeWindowHint stops Qt re-adding the
    // defaults. Combined with the dialog's fixed height, it can't be maximised.
    dlg->setWindowFlags(Qt::Window | Qt::CustomizeWindowHint | Qt::WindowTitleHint |
                        Qt::WindowSystemMenuHint | Qt::WindowMinimizeButtonHint |
                        Qt::WindowCloseButtonHint);
    m_settingsDlg = dlg;

    // Re-sync the clipboard monitor from the (just-saved) setting on OK; clean up
    // on any close (accept/reject/window-close) since it's heap-allocated.
    connect(dlg, &QDialog::accepted, this, [this]() {
        if (m_clipboard)
            m_clipboard->setEnabled(
                QSettings().value(QStringLiteral("clipboardMonitor"), false).toBool());
    });
    connect(dlg, &QDialog::finished, dlg, &QObject::deleteLater);

    // Lock to the natural size (width = content's sizeHint, height already fixed
    // in the dialog). A fixed-size window can't be maximised or made fullscreen,
    // so the WM drops those actions entirely — and the content never clips.
    dlg->ensurePolished();
    dlg->adjustSize();
    dlg->setFixedSize(dlg->size());
    // Center over the main window, but clamp to the screen so a main window near
    // an edge can't push Settings partly off-screen.
    QPoint pos = frameGeometry().center() - dlg->rect().center();
    if (QScreen *scr = screen()) {
        const QRect avail = scr->availableGeometry();
        pos.setX(qBound(avail.left(), pos.x(), avail.right() - dlg->width() + 1));
        pos.setY(qBound(avail.top(), pos.y(), avail.bottom() - dlg->height() + 1));
    }
    dlg->move(pos);
    dlg->show();
    dlg->raise();
    dlg->activateWindow();
}

void MainWindow::setClipboardMonitoring(bool on)
{
    if (m_clipboard)
        m_clipboard->setEnabled(on);
    QSettings().setValue(QStringLiteral("clipboardMonitor"), on);
    if (!on && m_captureToast)
        m_captureToast->close();
}

void MainWindow::onClipboardUrl(const QUrl &url)
{
    // Replace any toast still on screen so a rapid second copy doesn't stack.
    if (m_captureToast)
        m_captureToast->close();

    auto *toast = new CaptureToast(url);
    m_captureToast = toast;
    connect(toast, &CaptureToast::accepted, this, [this](const QUrl &u) {
        m_engine->addDownload(u);
        showAndRaise();        // surface the list so the user sees it land
    });
    toast->show();
}

void MainWindow::promptSmartAdd()
{
    if (!m_engine->aiAvailable()) {
        QMessageBox::information(
            this, QStringLiteral("Smart Add (AI)"),
            QStringLiteral("AI features need an Anthropic API key.\n\n"
                           "Set ANTHROPIC_API_KEY in your environment and restart Nexa, e.g.:\n"
                           "    export ANTHROPIC_API_KEY=sk-ant-...\n    ./nexa"));
        return;
    }
    bool ok = false;
    const QString text = QInputDialog::getText(
        this, QStringLiteral("Smart Add (AI)"),
        QStringLiteral("Describe what to download (URLs, and optionally when):"),
        QLineEdit::Normal, QString(), &ok);
    if (ok && !text.trimmed().isEmpty())
        m_engine->runAiCommand(text.trimmed());
}

int MainWindow::rowForId(int id) const
{
    return m_idToRow.value(id, -1);
}

int MainWindow::idAtRow(int row) const
{
    QTableWidgetItem *it = m_table->item(row, ColFile);
    return it ? it->data(Qt::UserRole).toInt() : -1;
}

int MainWindow::selectedId() const
{
    const auto rows = m_table->selectionModel()->selectedRows();
    if (rows.isEmpty())
        return -1;
    return idAtRow(rows.first().row());
}

QList<int> MainWindow::currentOrder() const
{
    QList<int> ids;
    ids.reserve(m_table->rowCount());
    for (int r = 0; r < m_table->rowCount(); ++r) {
        const int id = idAtRow(r);
        if (id >= 0)
            ids.append(id);
    }
    return ids;
}

void MainWindow::rebuildInOrder(const QList<int> &order)
{
    // Snapshot current state per id, then re-lay every row in the new order,
    // replaying state so progress bars / speeds / status survive the rebuild.
    QHash<int, DownloadEngine::TaskSnapshot> snaps;
    for (const auto &s : m_engine->snapshot())
        snaps.insert(s.id, s);

    m_table->setRowCount(0);
    m_idToRow.clear();
    m_restoring = true;          // suppress per-row details auto-open side effects
    for (int id : order) {
        if (!snaps.contains(id))
            continue;
        const DownloadEngine::TaskSnapshot s = snaps.value(id);
        onTaskAdded(id);
        if (s.done > 0 || s.total > 0)
            onTaskProgress(id, s.done, s.total, s.speed);
        onTaskStateChanged(id, s.state, m_stateDetail.value(id));
    }
    m_restoring = false;
    applyFilter(m_search->text());
    updateStats();
}

void MainWindow::moveRow(int from, int to)
{
    // While a search filter is active, rows are hidden (not removed), so the
    // visual from/to no longer line up with the full queue order — a reorder
    // would move the wrong task. Disallow reordering until the filter is cleared.
    if (m_search && !m_search->text().trimmed().isEmpty())
        return;
    const int rows = m_table->rowCount();
    if (from < 0 || from >= rows)
        return;
    to = qBound(0, to, rows - 1);
    if (from == to)
        return;
    QList<int> order = currentOrder();
    if (from >= order.size())
        return;
    order.move(from, to);
    rebuildInOrder(order);
    m_engine->reorderQueue(order);   // make the actual start order follow the UI
    m_table->selectRow(to);
}

void MainWindow::moveSelected(int delta)
{
    const auto rows = m_table->selectionModel()->selectedRows();
    if (rows.isEmpty())
        return;
    const int from = rows.first().row();
    moveRow(from, from + delta);
}

void MainWindow::pauseAll()
{
    for (const auto &s : m_engine->snapshot())
        if (s.state == DownloadState::Downloading ||
            s.state == DownloadState::Probing ||
            s.state == DownloadState::Queued)
            m_engine->pause(s.id);
}

void MainWindow::resumeAll()
{
    for (const auto &s : m_engine->snapshot())
        if (s.state == DownloadState::Paused)
            m_engine->resume(s.id);
}

void MainWindow::removeSelected()
{
    const int id = selectedId();
    if (id < 0)
        return;
    const auto reply = QMessageBox::question(
        this, QStringLiteral("Remove Download"),
        QStringLiteral("Remove this download from the list?\n"
                       "(The partially downloaded file is kept.)"));
    if (reply == QMessageBox::Yes)
        m_engine->remove(id, false);
}

void MainWindow::openDownloadFolder()
{
    QDesktopServices::openUrl(QUrl::fromLocalFile(m_engine->downloadDir()));
}

void MainWindow::openDetails(int id)
{
    if (id < 0)
        return;
    if (auto dlg = m_openDialogs.value(id)) {   // QPointer: null if already closed
        dlg->showNormal();                      // restore if it was minimised
        dlg->raise();
        dlg->activateWindow();
        return;
    }
    // Independent top-level window (no parent): it shows cleanly even when the
    // main window is hidden (a browser handoff), gets its own taskbar entry, and
    // dragging it never moves the main window.
    auto *dlg = new DownloadDetailsDialog(m_engine, id, nullptr);  // WA_DeleteOnClose
    m_openDialogs.insert(id, dlg);
    // Prune the map entry when the user closes the dialog, so opened-then-closed
    // downloads don't leave a null QPointer behind for the whole session. Guarded
    // so re-opening (which inserts a fresh dialog) isn't clobbered by the old
    // dialog's destroyed() firing.
    connect(dlg, &QObject::destroyed, this, [this, id]() {
        if (m_openDialogs.value(id).isNull())
            m_openDialogs.remove(id);
    });
    // Center over the main window if it's on screen, otherwise over the screen —
    // then clamp the position so the whole window stays within the available
    // screen area and is never cut off at the bottom/edges.
    dlg->ensurePolished();
    dlg->adjustSize();
    if (QScreen *s = QGuiApplication::primaryScreen()) {
        const QRect avail = s->availableGeometry();
        const QRect ref = (isVisible() && !isMinimized()) ? frameGeometry() : avail;
        const int titleBar = 40;   // leave room for the WM title bar above the widget
        int x = ref.center().x() - dlg->width() / 2;
        int y = ref.center().y() - dlg->height() / 2;
        x = qBound(avail.left(), x, qMax(avail.left(), avail.right() - dlg->width() + 1));
        y = qBound(avail.top() + titleBar, y,
                   qMax(avail.top() + titleBar, avail.bottom() - dlg->height() + 1));
        dlg->move(x, y);
    }
    dlg->show();
    dlg->raise();
    dlg->activateWindow();
}

void MainWindow::showAndRaise()
{
    showNormal();        // restore if minimised
    show();
    raise();
    activateWindow();
}

bool MainWindow::setupTray()
{
    if (m_tray || !QSystemTrayIcon::isSystemTrayAvailable())
        return false;

    m_tray = new QSystemTrayIcon(windowIcon(), this);
    m_tray->setToolTip(QStringLiteral("Nexa Download Manager"));

    auto *menu = new QMenu(this);
    menu->addAction(QStringLiteral("Open Nexa"),  this, &MainWindow::showAndRaise);
    menu->addAction(QStringLiteral("Add URL…"),   this, &MainWindow::promptAddUrl);
    menu->addSeparator();
    menu->addAction(QStringLiteral("Quit Nexa"),  qApp, &QApplication::quit);
    m_tray->setContextMenu(menu);

    // Single click / double click on the tray icon surfaces the window.
    connect(m_tray, &QSystemTrayIcon::activated, this,
            [this](QSystemTrayIcon::ActivationReason r) {
                if (r == QSystemTrayIcon::Trigger || r == QSystemTrayIcon::DoubleClick)
                    showAndRaise();
            });
    m_tray->show();
    return true;
}

void MainWindow::closeEvent(QCloseEvent *event)
{
    // With a tray present, closing the window keeps the engine running in the
    // background (downloads continue); "Quit Nexa" from the tray truly exits.
    // Without a tray, closing behaves normally (quits the app).
    if (m_tray && !QApplication::closingDown()) {
        hide();
        event->ignore();
        return;
    }
    QMainWindow::closeEvent(event);
}

void MainWindow::applyFilter(const QString &text)
{
    const QString q = text.trimmed().toLower();
    for (int row = 0; row < m_table->rowCount(); ++row) {
        const int id = idAtRow(row);
        const bool textMatch = q.isEmpty() ||
            m_engine->nameOf(id).toLower().contains(q) ||
            m_engine->hostOf(id).toLower().contains(q) ||
            m_engine->urlOf(id).toLower().contains(q);
        bool stateMatch = (m_stateFilter < 0);
        if (!stateMatch) {
            const DownloadState s = m_engine->stateOf(id);
            if (m_stateFilter == int(DownloadState::Downloading))   // "Active" = downloading OR probing
                stateMatch = (s == DownloadState::Downloading || s == DownloadState::Probing);
            else
                stateMatch = (int(s) == m_stateFilter);
        }
        m_table->setRowHidden(row, !(textMatch && stateMatch));
    }
}

void MainWindow::showFilterMenu()
{
    QMenu menu(this);
    const QList<QPair<QString, int>> opts = {
        {QStringLiteral("All"),       -1},
        {QStringLiteral("Active"),    int(DownloadState::Downloading)},
        {QStringLiteral("Paused"),    int(DownloadState::Paused)},
        {QStringLiteral("Queued"),    int(DownloadState::Queued)},
        {QStringLiteral("Completed"), int(DownloadState::Completed)},
        {QStringLiteral("Errored"),   int(DownloadState::Error)},
    };
    for (const auto &o : opts) {
        QAction *a = menu.addAction(o.first);
        a->setCheckable(true);
        a->setChecked(m_stateFilter == o.second);
        const int st = o.second;
        connect(a, &QAction::triggered, this, [this, st]() {
            m_stateFilter = st;
            applyFilter(m_search->text());
        });
    }
    auto *btn = qobject_cast<QWidget*>(sender());
    menu.exec(btn ? btn->mapToGlobal(QPoint(0, btn->height() + 4)) : QCursor::pos());
}

void MainWindow::showSortMenu()
{
    QMenu menu(this);
    auto sortBy = [this](std::function<bool(int, int)> less) {
        QList<int> order = currentOrder();
        std::stable_sort(order.begin(), order.end(),
                         [&](int a, int b) { return less(a, b); });
        rebuildInOrder(order);          // view-only: doesn't touch the engine queue
        applyFilter(m_search->text());
    };
    menu.addAction(QStringLiteral("Name (A–Z)"), this, [this, sortBy]() {
        sortBy([this](int a, int b) {
            return m_engine->nameOf(a).compare(m_engine->nameOf(b), Qt::CaseInsensitive) < 0; });
    });
    menu.addAction(QStringLiteral("Status"), this, [this, sortBy]() {
        sortBy([this](int a, int b) { return int(m_engine->stateOf(a)) < int(m_engine->stateOf(b)); });
    });
    menu.addAction(QStringLiteral("Host"), this, [this, sortBy]() {
        sortBy([this](int a, int b) {
            return m_engine->hostOf(a).compare(m_engine->hostOf(b), Qt::CaseInsensitive) < 0; });
    });
    auto *btn = qobject_cast<QWidget*>(sender());
    menu.exec(btn ? btn->mapToGlobal(QPoint(0, btn->height() + 4)) : QCursor::pos());
}

void MainWindow::showRowMenu(const QPoint &pos)
{
    const QModelIndex idx = m_table->indexAt(pos);
    if (!idx.isValid())
        return;
    m_table->selectRow(idx.row());
    const int id = idAtRow(idx.row());
    if (id < 0)
        return;

    const int row = idx.row();
    QMenu menu(this);
    menu.addAction(QStringLiteral("Details…"), this, [this, id]() { openDetails(id); });
    menu.addSeparator();
    menu.addAction(QStringLiteral("Pause"),  this, [this, id]() { m_engine->pause(id); });
    menu.addAction(QStringLiteral("Resume"), this, [this, id]() { m_engine->resume(id); });
    menu.addSeparator();
    // Reorder the queue (also possible by dragging the row).
    QAction *top = menu.addAction(QStringLiteral("Move to top"),
                                  this, [this, row]() { moveRow(row, 0); });
    QAction *up  = menu.addAction(QStringLiteral("Move up"),
                                  this, [this]() { moveSelected(-1); });
    QAction *dn  = menu.addAction(QStringLiteral("Move down"),
                                  this, [this]() { moveSelected(+1); });
    top->setEnabled(row > 0);
    up->setEnabled(row > 0);
    dn->setEnabled(row < m_table->rowCount() - 1);
    menu.addSeparator();
    menu.addAction(QStringLiteral("Remove"), this, &MainWindow::removeSelected);
    menu.exec(m_table->viewport()->mapToGlobal(pos));
}

void MainWindow::refreshFileCell(int row, int id)
{
    QWidget *cell = m_table->cellWidget(row, ColFile);
    if (!cell)
        return;
    const QString name = m_engine->nameOf(id);
    if (auto *icon = cell->findChild<QLabel*>(QStringLiteral("f_icon")))
        paintIcon(icon, name);
    if (auto *nm = cell->findChild<QLabel*>(QStringLiteral("f_name")))
        nm->setText(name);
    if (auto *hs = cell->findChild<QLabel*>(QStringLiteral("f_host")))
        hs->setText(m_engine->hostOf(id));
}

void MainWindow::setRowStatus(int row, DownloadState state, const QString &detail)
{
    const QString k =
        (state == DownloadState::Downloading || state == DownloadState::Probing) ? QStringLiteral("active")
        : state == DownloadState::Paused    ? QStringLiteral("paused")
        : state == DownloadState::Completed ? QStringLiteral("done")
        : state == DownloadState::Error     ? QStringLiteral("error")
                                            : QStringLiteral("queued");
    const QString text = k == QLatin1String("active") ? QStringLiteral("ACTIVE")
                       : k == QLatin1String("paused") ? QStringLiteral("PAUSED")
                       : k == QLatin1String("done")   ? QStringLiteral("DONE")
                       : k == QLatin1String("error")  ? QStringLiteral("ERROR")
                                                      : QStringLiteral("QUEUED");
    // Status badge — colours come from QSS via the "st" property.
    if (auto *cell = m_table->cellWidget(row, ColStatus)) {
        if (auto *b = cell->findChild<QLabel*>(QStringLiteral("s_badge"))) {
            b->setText(text);
            b->setToolTip(detail);
            if (b->property("st").toString() != k) {
                b->setProperty("st", k);
                b->style()->unpolish(b);
                b->style()->polish(b);
            }
        }
    }
    // Progress chunk colour follows the state (blue active / amber paused / green done).
    if (auto *pc = m_table->cellWidget(row, ColProgress))
        if (auto *bar = pc->findChild<QProgressBar*>(QStringLiteral("p_bar")))
            paintBar(bar, statusColor(state));
    // First action button is contextual: pause (running) / resume (paused/error) /
    // open-folder (done). A queued item has nothing to toggle — show only Remove.
    if (auto *ac = m_table->cellWidget(row, ColActions)) {
        if (auto *tg = ac->findChild<QPushButton*>(QStringLiteral("a_toggle"))) {
            if (state == DownloadState::Completed) {
                tg->setText(QString::fromUtf8("🗀")); tg->setToolTip(QStringLiteral("Open folder")); tg->setVisible(true);
            } else if (state == DownloadState::Downloading || state == DownloadState::Probing) {
                tg->setText(QString::fromUtf8("❚❚")); tg->setToolTip(QStringLiteral("Pause"));       tg->setVisible(true);
            } else if (state == DownloadState::Queued) {
                tg->setVisible(false);
            } else {   // Paused / Error
                tg->setText(QString::fromUtf8("▶")); tg->setToolTip(QStringLiteral("Resume"));        tg->setVisible(true);
            }
        }
    }
}

QWidget *MainWindow::buildActionsCell(int id)
{
    auto *w = new QWidget;
    w->setStyleSheet(QStringLiteral("background:transparent;"));
    auto *h = new QHBoxLayout(w);
    h->setContentsMargins(0, 0, 8, 0);
    h->setSpacing(4);
    auto *toggle = new QPushButton(QString::fromUtf8("▶"), w);
    toggle->setObjectName(QStringLiteral("a_toggle"));
    toggle->setProperty("ActIcon", true);
    toggle->setFixedSize(24, 24);
    toggle->setCursor(Qt::PointingHandCursor);
    auto *second = new QPushButton(QString::fromUtf8("✕"), w);
    second->setObjectName(QStringLiteral("a_second"));
    second->setProperty("ActIcon", true);
    second->setFixedSize(24, 24);
    second->setCursor(Qt::PointingHandCursor);
    second->setToolTip(QStringLiteral("Remove"));
    h->addStretch(1);
    h->addWidget(toggle);
    h->addWidget(second);
    // First button is state-aware: pause/resume while in flight, open-folder when done.
    connect(toggle, &QPushButton::clicked, this, [this, id]() {
        const DownloadState s = m_engine->stateOf(id);
        if (s == DownloadState::Completed)                                  openDownloadFolder();
        else if (s == DownloadState::Downloading || s == DownloadState::Probing) m_engine->pause(id);
        else                                                                m_engine->resume(id);
    });
    // Second button removes the task (cancelling it first if still running).
    connect(second, &QPushButton::clicked, this, [this, id]() {
        const int r = rowForId(id);
        if (r >= 0) m_table->selectRow(r);
        removeSelected();
    });
    return w;
}

void MainWindow::showRowMenuFor(int id, const QPoint &globalPos)
{
    const int row = rowForId(id);
    if (row >= 0)
        m_table->selectRow(row);
    QMenu menu(this);
    menu.addAction(QStringLiteral("Details…"), this, [this, id]() { openDetails(id); });
    menu.addSeparator();
    menu.addAction(QStringLiteral("Pause"),  this, [this, id]() { m_engine->pause(id); });
    menu.addAction(QStringLiteral("Resume"), this, [this, id]() { m_engine->resume(id); });
    menu.addSeparator();
    menu.addAction(QStringLiteral("Open download folder"), this, &MainWindow::openDownloadFolder);
    menu.addAction(QStringLiteral("Remove"), this, &MainWindow::removeSelected);
    menu.exec(globalPos);
}

void MainWindow::onTaskAdded(int id)
{
    if (rowForId(id) >= 0)
        return;
    const int row = m_table->rowCount();
    m_table->insertRow(row);
    m_idToRow.insert(id, row);

    // Hidden item carries the task id (and backs row selection) under the cell widget.
    auto *idItem = new QTableWidgetItem;
    idItem->setData(Qt::UserRole, id);
    m_table->setItem(row, ColFile, idItem);
    m_table->setCellWidget(row, ColFile, buildFileCell(m_engine->nameOf(id),
                                                       m_engine->hostOf(id)));
    refreshFileCell(row, id);

    auto *sizeItem = new QTableWidgetItem(QStringLiteral("—"));
    sizeItem->setForeground(QColor(0x8b94a7));
    m_table->setItem(row, ColSize, sizeItem);

    m_table->setCellWidget(row, ColProgress, buildProgressCell());

    auto *speedItem = new QTableWidgetItem(QStringLiteral("—"));
    speedItem->setForeground(QColor(0x8b94a7));
    m_table->setItem(row, ColSpeed, speedItem);

    m_table->setCellWidget(row, ColStatus, buildStatusCell());
    m_table->setCellWidget(row, ColActions, buildActionsCell(id));
    const DownloadState st = m_engine->stateOf(id);
    setRowStatus(row, st, QString());

    applyFilter(m_search->text());
    updateStats();

    // When a download starts while the main window isn't on screen (e.g. a
    // browser link handoff), pop its details plate instead of surfacing the main
    // list window — exactly the requested "click a link → plate opens, main
    // window stays closed" flow. Skipped during the startup restore replay and
    // for multi-video playlist jobs. When the user is already in the main window
    // (visible), downloads just appear in the list as before.
    if (!m_restoring && !m_engine->isPlaylist(id) && (!isVisible() || isMinimized()))
        openDetails(id);
}

void MainWindow::onTaskProgress(int id, qint64 done, qint64 total, double bps)
{
    const int row = rowForId(id);
    if (row < 0)
        return;

    // A playlist reports progress as VIDEO COUNTS (done/total = videos), so show
    // "N videos" instead of treating the count as a byte size.
    const bool playlist = m_engine->isPlaylist(id);
    if (auto *sizeItem = m_table->item(row, ColSize)) {
        if (playlist)
            sizeItem->setText(total > 0 ? QStringLiteral("%1 videos").arg(total)
                                        : QStringLiteral("playlist"));
        else
            sizeItem->setText(total > 0 ? humanSize(total) : humanSize(done));
    }

    if (auto *pc = m_table->cellWidget(row, ColProgress)) {
        auto *bar = pc->findChild<QProgressBar*>(QStringLiteral("p_bar"));
        auto *pct = pc->findChild<QLabel*>(QStringLiteral("p_pct"));
        if (bar && pct) {
            if (total > 0) {
                const int p = qBound(0, int((done * 100) / total), 100);  // never show >100% on overshoot
                bar->setRange(0, 100);
                bar->setValue(p);
                pct->setText(QStringLiteral("%1%").arg(p));
            } else {
                bar->setRange(0, 0);               // busy indicator for unknown size
                pct->setText(humanSize(done));
            }
        }
    }
    if (auto *speedItem = m_table->item(row, ColSpeed)) {
        const QString s = humanSpeed(bps);
        speedItem->setText(s.isEmpty() ? QStringLiteral("—") : s);
        speedItem->setForeground(s.isEmpty() ? QColor(0x8b94a7) : QColor(0xc7cedb));
    }

    updateStats();
}

void MainWindow::onTaskStateChanged(int id, DownloadState state, const QString &detail)
{
    if (!detail.isEmpty())
        m_stateDetail.insert(id, detail);   // cache for sort/rebuild replay
    const int row = rowForId(id);
    if (row < 0)
        return;
    setRowStatus(row, state, detail);

    // A completed task always reads 100% (covers tasks restored as Complete,
    // whose final byte counts aren't replayed through onTaskProgress).
    if (state == DownloadState::Completed)
        onTaskFinished(id);

    // A non-downloading row shows no live speed.
    if (state != DownloadState::Downloading && state != DownloadState::Probing) {
        if (auto *speedItem = m_table->item(row, ColSpeed)) {
            speedItem->setText(QStringLiteral("—"));
            speedItem->setForeground(QColor(0x8b94a7));
        }
    }

    // NOTE: we deliberately do NOT auto-open the per-download details plate when
    // a download starts. Doing so made a window pop over the browser on every
    // single handoff — an unwanted focus-steal. Downloads now appear silently in
    // the list; the user opens a plate on demand (double-click / right-click →
    // Details). m_autoOpened is retained only for backward-compat of the field.
    Q_UNUSED(m_autoOpened);

    updateStats();
}

void MainWindow::onTaskFinished(int id)
{
    const int row = rowForId(id);
    if (row < 0)
        return;
    // onTaskFinished fires from BOTH the taskFinished signal and onTaskStateChanged
    // (Completed), so guard the once-only work (count + the completion dialog) to
    // the FIRST finish for this id — otherwise two completion dialogs pop up.
    const bool firstFinish = !m_restoring && !m_countedDone.contains(id);
    if (firstFinish) {
        m_countedDone.insert(id);
        ++m_completedThisSession;
    }
    if (auto *pc = m_table->cellWidget(row, ColProgress)) {
        if (auto *bar = pc->findChild<QProgressBar*>(QStringLiteral("p_bar"))) {
            bar->setRange(0, 100);
            bar->setValue(100);
        }
        if (auto *pct = pc->findChild<QLabel*>(QStringLiteral("p_pct")))
            pct->setText(QStringLiteral("100%"));
    }
    if (auto *speedItem = m_table->item(row, ColSpeed)) {
        speedItem->setText(QStringLiteral("—"));
        speedItem->setForeground(QColor(0x8b94a7));
    }
    updateStats();
    // On completion, auto-close the per-download details plate and show the
    // IDM-style completion prompt (Open / Open folder / Close) instead. Only on
    // the FIRST finish (see firstFinish), so it never double-pops. Skipped for the
    // startup restore replay and for multi-video playlist jobs.
    if (firstFinish && !m_engine->isPlaylist(id))
        QTimer::singleShot(0, this, [this, id]() {
            if (auto dlg = m_openDialogs.value(id))
                dlg->close();          // WA_DeleteOnClose -> plate goes away
            showCompleteDialog(id);
        });
}

void MainWindow::onTaskRenamed(int id, const QString &newName)
{
    const int row = rowForId(id);
    if (row < 0)
        return;
    refreshFileCell(row, id);
    m_footerLeft->setToolTip(QStringLiteral("Renamed to %1").arg(newName));
}

void MainWindow::onTaskRemoved(int id)
{
    m_autoOpened.remove(id);
    m_openDialogs.remove(id);   // the dialog closes itself on taskRemoved; prune the hash
    m_stateDetail.remove(id);
    const int row = rowForId(id);
    if (row < 0)
        return;
    m_table->removeRow(row);
    m_idToRow.remove(id);
    // Row indices below the removed one shift up by one.
    for (auto it = m_idToRow.begin(); it != m_idToRow.end(); ++it) {
        if (it.value() > row)
            it.value() -= 1;
    }
    updateStats();
}

} // namespace nexa
