#include "ui/MainWindow.h"
#include "ui/UiHelpers.h"
#include "ui/DownloadDetailsDialog.h"
#include "ui/SiteLoginsDialog.h"
#include "ui/SettingsDialog.h"
#include "ui/ClipboardMonitor.h"
#include "core/DownloadEngine.h"
#include "core/UpdateChecker.h"
#include "core/DownloadTask.h"

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
#include <QWidget>
#include <QFileInfo>
#include <QIcon>
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

enum Column { ColFile = 0, ColSize, ColProgress, ColSpeed, ColStatus, ColCount };

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
    auto *w = new QWidget;
    w->setStyleSheet(QStringLiteral("background:transparent;"));
    auto *v = new QVBoxLayout(w);
    v->setContentsMargins(4, 10, 16, 10);
    v->setSpacing(4);
    auto *bar = new QProgressBar(w);
    bar->setObjectName(QStringLiteral("p_bar"));
    bar->setTextVisible(false);
    bar->setFixedHeight(6);
    bar->setRange(0, 100);
    bar->setValue(0);
    auto *pct = new QLabel(QStringLiteral("0%"), w);
    pct->setObjectName(QStringLiteral("p_pct"));
    v->addWidget(bar);
    v->addWidget(pct);
    return w;
}

QWidget *buildStatusCell()
{
    auto *w = new QWidget;
    w->setStyleSheet(QStringLiteral("background:transparent;"));
    auto *h = new QHBoxLayout(w);
    h->setContentsMargins(12, 0, 8, 0);
    auto *l = new QLabel(w);
    l->setObjectName(QStringLiteral("s_lbl"));
    l->setTextFormat(Qt::RichText);
    h->addWidget(l);
    h->addStretch(1);
    return w;
}

} // namespace

MainWindow::MainWindow(DownloadEngine *engine, QWidget *parent)
    : QMainWindow(parent), m_engine(engine)
{
    setWindowTitle(QStringLiteral("NexaDL — Download Manager"));
    setWindowIcon(QIcon(QStringLiteral(":/nexa.png")));
    resize(960, 600);

    auto *central = new QWidget(this);
    central->setObjectName(QStringLiteral("Root"));
    auto *root = new QVBoxLayout(central);
    root->setContentsMargins(0, 0, 0, 0);
    root->setSpacing(0);

    // ---- Header: traffic-light accent + title (left), "N active" pill (right) --
    auto *header = new QWidget(central);
    header->setObjectName(QStringLiteral("HeaderBar"));
    auto *hl = new QHBoxLayout(header);
    hl->setContentsMargins(20, 16, 20, 14);
    hl->setSpacing(8);

    auto dot = [&](const char *color) {
        auto *d = new QLabel(header);
        d->setFixedSize(12, 12);
        d->setStyleSheet(QStringLiteral("background:%1;border-radius:6px;").arg(color));
        return d;
    };
    hl->addWidget(dot("#ff5f57"));
    hl->addWidget(dot("#febc2e"));
    hl->addWidget(dot("#28c840"));
    hl->addSpacing(14);

    auto *title = new QLabel(QStringLiteral("NexaDL — Download Manager"), header);
    title->setObjectName(QStringLiteral("BrandTitle"));
    m_activePill = new QLabel(QStringLiteral("0 active"), header);
    m_activePill->setObjectName(QStringLiteral("ActivePill"));

    hl->addWidget(title);
    hl->addStretch(1);
    hl->addWidget(m_activePill);
    root->addWidget(header);

    // ---- Action bar -------------------------------------------------------
    auto *actions = new QWidget(central);
    actions->setObjectName(QStringLiteral("ActionBar"));
    auto *al = new QHBoxLayout(actions);
    al->setContentsMargins(20, 6, 20, 14);
    al->setSpacing(9);

    auto makeBtn = [&](const QString &text, const char *obj) {
        auto *b = new QPushButton(text, actions);
        b->setObjectName(QString::fromLatin1(obj));
        b->setCursor(Qt::PointingHandCursor);
        al->addWidget(b);
        return b;
    };
    // Use plain geometric/text glyphs (not colour-emoji code points) so the
    // icons render monochrome and match the flat UI.
    auto *addBtn    = makeBtn(QString::fromUtf8("＋  New Download"), "Primary");
    auto *pauseBtn  = makeBtn(QString::fromUtf8("❚❚  Pause All"), "");
    auto *resumeBtn = makeBtn(QString::fromUtf8("▷  Resume"), "");
    auto *gearBtn   = makeBtn(QString::fromUtf8("⚙"), "IconBtn");
    auto *folderBtn = makeBtn(QString::fromUtf8("🗀"), "IconBtn");
    al->addStretch(1);

    m_search = new QLineEdit(actions);
    m_search->setObjectName(QStringLiteral("Search"));
    m_search->setPlaceholderText(QStringLiteral("Search downloads…"));
    m_search->setClearButtonEnabled(true);
    m_search->setFixedWidth(220);
    al->addWidget(m_search);
    root->addWidget(actions);

    connect(addBtn,    &QPushButton::clicked, this, &MainWindow::promptAddUrl);
    connect(pauseBtn,  &QPushButton::clicked, this, &MainWindow::pauseAll);
    connect(resumeBtn, &QPushButton::clicked, this, &MainWindow::resumeAll);
    connect(folderBtn, &QPushButton::clicked, this, &MainWindow::openDownloadFolder);
    connect(m_search,  &QLineEdit::textChanged, this, &MainWindow::applyFilter);

    // Gear: the less-common actions, so the bar stays clean.
    connect(gearBtn, &QPushButton::clicked, this, [this, gearBtn]() {
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
        menu.addAction(QStringLiteral("Check for updates…"), this, &MainWindow::onCheckUpdates);
        menu.exec(gearBtn->mapToGlobal(QPoint(0, gearBtn->height() + 4)));
    });

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
         QStringLiteral("SPEED"), QStringLiteral("STATUS")});
    m_table->horizontalHeader()->setStretchLastSection(false);
    m_table->horizontalHeader()->setSectionResizeMode(ColFile, QHeaderView::Stretch);
    m_table->horizontalHeader()->setSectionResizeMode(ColSize, QHeaderView::Fixed);
    m_table->horizontalHeader()->setSectionResizeMode(ColProgress, QHeaderView::Stretch);
    m_table->horizontalHeader()->setSectionResizeMode(ColSpeed, QHeaderView::Fixed);
    m_table->horizontalHeader()->setSectionResizeMode(ColStatus, QHeaderView::Fixed);
    m_table->setColumnWidth(ColSize, 92);
    m_table->setColumnWidth(ColSpeed, 96);
    m_table->setColumnWidth(ColStatus, 150);
    m_table->horizontalHeader()->setHighlightSections(false);
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
    m_table->verticalHeader()->setDefaultSectionSize(58);
    m_table->setContextMenuPolicy(Qt::CustomContextMenu);
    connect(m_table, &QTableWidget::customContextMenuRequested,
            this, &MainWindow::showRowMenu);
    connect(m_table, &QTableWidget::cellDoubleClicked,
            this, [this](int row, int) { openDetails(idAtRow(row)); });
    root->addWidget(m_table, 1);

    setCentralWidget(central);

    // ---- Footer summary: counts + speed (left), remaining (right) ---------
    m_footerLeft  = new QLabel(this);
    m_footerRight = new QLabel(this);
    m_footerRight->setStyleSheet(QStringLiteral("color:#6b7488;"));
    statusBar()->addWidget(m_footerLeft);
    statusBar()->addPermanentWidget(m_footerRight);
    statusBar()->setSizeGripEnabled(true);

    auto *del = new QShortcut(QKeySequence::Delete, this);
    connect(del, &QShortcut::activated, this, &MainWindow::removeSelected);

    connect(m_engine, &DownloadEngine::taskAdded,        this, &MainWindow::onTaskAdded);
    connect(m_engine, &DownloadEngine::taskProgress,     this, &MainWindow::onTaskProgress);
    connect(m_engine, &DownloadEngine::taskStateChanged, this, &MainWindow::onTaskStateChanged);
    connect(m_engine, &DownloadEngine::taskFinished,     this, &MainWindow::onTaskFinished);
    connect(m_engine, &DownloadEngine::taskRemoved,      this, &MainWindow::onTaskRemoved);
    connect(m_engine, &DownloadEngine::taskRenamed,      this, &MainWindow::onTaskRenamed);

    // Show downloads the engine already knows about (restored from the last
    // session by loadPersisted(), which runs before this window exists).
    // m_restoring suppresses the details-plate auto-open so a restored,
    // mid-download session doesn't pop a wall of windows on launch.
    m_restoring = true;
    for (const auto &s : m_engine->snapshot()) {
        onTaskAdded(s.id);
        if (s.done > 0 || s.total > 0)
            onTaskProgress(s.id, s.done, s.total, s.speed);
        onTaskStateChanged(s.id, s.state, QString());
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
    int active = 0, paused = 0, errors = 0;
    double totalSpeed = 0.0;
    qint64 remaining = 0;
    for (const auto &s : m_engine->snapshot()) {
        const qint64 left = (s.total > 0) ? qMax<qint64>(0, s.total - s.done) : 0;
        switch (s.state) {
            case DownloadState::Downloading:
            case DownloadState::Probing:
                ++active; totalSpeed += s.speed; remaining += left; break;
            case DownloadState::Paused:
                ++paused; remaining += left; break;
            case DownloadState::Queued:
                remaining += left; break;
            case DownloadState::Error:
                ++errors; break;
            default: break;
        }
    }

    m_activePill->setText(QStringLiteral("%1 active").arg(active));

    const QString spd = totalSpeed > 1.0 ? humanSpeed(totalSpeed)
                                         : QStringLiteral("0 B/s");
    QString tail;
    if (paused || errors) {
        QStringList bits;
        if (paused) bits << QStringLiteral("%1 paused").arg(paused);
        if (errors) bits << QStringLiteral("%1 error").arg(errors);
        tail = QStringLiteral("&nbsp;&nbsp;&nbsp;<span style='color:#6b7488'>%1</span>")
                   .arg(bits.join(QStringLiteral(" · ")));
    }
    m_footerLeft->setText(
        QStringLiteral("<span style='color:#34d399'>●</span> "
                       "<span style='color:#a7b0c2'>%1 active · %2 total</span>%3")
            .arg(active).arg(spd).arg(tail));
    m_footerRight->setText(remaining > 0
        ? QStringLiteral("%1 remaining").arg(humanSize(remaining))
        : QString());
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

    const int id = m_engine->addDownload(QUrl::fromUserInput(edit->text().trimmed()),
                                         QString(), {}, QString(), QString(),
                                         plCheck->isChecked());
    if (id < 0)
        QMessageBox::warning(this, QStringLiteral("Invalid URL"),
                             QStringLiteral("That URL could not be parsed."));
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
    // Center over the main window before showing (no parent to do it for us).
    dlg->move(frameGeometry().center() - dlg->rect().center());
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
        onTaskStateChanged(id, s.state, QString());
    }
    m_restoring = false;
    applyFilter(m_search->text());
    updateStats();
}

void MainWindow::moveRow(int from, int to)
{
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
        const bool match = q.isEmpty() ||
            m_engine->nameOf(id).toLower().contains(q) ||
            m_engine->hostOf(id).toLower().contains(q) ||
            m_engine->urlOf(id).toLower().contains(q);
        m_table->setRowHidden(row, !match);
    }
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
    QWidget *cell = m_table->cellWidget(row, ColStatus);
    if (!cell)
        return;
    if (auto *lbl = cell->findChild<QLabel*>(QStringLiteral("s_lbl"))) {
        lbl->setText(QStringLiteral(
            "<span style='color:%1'>●</span>&nbsp;&nbsp;"
            "<span style='color:#cbd5e1'>%2</span>")
            .arg(statusColor(state).name(), statusLabel(state)));
        lbl->setToolTip(detail);
    }
    // Match the progress-bar colour to the state.
    if (auto *pc = m_table->cellWidget(row, ColProgress))
        if (auto *bar = pc->findChild<QProgressBar*>(QStringLiteral("p_bar")))
            paintBar(bar, statusColor(state));
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
                const int p = int((done * 100) / total);
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
