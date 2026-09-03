#include "ui/MainWindow.h"
#include "ui/UiHelpers.h"
#include "ui/Theme.h"
#include "ui/DownloadDetailsDialog.h"
#include "ui/SiteLoginsDialog.h"
#include "ui/SettingsDialog.h"
#include "ui/ThemeGalleryDialog.h"
#include "ui/AdBanner.h"
#include "ui/Motion.h"
#include "ads/AdService.h"
#include "ui/ClipboardMonitor.h"
#include "ui/LinkGrabberDialog.h"
#include "ui/FirstRunWizard.h"
#include "license/LicenseManager.h"
#include "core/DownloadEngine.h"
#include "core/UpdateChecker.h"
#include "core/VirusScanner.h"
#include "core/DownloadImport.h"
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
#include <QMenuBar>
#include <QRegularExpression>
#include <QSignalBlocker>
#include <QAbstractSpinBox>
#include <QDateTimeEdit>
#include <QProgressDialog>
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
#include <QComboBox>
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
#include <QDateTime>
#include <QDropEvent>
#include <QDragEnterEvent>
#include <QDragMoveEvent>
#include <QMimeData>
#include <QInputDialog>
#include <QAbstractItemView>
#include <QAbstractItemModel>
#include <QVariantAnimation>
#include <QEasingCurve>
#include <QCursor>
#include <QEvent>
#include <QMouseEvent>
#include <QPaintEvent>
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
using nexa::mutedTextColor;
using nexa::valueTextColor;
using nexa::statusLabel;
using nexa::fileAccent;
using nexa::paintIcon;
using nexa::Accent;

namespace {

enum Column { ColFile = 0, ColSize, ColProgress, ColSpeed, ColStatus, ColActions, ColCount };

// The rows carry cell widgets (file tile, progress bar, status). Qt's built-in
// InternalMove reorders the underlying items but leaves those widgets behind,
// misaligning the table. So we fully own the drop: capture source/target rows
// and hand them to a callback; MainWindow then re-lays the table (rebuilding the
// widgets correctly). No Q_OBJECT needed — a std::function avoids moc on a
// .cpp-local class.
// A compact aggregate-throughput sparkline for the SPEED tile. The per-download
// details plate has a full graph; this is the at-a-glance version, so the main
// window shows the engine actually working without opening anything.
class SpeedSpark : public QWidget {
public:
    explicit SpeedSpark(QWidget *parent = nullptr) : QWidget(parent)
    {
        setFixedHeight(18);
        setMinimumWidth(80);
        setAttribute(Qt::WA_TransparentForMouseEvents);
        // The app-wide sheet gives every QWidget the window background; keep this
        // one clear so an idle (empty) sparkline is invisible rather than a box.
        setStyleSheet(QStringLiteral("background: transparent;"));
    }

    // Called on every stats refresh (~1 Hz).
    void addSample(double bytesPerSec)
    {
        m_samples.append(qMax(0.0, bytesPerSec));
        while (m_samples.size() > kMaxSamples)
            m_samples.removeFirst();
        update();
    }

protected:
    void paintEvent(QPaintEvent *) override
    {
        // paintSpark draws nothing until there are two samples and a peak, so
        // an idle tile stays invisible rather than showing a misleading flat line.
        // The style (line, area, bars, dots, steps, ribbon) is the theme's.
        QPainter p(this);
        const theme::Palette &pal = theme::current();
        motion::paintSpark(p, QRectF(rect()).adjusted(0, 2, 0, -2), m_samples, kMaxSamples,
                           QColor(pal.accentCool), pal);
    }

private:
    static constexpr int kMaxSamples = 60;   // ~1 minute of history at 1 Hz
    QVector<double> m_samples;
};

class ReorderTable : public QTableWidget {
public:
    ReorderTable(int rows, int cols, QWidget *parent = nullptr)
        : QTableWidget(rows, cols, parent),
          m_fade(new QVariantAnimation(this))
    {
        // Moves over the bare cells reach the viewport directly…
        viewport()->setMouseTracking(true);
        // …except that Qt drops a tracking-only move at the first widget under
        // the cursor (a label in the file tile, say) and never propagates it to
        // the viewport. Application-level filters still see every move, so the
        // band is fed from eventFilter() for anything inside the viewport.
        qApp->installEventFilter(this);

        m_fade->setEasingCurve(QEasingCurve::OutCubic);
        connect(m_fade, &QVariantAnimation::valueChanged, this, [this](const QVariant &v) {
            m_mix = v.toDouble();
            repaintBand();
        });
        // Rows shifting under a still cursor (insert, remove, rebuild) must
        // re-aim the band; defer past the view's own relayout of the same signal.
        auto resync = [this]() { QTimer::singleShot(0, this, [this]() { syncToCursor(true); }); };
        connect(model(), &QAbstractItemModel::rowsInserted,  this, resync);
        connect(model(), &QAbstractItemModel::rowsRemoved,   this, resync);
        connect(model(), &QAbstractItemModel::modelReset,    this, resync);
        connect(model(), &QAbstractItemModel::layoutChanged, this, resync);
    }

    std::function<void(int from, int to)> onReorder;
    // A drag that did NOT start in this table is a link the user dropped onto
    // Nexa; the window handles it instead of trying to reorder rows.
    std::function<bool(const QMimeData *)> onExternalDrop;

protected:
    // ---- Row hover -------------------------------------------------------
    // The stylesheet deliberately has no ::item:hover (Qt applies it per cell,
    // and cells under a widget never show it, so a row used to light up block
    // by block). Instead the view paints ONE band under the whole row. It is a
    // plain hover: the row under the cursor is lit, the previous one is not,
    // with only a short fade so it never flickers. No travelling highlight.
    bool eventFilter(QObject *watched, QEvent *event) override
    {
        if (event->type() == QEvent::MouseMove) {
            auto *w = qobject_cast<QWidget *>(watched);
            if (w && w != viewport() && viewport()->isAncestorOf(w)) {
                const QPoint global = static_cast<QMouseEvent *>(event)->globalPosition().toPoint();
                setHoverRow(rowUnder(viewport()->mapFromGlobal(global)));
            }
        }
        return QTableWidget::eventFilter(watched, event);
    }

    bool viewportEvent(QEvent *event) override
    {
        switch (event->type()) {
        case QEvent::MouseMove:
            setHoverRow(rowUnder(static_cast<QMouseEvent *>(event)->position().toPoint()));
            break;
        case QEvent::Leave:
            // Only sent when the cursor really leaves the viewport (header,
            // another widget, outside the window) — not when it moves onto a
            // cell widget, which stays inside the viewport's hover chain.
            setHoverRow(-1);
            break;
        default:
            break;
        }
        return QTableWidget::viewportEvent(event);
    }

    void scrollContentsBy(int dx, int dy) override
    {
        QTableWidget::scrollContentsBy(dx, dy);
        // The rows moved under a still cursor: carry the band with its row so it
        // never lags the content, then re-aim at whatever is under the cursor now.
        m_bandY += dy;
        repaintBand();
        syncToCursor(false);
    }

    void paintEvent(QPaintEvent *event) override
    {
        if (m_mix > 0.005 && m_bandH > 0) {
            const theme::Palette &pal = theme::current();
            // The same colour the old per-cell rule flattened onto the row ground,
            // so every theme's hover reads exactly as it was designed.
            QColor c = theme::flatten(pal.rowHover, theme::flatten(pal.tableBg, QColor(pal.windowB)));
            c.setAlphaF(c.alphaF() * m_mix);
            QPainter p(viewport());
            p.setRenderHint(QPainter::Antialiasing, true);
            p.setPen(Qt::NoPen);
            p.setBrush(c);
            p.drawRoundedRect(bandRect(), kRadius, kRadius);
        }
        QTableWidget::paintEvent(event);   // items, row lines and the selection go on top
    }

    bool isExternal(const QDropEvent *event) const
    { return event->source() != this; }

    void dragEnterEvent(QDragEnterEvent *event) override
    {
        if (isExternal(event)) {
            if (onExternalDrop) event->acceptProposedAction();
            return;
        }
        QTableWidget::dragEnterEvent(event);
    }

    void dragMoveEvent(QDragMoveEvent *event) override
    {
        if (isExternal(event)) {
            if (onExternalDrop) event->acceptProposedAction();
            return;
        }
        QTableWidget::dragMoveEvent(event);
    }

    void dropEvent(QDropEvent *event) override
    {
        if (isExternal(event)) {
            if (onExternalDrop && onExternalDrop(event->mimeData()))
                event->acceptProposedAction();
            setState(NoState);
            stopAutoScroll();
            return;
        }
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

private:
    static constexpr int    kInsetX    = 6;     // the band is a card inside the row,
    static constexpr int    kInsetY    = 3;     // not a stripe across it
    static constexpr double kRadius    = 9.0;
    static constexpr int    kFadeInMs  = 90;    // just enough to not flicker
    static constexpr int    kFadeOutMs = 140;

    int rowUnder(const QPoint &viewportPos) const
    {
        if (!viewport()->rect().contains(viewportPos)) return -1;
        const int row = rowAt(viewportPos.y());
        return (row >= 0 && rowHeight(row) > 0) ? row : -1;   // filtered-out rows have no height
    }

    QRectF bandRect() const
    {
        return QRectF(kInsetX, m_bandY + kInsetY,
                      viewport()->width() - 2 * kInsetX, m_bandH - 2 * kInsetY);
    }

    // Repaint only the strip the band occupied and occupies now; the rest of
    // the list does not need a frame for a hover.
    void repaintBand()
    {
        const QRect now = bandRect().toAlignedRect().adjusted(-1, -1, 1, 1);
        viewport()->update(now.united(m_lastBand));
        m_lastBand = now;
    }

    static void retarget(QVariantAnimation *a, double from, double to, int ms)
    {
        a->stop();
        if (qAbs(to - from) < 1e-4) return;
        a->setStartValue(from);
        a->setEndValue(to);
        a->setDuration(qMax(1, int(ms / theme::current().motion.tempo)));
        a->start();
    }

    void setHoverRow(int row, bool snap = false)
    {
        if (row >= 0 && (row >= rowCount() || rowHeight(row) <= 0)) row = -1;
        if (row == m_hoverRow && !snap) return;
        m_hoverRow = row;
        if (row < 0) {
            retarget(m_fade, m_mix, 0.0, int(kFadeOutMs * m_mix));
            return;
        }
        // Move straight to the new row (repainting where the band was too),
        // then bring it up if it was not already showing.
        m_bandY = rowViewportPosition(row);
        m_bandH = rowHeight(row);
        repaintBand();
        retarget(m_fade, m_mix, 1.0, int(kFadeInMs * (1.0 - m_mix)));
    }

    void syncToCursor(bool snap)
    {
        if (!viewport()->underMouse()) {
            if (m_hoverRow >= 0) setHoverRow(-1);
            return;
        }
        setHoverRow(rowUnder(viewport()->mapFromGlobal(QCursor::pos())), snap);
    }

    QVariantAnimation *m_fade;
    int    m_hoverRow = -1;
    double m_mix   = 0.0;    // 0 = no band, 1 = fully shown
    double m_bandY = 0.0;    // viewport y of the hovered row
    double m_bandH = 0.0;
    QRect  m_lastBand;
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
    auto *bar = new motion::ThemedBar(w);
    bar->setObjectName(QStringLiteral("p_bar"));
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
    setWindowTitle(tr("Nexa Download Manager"));
    setWindowIcon(QIcon(QStringLiteral(":/nexa.png")));
    resize(1180, 720);
    // Below this the action-bar buttons + search would clip (no wrapping).
    setMinimumSize(880, 560);
    setAcceptDrops(true);      // drop a link, magnet or .torrent anywhere on the window

    auto *central = new QWidget(this);
    central->setObjectName(QStringLiteral("Root"));
    auto *root = new QVBoxLayout(central);
    root->setContentsMargins(0, 0, 0, 0);
    root->setSpacing(0);

    // ---- Header bar: logo + brand + breadcrumb (center) + actions (right) --
    auto *header = new QWidget(central);
    header->setObjectName(QStringLiteral("HeaderBar"));
    header->setFixedHeight(72);
    auto *hl = new QHBoxLayout(header);
    hl->setContentsMargins(22, 0, 22, 0);
    hl->setSpacing(12);

    // Brand mark: the Nexa logo (same asset as the window/empty-state icon).
    auto *logo = new QLabel(header);
    logo->setObjectName(QStringLiteral("BrandLogo"));
    logo->setFixedSize(42, 42);
    logo->setAlignment(Qt::AlignCenter);
    logo->setPixmap(QIcon(QStringLiteral(":/nexa.png")).pixmap(42, 42));

    auto *brandStack = new QWidget(header);
    brandStack->setStyleSheet(QStringLiteral("background:transparent;"));
    auto *brandLayout = new QVBoxLayout(brandStack);
    brandLayout->setContentsMargins(0, 0, 0, 0);
    brandLayout->setSpacing(1);
    auto *brand = new QLabel(tr("Nexa"), brandStack);
    brand->setObjectName(QStringLiteral("BrandTitle"));
    auto *brandSub = new QLabel(tr("DOWNLOAD MANAGER"), brandStack);
    brandSub->setObjectName(QStringLiteral("BrandSub"));
    brandLayout->addWidget(brand);
    brandLayout->addWidget(brandSub);

    auto *crumb = new QLabel(tr("Downloads  /  Overview"), header);
    crumb->setObjectName(QStringLiteral("Breadcrumb"));

    auto *settingsBtn = new QPushButton(tr("Settings"), header);
    settingsBtn->setObjectName(QStringLiteral("IconBtn"));
    settingsBtn->setCursor(Qt::PointingHandCursor);
    settingsBtn->setToolTip(tr("Settings, Site logins & more"));
    auto *folderBtn = new QPushButton(tr("Open folder"), header);
    folderBtn->setObjectName(QStringLiteral("IconBtn"));
    folderBtn->setCursor(Qt::PointingHandCursor);
    folderBtn->setToolTip(tr("Open the download folder"));
    auto *addBtn = new QPushButton(tr("+  New download"), header);
    addBtn->setObjectName(QStringLiteral("NewDl"));
    addBtn->setCursor(Qt::PointingHandCursor);
    addBtn->setToolTip(tr("Add a new download (URL, video, magnet, or playlist)"));

    hl->addWidget(logo);
    hl->addWidget(brandStack);
    hl->addStretch(1);
    hl->addWidget(crumb, 0, Qt::AlignVCenter);   // a pill, not a full-height block
    hl->addStretch(1);
    hl->addWidget(settingsBtn);
    hl->addWidget(folderBtn);
    hl->addWidget(addBtn);
    root->addWidget(header);

    addBtn->setAccessibleName(tr("New download"));
    folderBtn->setAccessibleName(tr("Open the download folder"));
    settingsBtn->setAccessibleName(tr("Settings and more"));
    logo->setAccessibleName(tr("Nexa"));
    connect(addBtn,    &QPushButton::clicked, this, &MainWindow::promptAddUrl);
    connect(folderBtn, &QPushButton::clicked, this, &MainWindow::openDownloadFolder);
    connect(settingsBtn, &QPushButton::clicked, this, [this, settingsBtn]() {
        QMenu menu(this);
        menu.addAction(tr("Settings…"),       this, &MainWindow::onSettings);
        menu.addAction(tr("Themes…"),         this, &MainWindow::onThemes);
        menu.addAction(tr("Site logins…"),    this, &MainWindow::onSiteLogins);
        QAction *clip = menu.addAction(tr("Monitor clipboard for links"));
        clip->setCheckable(true);
        clip->setChecked(m_clipboard && m_clipboard->isEnabled());
        connect(clip, &QAction::toggled, this, &MainWindow::setClipboardMonitoring);
        menu.addAction(tr("Remove selected"), this, &MainWindow::removeSelected);
        menu.addSeparator();
        menu.addAction(tr("Check for updates…"), this, &MainWindow::onCheckUpdates);
        menu.addAction(tr("Export logs…"), this, &MainWindow::onExportLogs);
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
        cv->setContentsMargins(22, 14, 22, 14);
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
    {   // Slot the sparkline under the SPEED value, above its caption.
        auto *spark = new SpeedSpark(m_metSpeedVal->parentWidget());
        m_speedSpark = spark;
        if (auto *lay = qobject_cast<QVBoxLayout *>(m_metSpeedVal->parentWidget()->layout()))
            lay->insertWidget(lay->indexOf(m_metSpeedSub), spark);
    }
    makeMetric(QStringLiteral("COMPLETED"), &m_metDoneVal,   &m_metDoneSub);
    makeMetric(QStringLiteral("STORAGE"),   &m_metStoreVal,  &m_metStoreSub);
    root->addWidget(metrics);

    // ---- Toolbar: ghost actions (left) + search (right) -------------------
    auto *toolbar = new QWidget(central);
    toolbar->setObjectName(QStringLiteral("Toolbar"));
    toolbar->setFixedHeight(56);
    auto *tl = new QHBoxLayout(toolbar);
    tl->setContentsMargins(22, 0, 22, 0);
    tl->setSpacing(8);
    auto ghost = [&](const QString &t) {
        auto *b = new QPushButton(t, toolbar);
        b->setObjectName(QStringLiteral("Ghost"));
        b->setCursor(Qt::PointingHandCursor);
        tl->addWidget(b);
        return b;
    };
    auto *pauseBtn  = ghost(QStringLiteral("Pause all"));
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
    m_search->setPlaceholderText(tr("Search..."));
    m_search->setClearButtonEnabled(true);
    m_search->setFixedWidth(270);
    m_search->addAction(searchIcon(), QLineEdit::LeadingPosition);   // magnifier inside left
    m_search->setAccessibleName(tr("Search downloads"));
    pauseBtn->setAccessibleName(tr("Pause all downloads"));
    resumeBtn->setAccessibleName(tr("Resume all downloads"));
    filterBtn->setAccessibleName(tr("Filter downloads by status"));
    sortBtn->setAccessibleName(tr("Sort downloads"));
    tl->addWidget(m_search);
    root->addWidget(toolbar);

    // ---- Sponsored strip: Free installs only ------------------------------
    // AdService decides whether there is anything to show (and refuses outright
    // on a paid plan); the banner hides itself whenever there isn't.
    m_ads = new AdService(m_engine->license(), this);
    m_adBanner = new AdBanner(m_ads, this);
    root->addWidget(m_adBanner);
    m_ads->start();

    connect(pauseBtn,  &QPushButton::clicked, this, &MainWindow::pauseAll);
    connect(resumeBtn, &QPushButton::clicked, this, &MainWindow::resumeAll);
    connect(filterBtn, &QPushButton::clicked, this, &MainWindow::showFilterMenu);
    connect(sortBtn,   &QPushButton::clicked, this, &MainWindow::showSortMenu);
    connect(m_search,  &QLineEdit::textChanged, this, &MainWindow::applyFilter);

    // ---- Downloads table --------------------------------------------------
    auto *table = new ReorderTable(0, ColCount, central);
    table->onExternalDrop = [this](const QMimeData *mime) { return addDroppedPayload(mime) > 0; };
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
    m_table->horizontalHeader()->setFixedHeight(38);
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
    // Wheel and drag scroll by pixels, not by whole 58px rows, so the list
    // glides instead of stepping.
    m_table->setVerticalScrollMode(QAbstractItemView::ScrollPerPixel);
    // The queue is the main content: it must be reachable and navigable by
    // keyboard (Tab to it, arrows to move, Space to pause, Delete to remove).
    m_table->setFocusPolicy(Qt::StrongFocus);
    m_table->setAccessibleName(tr("Downloads"));
    m_table->setAccessibleDescription(
        QStringLiteral("List of downloads. Use the arrow keys to choose one, Space to pause or "
                       "resume it, Ctrl+I for details, and Delete to remove it."));
    m_table->verticalHeader()->setVisible(false);
    m_table->verticalHeader()->setDefaultSectionSize(58);
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
    emptyIcon->setPixmap(QIcon(QStringLiteral(":/nexa.png")).pixmap(84, 84));
    emptyIcon->setFixedSize(84, 84);
    emptyIcon->setScaledContents(true);
    emptyIcon->setStyleSheet(QStringLiteral("opacity:0.5;"));
    emptyIcon->setAlignment(Qt::AlignCenter);
    auto *emptyKicker = new QLabel(tr("NEXA ENGINE READY"), emptyPage);
    emptyKicker->setObjectName(QStringLiteral("EmptyKicker"));
    emptyKicker->setAlignment(Qt::AlignCenter);
    auto *emptyTitle = new QLabel(tr("No downloads yet"), emptyPage);
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
    // The theme's own loading animation, idling: the empty page is the one
    // place a new user sees motion before anything is downloading.
    auto *emptyPulse = new motion::ThemedBar(emptyPage);
    emptyPulse->setObjectName(QStringLiteral("EmptyPulse"));
    emptyPulse->setFixedSize(140, 3);
    emptyPulse->setRange(0, 0);
    el->addSpacing(12);
    el->addWidget(emptyPulse, 0, Qt::AlignHCenter);
    el->addSpacing(16);
    el->addWidget(emptyKicker, 0, Qt::AlignHCenter);
    el->addSpacing(5);
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
    m_footerClear = new QPushButton(tr("Clear completed downloads"), this);
    m_footerClear->setObjectName(QStringLiteral("Ghost"));
    m_footerClear->setCursor(Qt::PointingHandCursor);
    m_footerClear->setEnabled(false);          // greyed until finished downloads exist
    connect(m_footerClear, &QPushButton::clicked, this, &MainWindow::clearCompleted);
    m_footerRight = new QLabel(tr("v%1  ·  NexaDL").arg(QApplication::applicationVersion()), this);
    m_footerRight->setObjectName(QStringLiteral("FootVer"));
    statusBar()->addWidget(m_footerLeft);
    // Permanent widgets sit at the bottom-right, laid left-to-right in call order.
    // Version first, then the Clear button — so the button lands in the far
    // bottom-right corner where it's most visible.
    statusBar()->addPermanentWidget(m_footerRight);
    statusBar()->addPermanentWidget(m_footerClear);
    statusBar()->setSizeGripEnabled(false);   // window resizes from its edges anyway

    connect(m_engine, &DownloadEngine::taskAdded,        this, &MainWindow::onTaskAdded);
    connect(m_engine, &DownloadEngine::taskProgress,     this, &MainWindow::onTaskProgress);
    connect(m_engine, &DownloadEngine::taskStateChanged, this, &MainWindow::onTaskStateChanged);
    connect(m_engine, &DownloadEngine::taskFinished,     this, &MainWindow::onTaskFinished);
    connect(m_engine, &DownloadEngine::taskRemoved,      this, &MainWindow::onTaskRemoved);
    connect(m_engine, &DownloadEngine::taskRenamed,      this, &MainWindow::onTaskRenamed);
    connect(m_engine, &DownloadEngine::freeLimitReached, this, &MainWindow::onFreeLimitReached);

    // A download refused outright by the plan (currently login-gated course
    // sites on Free). The engine supplies the wording so the reason is stated
    // once, in one place.
    connect(m_engine, &DownloadEngine::downloadBlocked, this,
            [this](const QUrl &, const QString &reason) {
        QMessageBox::information(this, tr("Pro feature"), reason);
    });

    // Every seat is busy on other machines. Not an error in the licence — say
    // exactly that, because "license rejected" would send the user hunting for
    // a problem with their key.
    connect(m_engine->license(), &LicenseManager::seatLimitReached, this,
            [this](int seats) {
        QMessageBox::warning(this, tr("All seats in use"),
            tr("This license covers %n device(s) at a time, and they are all in use "
               "right now.\n\nClose Nexa on another machine, or manage your devices at "
               "nexadownloadmanager.com/dashboard.", nullptr, seats));
    });
    // Distinct from the above: nobody else took the seat, it was handed back on
    // purpose from the website, so "close Nexa elsewhere" would be wrong advice.
    connect(m_engine->license(), &LicenseManager::seatRevoked, this, [this] {
        QMessageBox::warning(this, tr("Seat not available"),
            tr("This device's seat was freed from your Nexa account, so it has "
               "dropped to the Free plan.\n\nEnter your license key again in "
               "Settings to take a seat back, if one is available."));
    });
    connect(m_engine, &DownloadEngine::scheduledAdded,   this, [this](int) { updateStats(); });
    connect(m_engine, &DownloadEngine::scheduledRemoved, this, [this](int) { updateStats(); });
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

    // Optional malware scan of finished files (off by default; drives the
    // machine's own scanner). A detection is loud: dialog + tray notification.
    m_scanner = new VirusScanner(this);
    connect(m_scanner, &VirusScanner::infected, this,
            [this](int id, const QString &path, const QString &detail) {
        notifyTray(tr("Malware detected"), QFileInfo(path).fileName(), /*warning=*/true);
        QMessageBox box(this);
        box.setIcon(QMessageBox::Critical);
        box.setWindowTitle(tr("Malware detected"));
        box.setText(tr("Your scanner flagged “%1”.").arg(QFileInfo(path).fileName()));
        box.setInformativeText(detail);
        QPushButton *del = box.addButton(tr("Delete the file"), QMessageBox::DestructiveRole);
        box.addButton(tr("Keep it"), QMessageBox::RejectRole);
        box.exec();
        if (box.clickedButton() == del)
            m_engine->remove(id, /*deleteFile=*/true);
    });
    connect(m_scanner, &VirusScanner::clean, this, [this](int id, const QString &) {
        const int row = rowForId(id);
        if (row >= 0)
            if (auto *item = m_table->item(row, ColStatus))
                item->setToolTip(tr("Scanned: no malware found"));
    });
    connect(m_scanner, &VirusScanner::unavailable, this,
            [this](int, const QString &, const QString &why) {
        statusBar()->showMessage(tr("Virus scan could not run: %1").arg(why), 8000);
    });

    // Update checker (version notification only — never auto-installs). A silent
    // check runs shortly after launch if NEXA_UPDATE_URL is configured; the gear
    // menu's "Check for updates…" forces one with explicit feedback.
    m_updates = new UpdateChecker(this);
    connect(m_updates, &UpdateChecker::updateAvailable, this,
            [this](const QString &ver, const QString &url, const QString &notes, const QString &sha256) {
        const QString skip = QSettings().value(QStringLiteral("skipUpdateVersion")).toString();
        if (!m_manualUpdateCheck && ver == skip)
            return;   // user chose to skip this version on a prior silent check
        m_manualUpdateCheck = false;
        QMessageBox box(this);
        box.setWindowTitle(tr("Update available"));
        box.setText(tr("Nexa %1 is available (you have %2).")
                        .arg(ver, QApplication::applicationVersion()));
        if (!notes.isEmpty())
            box.setInformativeText(notes);
        QPushButton *get = nullptr;
        if (!url.isEmpty())
            get = box.addButton(tr("Download && install"), QMessageBox::AcceptRole);
        QPushButton *skipB = box.addButton(tr("Skip this version"), QMessageBox::DestructiveRole);
        box.addButton(tr("Later"), QMessageBox::RejectRole);
        box.exec();
        if (get && box.clickedButton() == get) {
            // The installer is just another download: segmented, resumable, and
            // (when the feed carries a checksum) SHA-256 verified before we run it.
            const int id = m_engine->addDownload(QUrl(url), QString(), {}, QString(), QString(),
                                                 false, /*userInitiated=*/true);
            if (id < 0) {
                QMessageBox::warning(this, QStringLiteral("Update"),
                                     QStringLiteral("The installer could not be queued."));
                return;
            }
            if (!sha256.isEmpty())
                if (auto *t = m_engine->task(id))
                    t->setExpectedSha256(sha256);
            m_pendingUpdateTask = id;
            m_pendingUpdateVersion = ver;
            statusBar()->showMessage(tr("Downloading Nexa %1…").arg(ver), 8000);
        } else if (box.clickedButton() == skipB) {
            QSettings().setValue(QStringLiteral("skipUpdateVersion"), ver);
        }
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
    // Silent daily check (Settings → "Check for updates automatically").
    if (m_updates->isConfigured()
        && QSettings().value(QStringLiteral("updates/auto"), true).toBool()) {
        const QDateTime last = QSettings().value(QStringLiteral("updates/lastCheck")).toDateTime();
        if (!last.isValid() || last.secsTo(QDateTime::currentDateTime()) > 24 * 3600)
            QTimer::singleShot(4000, this, [this]() {
                m_manualUpdateCheck = false;
                QSettings().setValue(QStringLiteral("updates/lastCheck"), QDateTime::currentDateTime());
                m_updates->check(QApplication::applicationVersion());
            });
    }

    buildMenuBar();
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
    // m_speedSpark is held as QWidget* because SpeedSpark is local to this file
    // (no Q_OBJECT, so no qobject_cast); nothing else is ever stored there.
    if (m_speedSpark)
        static_cast<SpeedSpark *>(m_speedSpark)->addSample(totalSpeed);
    m_metSpeedSub->setText(tr("avg per session"));

    m_metDoneVal->setText(QString::number(completed));
    m_metDoneSub->setText(tr("+%1 today").arg(m_completedThisSession));
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
        return QStringLiteral("<span style='color:%1'>%2:</span> "
                              "<span style='color:%3'>%4</span>")
            .arg(theme::current().textFaint, label, theme::current().textMuted)
            .arg(n);
    };
    QStringList parts{ stat(QStringLiteral("Active"), active),
                       stat(QStringLiteral("Queued"), queued),
                       stat(QStringLiteral("Done"),   completed) };
    if (errors) parts << stat(QStringLiteral("Errors"), errors);
    const int scheduled = m_engine->scheduledJobs().size();
    if (scheduled) parts << stat(QStringLiteral("Scheduled"), scheduled);
    m_footerLeft->setText(parts.join(QStringLiteral("&nbsp;&nbsp;&nbsp;&nbsp;")));

    // Bottom-right "Clear completed downloads" — always visible, enabled only
    // when there's something finished to clear.
    if (m_footerClear)
        m_footerClear->setEnabled(completed > 0);

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
    dlg.setWindowTitle(tr("New Download"));
    auto *outer = new QVBoxLayout(&dlg);
    outer->setContentsMargins(14, 14, 14, 14);
    auto *plate = new QWidget(&dlg);
    plate->setObjectName(QStringLiteral("Plate"));
    outer->addWidget(plate);
    auto *v = new QVBoxLayout(plate);
    v->setContentsMargins(18, 16, 18, 16);
    v->setSpacing(10);

    auto *lbl = new QLabel(tr("Enter URL"), plate);
    lbl->setProperty("ddRole", "label");
    auto *edit = new QLineEdit(preset, plate);
    edit->setMinimumWidth(420);
    edit->setPlaceholderText(QStringLiteral("https://…  (HTTP/FTP, video, magnet, or a course/playlist)"));
    auto *plCheck = new QCheckBox(tr("Download whole course / playlist"), plate);
    auto *plHint = new QLabel(QStringLiteral("For Udemy/Coursera course URLs or a YouTube "
                                             "playlist — fetches every lecture/video."), plate);
    plHint->setProperty("ddRole", "label");
    plHint->setWordWrap(true);

    // Audio-format row — only relevant (and only shown) for audio-only sites like
    // Apple Music, where the user can choose the output container/codec. The combo's
    // user-data carries the yt-dlp token ("m4a"/"aac"/"flac"/"mp3"); M4A is the
    // default because Apple serves AAC, so M4A copies it losslessly with no re-encode.
    auto *afRow = new QWidget(plate);
    auto *afLay = new QHBoxLayout(afRow);
    afLay->setContentsMargins(0, 0, 0, 0);
    auto *afLbl = new QLabel(tr("Audio format"), afRow);
    afLbl->setProperty("ddRole", "label");
    auto *afCombo = new QComboBox(afRow);
    afCombo->addItem(tr("M4A · AAC (lossless copy, best)"), QStringLiteral("m4a"));
    afCombo->addItem(tr("AAC"),  QStringLiteral("aac"));
    afCombo->addItem(tr("FLAC (re-encode)"), QStringLiteral("flac"));
    afCombo->addItem(tr("MP3 (re-encode)"),  QStringLiteral("mp3"));
    afLay->addWidget(afLbl);
    afLay->addWidget(afCombo, 1);
    afRow->setVisible(false);

    // Optional integrity check: paste the publisher's SHA-256 and Nexa verifies
    // the finished file against it (mismatch = error, never a silent bad file).
    auto *hashEdit = new QLineEdit(plate);
    hashEdit->setPlaceholderText(tr("SHA-256 to verify after download (optional)"));
    hashEdit->setToolTip(tr("64 hex characters, as published next to the file."));

    // IDM-style scheduler: start at a chosen time instead of now.
    auto *laterRow = new QWidget(plate);
    auto *laterLay = new QHBoxLayout(laterRow);
    laterLay->setContentsMargins(0, 0, 0, 0);
    auto *laterCheck = new QCheckBox(tr("Start later, at"), laterRow);
    auto *laterWhen = new QDateTimeEdit(QDateTime::currentDateTime().addSecs(3600), laterRow);
    laterWhen->setCalendarPopup(true);
    laterWhen->setDisplayFormat(QStringLiteral("ddd d MMM yyyy  HH:mm"));
    laterWhen->setMinimumDateTime(QDateTime::currentDateTime());
    laterWhen->setEnabled(false);
    laterLay->addWidget(laterCheck);
    laterLay->addWidget(laterWhen, 1);
    connect(laterCheck, &QCheckBox::toggled, laterWhen, &QWidget::setEnabled);

    // Show the audio-format row only when the typed URL is an Apple Music link.
    auto isAppleMusic = [](const QString &text) {
        const QString host = QUrl::fromUserInput(text.trimmed()).host().toLower();
        return host == QStringLiteral("music.apple.com") ||
               host.endsWith(QStringLiteral(".music.apple.com"));
    };
    auto syncAudioRow = [afRow, isAppleMusic](const QString &text) {
        afRow->setVisible(isAppleMusic(text));
    };
    connect(edit, &QLineEdit::textChanged, plate, syncAudioRow);
    syncAudioRow(edit->text());

    auto *btns = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel, plate);
    if (auto *okBtn = btns->button(QDialogButtonBox::Ok)) {
        okBtn->setObjectName(QStringLiteral("Primary"));
        okBtn->setText(tr("Download"));
    }
    v->addWidget(lbl);
    v->addWidget(edit);
    v->addWidget(plCheck);
    v->addWidget(plHint);
    v->addWidget(afRow);
    v->addWidget(hashEdit);
    v->addWidget(laterRow);
    v->addStretch(1);
    v->addWidget(btns);
    connect(btns, &QDialogButtonBox::accepted, &dlg, &QDialog::accept);
    connect(btns, &QDialogButtonBox::rejected, &dlg, &QDialog::reject);
    edit->setFocus();

    if (dlg.exec() != QDialog::Accepted || edit->text().trimmed().isEmpty())
        return;
    const QString expectedHash = hashEdit->text().trimmed().toLower();
    static const QRegularExpression hexRe(QStringLiteral("\\A[0-9a-f]{64}\\z"));
    if (!expectedHash.isEmpty() && !hexRe.match(expectedHash).hasMatch()) {
        QMessageBox::warning(this, QStringLiteral("Invalid checksum"),
                             QStringLiteral("A SHA-256 is 64 hexadecimal characters."));
        return;
    }

    if (laterCheck->isChecked() && laterWhen->dateTime() > QDateTime::currentDateTime()) {
        const int sid = m_engine->scheduleDownload(QUrl::fromUserInput(edit->text().trimmed()),
                                                   laterWhen->dateTime());
        if (sid < 0)
            QMessageBox::warning(this, QStringLiteral("Invalid URL"),
                                 QStringLiteral("That URL could not be parsed."));
        else
            statusBar()->showMessage(tr("Scheduled for %1 — see Downloads → Scheduled…")
                                         .arg(laterWhen->dateTime().toString(QStringLiteral("ddd d MMM HH:mm"))), 8000);
        return;
    }

    // userInitiated=true: the user already confirmed here, so start directly
    // rather than firing the second "confirm before download" prompt.
    // Pass the chosen audio format only when the row is showing (Apple Music); it's a
    // no-op for every other site, so an empty string elsewhere keeps behaviour intact.
    const QString audioFmt = afRow->isVisible() ? afCombo->currentData().toString() : QString();
    const int id = m_engine->addDownload(QUrl::fromUserInput(edit->text().trimmed()),
                                         QString(), {}, QString(), QString(),
                                         plCheck->isChecked(), /*userInitiated=*/true, audioFmt);
    if (id < 0) {
        QMessageBox::warning(this, QStringLiteral("Invalid URL"),
                             QStringLiteral("That URL could not be parsed."));
        return;
    }
    if (!expectedHash.isEmpty()) {
        if (auto *t = m_engine->task(id))
            t->setExpectedSha256(expectedHash);
        else
            statusBar()->showMessage(tr("Checksum verification applies to file downloads only."), 6000);
    }
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
    dlg.setWindowTitle(tr("New Download"));
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
    auto *later  = new QPushButton(tr("Download Later"), plate);
    auto *cancel = new QPushButton(tr("Cancel"), plate);
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
    dlg.setWindowTitle(tr("Download complete"));
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
    auto *savedLbl = new QLabel(tr("Saved to"), plate);
    savedLbl->setProperty("ddRole", "label");
    auto *pathL = new QLabel(QFileInfo(path).absolutePath(), plate);
    pathL->setObjectName(QStringLiteral("Dd_host"));
    pathL->setWordWrap(true);
    auto *dontShow = new QCheckBox(tr("Don't show this dialog again"), plate);

    auto *btnRow = new QHBoxLayout;
    auto *folderBtn = new QPushButton(tr("Open folder"), plate);
    auto *closeBtn  = new QPushButton(tr("Close"), plate);
    auto *openBtn   = new QPushButton(tr("Open"), plate);
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

void MainWindow::showLinkGrabber(const QString &pageUrl, const QString &pageTitle,
                                 const QVector<LinkItem> &links, const HeaderList &headers)
{
    showAndRaise();
    auto *dlg = new LinkGrabberDialog(m_engine, pageUrl, pageTitle, links, headers, this);
    dlg->show();
    dlg->raise();
    dlg->activateWindow();
}

// The Free plan runs 3 downloads at once. When a 4th is queued because of that
// cap, say so once per session and offer the trial / a license key — a silent
// queue reads as "Nexa is slow", which is the opposite of what happened.
void MainWindow::onFreeLimitReached(int id)
{
    Q_UNUSED(id);
    if (m_upgradeNudged || m_restoring)
        return;
    if (!QSettings().value(QStringLiteral("ui/upgradeNudge"), true).toBool())
        return;
    m_upgradeNudged = true;

    QMessageBox box(this);
    box.setWindowTitle(tr("Free plan: 3 downloads at once"));
    box.setText(tr("This download is queued — the Free plan runs 3 downloads at a time."));
    box.setInformativeText(QStringLiteral("Pro removes the limit (up to 16 at once), adds AI file naming, "
                                          "and starts with a free 7-day trial — no card needed."));
    QPushButton *trial = box.addButton(tr("Start free trial"), QMessageBox::AcceptRole);
    QPushButton *key   = box.addButton(tr("Enter license key"), QMessageBox::ActionRole);
    box.addButton(tr("Not now"), QMessageBox::RejectRole);
    auto *dontShow = new QCheckBox(tr("Don't remind me again"), &box);
    box.setCheckBox(dontShow);
    box.exec();
    if (dontShow->isChecked())
        QSettings().setValue(QStringLiteral("ui/upgradeNudge"), false);
    if (box.clickedButton() == trial)
        QDesktopServices::openUrl(QUrl(QStringLiteral("https://nexadownloadmanager.com/pricing?trial=1")));
    else if (box.clickedButton() == key)
        onSettings();
}

void MainWindow::togglePauseSelected()
{
    const int id = selectedId();
    if (id < 0)
        return;
    const DownloadState s = m_engine->stateOf(id);
    if (s == DownloadState::Downloading || s == DownloadState::Probing || s == DownloadState::Queued)
        m_engine->pause(id);
    else if (s == DownloadState::Paused || s == DownloadState::Error)
        m_engine->resume(id);
}

// The installer finished downloading (and, when the feed had a checksum, was
// verified by the engine — a mismatch would have errored, never reached here).
void MainWindow::offerInstallUpdate(int id)
{
    const QString path = m_engine->savePathOf(id);
    const QString version = m_pendingUpdateVersion;
    const bool verified = m_stateDetail.value(id).contains(QLatin1String("verified"));
    m_pendingUpdateTask = -1;
    m_pendingUpdateVersion.clear();
    if (path.isEmpty() || !QFileInfo::exists(path))
        return;

    QMessageBox box(this);
    box.setWindowTitle(tr("Update ready"));
    box.setText(tr("Nexa %1 has been downloaded%2.")
                    .arg(version, verified ? QStringLiteral(" and verified") : QString()));
#ifdef Q_OS_WIN
    box.setInformativeText(QStringLiteral("Install now? Nexa will close while the installer runs; "
                                          "your downloads resume when you reopen it."));
#else
    box.setInformativeText(QStringLiteral("Open the package now? Your system's package installer "
                                          "will take it from here; restart Nexa afterwards."));
#endif
    QPushButton *now = box.addButton(tr("Install now"), QMessageBox::AcceptRole);
    box.addButton(tr("Later"), QMessageBox::RejectRole);
    box.exec();
    if (box.clickedButton() != now)
        return;
#ifdef Q_OS_WIN
    if (QProcess::startDetached(path, {}))
        QTimer::singleShot(300, qApp, &QApplication::quit);
    else
        QMessageBox::warning(this, QStringLiteral("Update"),
                             QStringLiteral("The installer could not be started. Run it from %1.").arg(path));
#else
    if (!QProcess::startDetached(QStringLiteral("xdg-open"), {path}))
        QDesktopServices::openUrl(QUrl::fromLocalFile(QFileInfo(path).absolutePath()));
#endif
}

void MainWindow::buildMenuBar()
{
    QMenuBar *bar = menuBar();

    QMenu *file = bar->addMenu(QStringLiteral("&File"));
    QAction *aNew = file->addAction(tr("&New download…"), this, &MainWindow::promptAddUrl);
    aNew->setShortcut(QKeySequence::New);
    QAction *aSmart = file->addAction(tr("&Smart add (AI)…"), this, &MainWindow::promptSmartAdd);
    aSmart->setShortcut(QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_N));
    file->addAction(tr("&Import downloads…"), this, &MainWindow::importDownloads);
    QAction *aFolder = file->addAction(tr("Open download &folder"), this, &MainWindow::openDownloadFolder);
    aFolder->setShortcut(QKeySequence(Qt::CTRL | Qt::Key_O));
    file->addSeparator();
    file->addAction(tr("&Export logs…"), this, &MainWindow::onExportLogs);
    file->addSeparator();
    QAction *aQuit = file->addAction(tr("&Quit Nexa"), qApp, &QApplication::quit);
    aQuit->setShortcut(QKeySequence::Quit);
    aQuit->setMenuRole(QAction::QuitRole);

    QMenu *dl = bar->addMenu(QStringLiteral("&Downloads"));
    QAction *aToggle = dl->addAction(tr("&Pause / resume selected"), this, &MainWindow::togglePauseSelected);
    aToggle->setShortcut(QKeySequence(Qt::Key_Space));
    QAction *aDetails = dl->addAction(tr("&Details…"), this, [this]() {
        const int id = selectedId();
        if (id >= 0)
            openDetails(id);
    });
    aDetails->setShortcut(QKeySequence(Qt::CTRL | Qt::Key_I));
    QAction *aRemove = dl->addAction(tr("&Remove selected"), this, &MainWindow::removeSelected);
    aRemove->setShortcut(QKeySequence::Delete);
    // Space and Delete are plain keys with window-wide shortcut context, so Qt
    // would dispatch them to these actions BEFORE the focused widget sees them —
    // making it impossible to type a space or delete a character in the search
    // box. Disable them whenever a text-entry widget holds focus.
    const auto syncTypingShortcuts = [aToggle, aRemove](QWidget *focused) {
        const bool typing = qobject_cast<QLineEdit *>(focused) != nullptr
                            || qobject_cast<QAbstractSpinBox *>(focused) != nullptr
                            || (focused && focused->inherits("QTextEdit"))
                            || (focused && focused->inherits("QPlainTextEdit"));
        aToggle->setEnabled(!typing);
        aRemove->setEnabled(!typing);
    };
    connect(qApp, &QApplication::focusChanged, this,
            [syncTypingShortcuts](QWidget *, QWidget *now) { syncTypingShortcuts(now); });
    syncTypingShortcuts(QApplication::focusWidget());
    dl->addSeparator();
    QAction *aPauseAll = dl->addAction(tr("Pause &all"), this, &MainWindow::pauseAll);
    aPauseAll->setShortcut(QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_P));
    QAction *aResumeAll = dl->addAction(tr("Resume a&ll"), this, &MainWindow::resumeAll);
    aResumeAll->setShortcut(QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_R));
    QAction *aClear = dl->addAction(tr("&Clear completed"), this, &MainWindow::clearCompleted);
    aClear->setShortcut(QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_Delete));
    dl->addSeparator();
    QAction *aSched = dl->addAction(tr("&Scheduled…"), this, &MainWindow::showScheduled);
    aSched->setShortcut(QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_S));
    QAction *aShut = dl->addAction(tr("Shut down computer when done (this session)"));
    aShut->setCheckable(true);
    connect(aShut, &QAction::toggled, this, [this](bool on) {
        m_shutdownThisSession = on;
        if (on)
            statusBar()->showMessage(tr("Nexa will shut the computer down when the queue finishes."), 6000);
    });

    QMenu *view = bar->addMenu(QStringLiteral("&View"));
    QAction *aFind = view->addAction(tr("&Find…"), this, [this]() {
        if (m_search) {
            m_search->setFocus(Qt::ShortcutFocusReason);
            m_search->selectAll();
        }
    });
    aFind->setShortcut(QKeySequence::Find);
    view->addAction(tr("F&ilter by status…"), this, &MainWindow::showFilterMenu);
    view->addAction(tr("&Sort…"), this, &MainWindow::showSortMenu);
    view->addSeparator();
    QAction *aThemes = view->addAction(tr("&Themes…"), this, &MainWindow::onThemes);
    aThemes->setShortcut(QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_T));

    QMenu *tools = bar->addMenu(QStringLiteral("&Tools"));
    QAction *aSettings = tools->addAction(tr("&Settings…"), this, &MainWindow::onSettings);
    aSettings->setShortcut(QKeySequence(Qt::CTRL | Qt::Key_Comma));
    aSettings->setMenuRole(QAction::PreferencesRole);
    tools->addAction(tr("Site &logins…"), this, &MainWindow::onSiteLogins);
    tools->addAction(tr("Setup &guide…"), this, &MainWindow::showSetupGuide);
    QAction *aClip = tools->addAction(tr("&Monitor clipboard for links"));
    aClip->setCheckable(true);
    connect(tools, &QMenu::aboutToShow, this, [this, aClip]() {
        const QSignalBlocker blocker(aClip);
        aClip->setChecked(m_clipboard && m_clipboard->isEnabled());
    });
    connect(aClip, &QAction::toggled, this, &MainWindow::setClipboardMonitoring);

    QMenu *help = bar->addMenu(QStringLiteral("&Help"));
    help->addAction(tr("&Documentation"), this, []() {
        QDesktopServices::openUrl(QUrl(QStringLiteral("https://nexadownloadmanager.com/docs")));
    });
    help->addAction(tr("&Report a problem"), this, []() {
        QDesktopServices::openUrl(QUrl(QStringLiteral("https://github.com/mehar99197/nexadownloadmanager/issues")));
    });
    help->addSeparator();
    help->addAction(tr("Check for &updates…"), this, &MainWindow::onCheckUpdates);
    QAction *aAbout = help->addAction(tr("&About Nexa"), this, [this]() {
        QMessageBox::about(this, QStringLiteral("About Nexa"),
            QStringLiteral("<b>Nexa Download Manager</b> %1<br><br>"
                           "Segmented downloads, video grabbing, torrents and cloud links "
                           "in one queue — on Windows and Linux.<br><br>"
                           "<a href=\"https://nexadownloadmanager.com\">nexadownloadmanager.com</a>")
                .arg(QApplication::applicationVersion()));
    });
    aAbout->setMenuRole(QAction::AboutRole);
}

void MainWindow::showScheduled()
{
    QDialog dlg(this);
    dlg.setWindowTitle(tr("Scheduled downloads"));
    auto *outer = new QVBoxLayout(&dlg);
    outer->setContentsMargins(14, 14, 14, 14);
    auto *plate = new QWidget(&dlg);
    plate->setObjectName(QStringLiteral("Plate"));
    outer->addWidget(plate);
    auto *v = new QVBoxLayout(plate);
    v->setContentsMargins(18, 16, 18, 16);
    v->setSpacing(8);

    auto *table = new QTableWidget(0, 3, plate);
    table->setHorizontalHeaderLabels({QStringLiteral("Starts"), QStringLiteral("URL"), QString()});
    table->verticalHeader()->setVisible(false);
    table->setEditTriggers(QAbstractItemView::NoEditTriggers);
    table->setSelectionMode(QAbstractItemView::NoSelection);
    table->setShowGrid(false);
    table->horizontalHeader()->setSectionResizeMode(1, QHeaderView::Stretch);
    table->setColumnWidth(0, 170);
    table->setColumnWidth(2, 90);
    auto *empty = new QLabel(tr("Nothing scheduled. Tick “Start later” in New download to add one."), plate);
    empty->setProperty("ddRole", "label");
    empty->setWordWrap(true);

    auto refill = [this, table, empty]() {
        const auto jobs = m_engine->scheduledJobs();
        table->setRowCount(0);
        for (const auto &job : jobs) {
            const int row = table->rowCount();
            table->insertRow(row);
            table->setItem(row, 0, new QTableWidgetItem(job.when.toString(QStringLiteral("ddd d MMM  HH:mm"))));
            auto *urlItem = new QTableWidgetItem(job.url.toString());
            urlItem->setToolTip(job.url.toString());
            table->setItem(row, 1, urlItem);
            auto *cancel = new QPushButton(tr("Cancel"), table);
            cancel->setCursor(Qt::PointingHandCursor);
            const int jobId = job.id;
            connect(cancel, &QPushButton::clicked, this, [this, jobId]() { m_engine->cancelScheduled(jobId); });
            table->setCellWidget(row, 2, cancel);
        }
        table->setVisible(!jobs.isEmpty());
        empty->setVisible(jobs.isEmpty());
    };
    refill();
    connect(m_engine, &DownloadEngine::scheduledRemoved, &dlg, [refill](int) { refill(); });
    connect(m_engine, &DownloadEngine::scheduledAdded,   &dlg, [refill](int) { refill(); });

    auto *btns = new QDialogButtonBox(QDialogButtonBox::Close, plate);
    connect(btns, &QDialogButtonBox::rejected, &dlg, &QDialog::reject);
    v->addWidget(table, 1);
    v->addWidget(empty);
    v->addWidget(btns);
    dlg.resize(720, 360);
    dlg.exec();
}

namespace {
// Platform power actions for "when all downloads finish". Returns false when
// no command could be started (the user is told; nothing else happens).
bool runPowerAction(const QString &action)
{
    QStringList candidates;   // "program|arg|arg" — first that starts wins
#if defined(Q_OS_WIN)
    if (action == QLatin1String("shutdown"))
        candidates << QStringLiteral("shutdown|/s|/t|5");
    else
        candidates << QStringLiteral("rundll32.exe|powrprof.dll,SetSuspendState|0,1,0");
#elif defined(Q_OS_MACOS)
    if (action == QLatin1String("shutdown"))
        candidates << QStringLiteral("osascript|-e|tell application \"System Events\" to shut down");
    else
        candidates << QStringLiteral("pmset|sleepnow");
#else
    if (action == QLatin1String("shutdown"))
        candidates << QStringLiteral("systemctl|poweroff") << QStringLiteral("loginctl|poweroff")
                   << QStringLiteral("shutdown|-h|now");
    else
        candidates << QStringLiteral("systemctl|suspend") << QStringLiteral("loginctl|suspend");
#endif
    for (const QString &c : candidates) {
        QStringList parts = c.split(QLatin1Char('|'));
        const QString prog = parts.takeFirst();
        if (QProcess::startDetached(prog, parts))
            return true;
    }
    return false;
}
} // namespace

// Runs once per batch, after the last active job finishes: open folder, sleep,
// or shut down (Settings), or the session-only "shut down when done" toggle.
// Sleep/shutdown show a 60-second countdown the user can cancel.
void MainWindow::maybeRunWhenDone()
{
    if (m_whenDoneFired || m_restoring)
        return;
    if (!m_engine->allTerminal() || !m_engine->scheduledJobs().isEmpty())
        return;
    QString action = QSettings().value(QStringLiteral("ui/whenDone"), QStringLiteral("none")).toString();
    if (m_shutdownThisSession)
        action = QStringLiteral("shutdown");
    if (action == QLatin1String("none"))
        return;
    m_whenDoneFired = true;

    if (action == QLatin1String("folder")) {
        openDownloadFolder();
        return;
    }
    const bool shutdown = action == QLatin1String("shutdown");
    showAndRaise();
    QProgressDialog countdown(this);
    countdown.setWindowTitle(shutdown ? QStringLiteral("Shutting down") : QStringLiteral("Going to sleep"));
    countdown.setLabelText(tr("All downloads finished. %1 in 60 seconds…")
                               .arg(shutdown ? QStringLiteral("Shutting down") : QStringLiteral("Sleeping")));
    countdown.setCancelButtonText(tr("Cancel"));
    countdown.setRange(0, 60);
    countdown.setValue(0);
    countdown.setWindowModality(Qt::ApplicationModal);
    countdown.setMinimumDuration(0);
    int elapsed = 0;
    QTimer tick;
    tick.setInterval(1000);
    connect(&tick, &QTimer::timeout, &countdown, [&]() {
        ++elapsed;
        // Accept BEFORE the value can reach the maximum: setValue(maximum) makes
        // QProgressDialog reset() and hide itself, which would end exec() with an
        // ambiguous result instead of our explicit "countdown finished".
        if (elapsed >= 60) {
            countdown.accept();
            return;
        }
        countdown.setValue(elapsed);
        countdown.setLabelText(tr("All downloads finished. %1 in %2 seconds…")
                                   .arg(shutdown ? QStringLiteral("Shutting down") : QStringLiteral("Sleeping"))
                                   .arg(60 - elapsed));
    });
    tick.start();
    const bool finished = countdown.exec() == QDialog::Accepted;
    tick.stop();
    if (!finished || countdown.wasCanceled()) {
        m_shutdownThisSession = false;
        statusBar()->showMessage(tr("Cancelled."), 4000);
        return;
    }
    if (!runPowerAction(action))
        QMessageBox::warning(this, QStringLiteral("Power action failed"),
                             QStringLiteral("Nexa could not %1 this computer (no permission or command available).")
                                 .arg(shutdown ? QStringLiteral("shut down") : QStringLiteral("suspend")));
    else if (shutdown)
        QTimer::singleShot(500, qApp, &QApplication::quit);
}

// A drag carries something we can download when it has file/http URLs, a magnet,
// or plain text that parses as one of those.
bool MainWindow::payloadLooksDownloadable(const QMimeData *mime)
{
    if (!mime)
        return false;
    if (mime->hasUrls()) {
        const auto urls = mime->urls();
        for (const QUrl &u : urls) {
            const QString s = u.scheme().toLower();
            if (s == QLatin1String("http") || s == QLatin1String("https")
                || s == QLatin1String("ftp") || s == QLatin1String("magnet"))
                return true;
            if (u.isLocalFile() && u.toLocalFile().endsWith(QLatin1String(".torrent"), Qt::CaseInsensitive))
                return true;
        }
        return false;
    }
    if (mime->hasText()) {
        const QString t = mime->text().trimmed();
        return t.startsWith(QLatin1String("http://"), Qt::CaseInsensitive)
               || t.startsWith(QLatin1String("https://"), Qt::CaseInsensitive)
               || t.startsWith(QLatin1String("ftp://"), Qt::CaseInsensitive)
               || t.startsWith(QLatin1String("magnet:"), Qt::CaseInsensitive);
    }
    return false;
}

// Queue everything downloadable in a drop. Local .torrent files are handed over
// as file URLs (the engine's torrent path takes them); text may hold several
// links, one per line.
int MainWindow::addDroppedPayload(const QMimeData *mime)
{
    if (!mime)
        return 0;
    QStringList targets;
    if (mime->hasUrls()) {
        const auto urls = mime->urls();
        for (const QUrl &u : urls) {
            const QString s = u.scheme().toLower();
            if (u.isLocalFile()) {
                if (u.toLocalFile().endsWith(QLatin1String(".torrent"), Qt::CaseInsensitive))
                    targets << u.toLocalFile();
            } else if (s == QLatin1String("http") || s == QLatin1String("https")
                       || s == QLatin1String("ftp") || s == QLatin1String("magnet")) {
                targets << u.toString();
            }
        }
    } else if (mime->hasText()) {
        const auto lines = mime->text().split(QRegularExpression(QStringLiteral("[\\r\\n]")),
                                              Qt::SkipEmptyParts);
        for (const QString &line : lines) {
            const QString t = line.trimmed();
            if (t.startsWith(QLatin1String("http"), Qt::CaseInsensitive)
                || t.startsWith(QLatin1String("ftp://"), Qt::CaseInsensitive)
                || t.startsWith(QLatin1String("magnet:"), Qt::CaseInsensitive))
                targets << t;
        }
    }
    int added = 0;
    for (const QString &t : targets) {
        // userInitiated: dropping it IS the confirmation, so don't ask again.
        const int id = m_engine->addDownload(QUrl::fromUserInput(t), QString(), {}, QString(),
                                             QString(), false, /*userInitiated=*/true);
        if (id >= 0)
            ++added;
    }
    if (added > 0) {
        showAndRaise();
        statusBar()->showMessage(added == 1 ? QStringLiteral("Added 1 download")
                                            : QStringLiteral("Added %1 downloads").arg(added), 5000);
    }
    return added;
}

void MainWindow::dragEnterEvent(QDragEnterEvent *event)
{
    if (payloadLooksDownloadable(event->mimeData()))
        event->acceptProposedAction();
}

void MainWindow::dragMoveEvent(QDragMoveEvent *event)
{
    if (payloadLooksDownloadable(event->mimeData()))
        event->acceptProposedAction();
}

void MainWindow::dropEvent(QDropEvent *event)
{
    if (addDroppedPayload(event->mimeData()) > 0)
        event->acceptProposedAction();
}

// Per-download speed cap. Shown from the row menu; 0 means "no limit".
void MainWindow::promptSpeedLimit(int id)
{
    if (!m_engine->supportsSpeedLimit(id))
        return;
    const qint64 current = m_engine->taskSpeedLimit(id);
    bool ok = false;
    const int kb = QInputDialog::getInt(
        this, QStringLiteral("Limit this download"),
        QStringLiteral("Maximum speed for “%1”, in KB/s.\n0 means no limit for this download.")
            .arg(m_engine->nameOf(id)),
        int(current / 1024), 0, 1024 * 1024, 64, &ok);
    if (!ok)
        return;
    m_engine->setTaskSpeedLimit(id, qint64(kb) * 1024);
    statusBar()->showMessage(kb > 0
        ? QStringLiteral("Limited to %1").arg(humanSpeed(double(kb) * 1024))
        : QStringLiteral("Speed limit removed"), 5000);
}

// Natural-language add/schedule ("grab these two tonight at 2am"). Needs an
// Anthropic key and a paid plan; both are reported plainly when missing.
void MainWindow::promptSmartAdd()
{
    if (!m_engine->aiAvailable()) {
        QMessageBox::information(this, QStringLiteral("Smart add"),
            QStringLiteral("Smart add needs an active Pro or Team license.\n\nIt runs on Nexa's "
                           "servers, so it is unavailable on the Free plan."));
        return;
    }
    if (m_engine->licensePlan() == QLatin1String("free")) {
        QMessageBox::information(this, QStringLiteral("Smart add"),
            QStringLiteral("Smart add is a Pro feature. Start the free 7-day trial from "
                           "Settings or nexadownloadmanager.com/pricing."));
        return;
    }
    bool ok = false;
    const QString text = QInputDialog::getMultiLineText(
        this, QStringLiteral("Smart add"),
        QStringLiteral("Describe what you want, in your own words:"),
        QStringLiteral("download https://example.com/a.iso and https://example.com/b.iso tonight at 2am"),
        &ok);
    if (!ok || text.trimmed().isEmpty())
        return;
    m_engine->runAiCommand(text.trimmed());
    statusBar()->showMessage(tr("Working on it — new downloads will appear here."), 6000);
}

// Switching from another manager: read its export file and queue everything the
// user picks. Supported formats live in core/DownloadImport.
void MainWindow::importDownloads()
{
    const QString path = QFileDialog::getOpenFileName(
        this, tr("Import downloads"), QDir::homePath(), downloadimport::fileDialogFilter());
    if (path.isEmpty())
        return;
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text)) {
        QMessageBox::warning(this, tr("Import failed"),
                             tr("Could not read %1.").arg(path));
        return;
    }
    // Exports are small; a huge file here means it isn't one.
    const QByteArray raw = f.read(8 * 1024 * 1024);
    f.close();
    const auto items = downloadimport::parseAny(path, QString::fromUtf8(raw));
    if (items.isEmpty()) {
        QMessageBox::information(this, tr("Nothing to import"),
            tr("No downloadable links were found in %1.").arg(QFileInfo(path).fileName()));
        return;
    }
    // Show them in the link grabber so the user chooses what actually gets queued.
    QVector<LinkItem> links;
    links.reserve(items.size());
    for (const auto &d : items)
        links.append({d.url, d.fileName, QStringLiteral("link")});
    // Headers differ per entry; the grabber applies one set, so pass the first
    // entry's context (the common case: one export, one site).
    showLinkGrabber(QString(), QFileInfo(path).fileName(), links,
                    items.first().headers);
}

void MainWindow::showSetupGuide()
{
    showAndRaise();
    auto *wiz = new FirstRunWizard(m_engine, this);
    wiz->setAttribute(Qt::WA_DeleteOnClose);
    connect(wiz, &QDialog::finished, this, [this](int) {
        // The wizard may have changed the clipboard-capture preference.
        setClipboardMonitoring(QSettings().value(QStringLiteral("clipboardMonitor"), false).toBool());
    });
    wiz->show();
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

// Gear menu → "Export logs…": copy the opt-in troubleshooting log to a place the
// user picks (so they can attach it to a bug report).
void MainWindow::onExportLogs()
{
    const QString src = logFilePath();
    if (!QFileInfo::exists(src) || QFileInfo(src).size() == 0) {
        QMessageBox::information(this, QStringLiteral("No log yet"),
            QStringLiteral("Turn on “Save error logs to a file” in Settings. The log is written "
                           "at %1 the next time Nexa reports a warning or error.").arg(src));
        return;
    }
    const QString suggested = QDir::homePath() + QStringLiteral("/nexa-log-%1.txt")
        .arg(QDateTime::currentDateTime().toString(QStringLiteral("yyyyMMdd-HHmm")));
    const QString dest = QFileDialog::getSaveFileName(this, QStringLiteral("Export logs"), suggested,
                                                      QStringLiteral("Text files (*.txt *.log)"));
    if (dest.isEmpty())
        return;
    if (QFileInfo::exists(dest))
        QFile::remove(dest);
    if (!QFile::copy(src, dest)) {
        QMessageBox::warning(this, QStringLiteral("Export failed"),
                             QStringLiteral("Could not write %1.").arg(dest));
        return;
    }
    statusBar()->showMessage(tr("Log exported to %1").arg(dest), 6000);
}

void MainWindow::onThemes()
{
    ThemeGalleryDialog dlg(this);

    // Free installs get the two core palettes; the rest carry a PRO badge and
    // explain themselves when clicked. Entitlements come from the licence
    // server, so this list widens the moment a subscription activates.
    const Entitlements &features = m_engine->license()->features();
    dlg.setThemeEntitlement(features.themes == QLatin1String("all"), features.freeThemes);
    connect(&dlg, &ThemeGalleryDialog::lockedThemeChosen, this,
            [this, &dlg](const QString &, const QString &name) {
        QMessageBox::information(&dlg, tr("Pro theme"),
            tr("“%1” is part of the Pro theme collection.\n\n"
               "Free includes Nexa Dark and Nexa Light. Start the free 7-day trial in "
               "Settings, or see nexadownloadmanager.com/pricing to unlock all themes.")
                .arg(name));
    });

    // The gallery applies as you click, so repaint the hand-drawn bits live.
    connect(&dlg, &ThemeGalleryDialog::themeApplied, this, [this]() { refreshTheme(); });
    dlg.exec();
    refreshTheme();
}

// A theme swap re-styles everything driven by the stylesheet for free; these
// are the pieces Nexa paints itself and therefore has to redraw by hand.
void MainWindow::refreshTheme()
{
    for (auto it = m_idToRow.constBegin(); it != m_idToRow.constEnd(); ++it) {
        const int id = it.key(), row = it.value();
        if (row < 0 || row >= m_table->rowCount())
            continue;
        refreshFileCell(row, id);
        setRowStatus(row, m_engine->stateOf(id), m_stateDetail.value(id));
    }
    updateStats();
    update();
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
    connect(dlg, &SettingsDialog::settingsApplied, this, &MainWindow::dashboardSettingsChanged);
    connect(dlg, &SettingsDialog::themeChanged, this, &MainWindow::refreshTheme);
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
    if ((m_search && !m_search->text().trimmed().isEmpty()) || m_stateFilter != -1)
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

void MainWindow::clearCompleted()
{
    // Collect finished ids first — removing inside the snapshot loop would
    // invalidate the range being iterated.
    QList<int> done;
    for (const auto &s : m_engine->snapshot())
        if (s.state == DownloadState::Completed)
            done << s.id;
    if (done.isEmpty())
        return;

    const auto reply = QMessageBox::question(
        this, QStringLiteral("Clear Completed"),
        QStringLiteral("Remove %1 completed download%2 from the list?\n"
                       "(The downloaded files are kept.)")
            .arg(done.size())
            .arg(done.size() == 1 ? QString() : QStringLiteral("s")));
    if (reply != QMessageBox::Yes)
        return;

    for (int id : done)
        m_engine->remove(id, false);   // false = keep the file on disk
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
    m_tray->setToolTip(tr("Nexa Download Manager"));

    auto *menu = new QMenu(this);
    menu->addAction(tr("Open Nexa"),  this, &MainWindow::showAndRaise);
    menu->addAction(tr("Add URL…"),   this, &MainWindow::promptAddUrl);
    menu->addSeparator();
    menu->addAction(tr("Quit Nexa"),  qApp, &QApplication::quit);
    m_tray->setContextMenu(menu);

    // Single click / double click on the tray icon surfaces the window.
    connect(m_tray, &QSystemTrayIcon::activated, this,
            [this](QSystemTrayIcon::ActivationReason r) {
                if (r == QSystemTrayIcon::Trigger || r == QSystemTrayIcon::DoubleClick)
                    showAndRaise();
            });
    // Clicking a notification balloon brings the window back.
    connect(m_tray, &QSystemTrayIcon::messageClicked, this, &MainWindow::showAndRaise);
    m_tray->show();
    return true;
}

void MainWindow::notifyTray(const QString &title, const QString &body, bool warning)
{
    if (!m_tray || !m_tray->isVisible())
        return;
    if (!QSettings().value(QStringLiteral("ui/notifications"), true).toBool())
        return;
    m_tray->showMessage(title, body,
                        warning ? QSystemTrayIcon::Warning : QSystemTrayIcon::Information,
                        7000);
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
    menu.addAction(tr("Name (A–Z)"), this, [this, sortBy]() {
        sortBy([this](int a, int b) {
            return m_engine->nameOf(a).compare(m_engine->nameOf(b), Qt::CaseInsensitive) < 0; });
    });
    menu.addAction(tr("Status"), this, [this, sortBy]() {
        sortBy([this](int a, int b) { return int(m_engine->stateOf(a)) < int(m_engine->stateOf(b)); });
    });
    menu.addAction(tr("Host"), this, [this, sortBy]() {
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
    menu.addAction(tr("Details…"), this, [this, id]() { openDetails(id); });
    menu.addSeparator();
    menu.addAction(tr("Pause"),  this, [this, id]() { m_engine->pause(id); });
    menu.addAction(tr("Resume"), this, [this, id]() { m_engine->resume(id); });
    menu.addSeparator();
    // Reorder the queue (also possible by dragging the row).
    QAction *top = menu.addAction(tr("Move to top"),
                                  this, [this, row]() { moveRow(row, 0); });
    QAction *up  = menu.addAction(tr("Move up"),
                                  this, [this]() { moveSelected(-1); });
    QAction *dn  = menu.addAction(tr("Move down"),
                                  this, [this]() { moveSelected(+1); });
    top->setEnabled(row > 0);
    up->setEnabled(row > 0);
    dn->setEnabled(row < m_table->rowCount() - 1);
    const bool filtered = (m_search && !m_search->text().trimmed().isEmpty()) || m_stateFilter != -1;
    if (filtered) {
        for (QAction *a : {top, up, dn}) {
            a->setEnabled(false);
            a->setToolTip(tr("Clear the search/filter to reorder the queue"));
        }
        menu.setToolTipsVisible(true);
    }
    menu.addSeparator();
    if (m_engine->supportsSpeedLimit(id)) {
        const qint64 cap = m_engine->taskSpeedLimit(id);
        menu.addAction(cap > 0 ? QStringLiteral("Limit speed… (now %1)").arg(humanSpeed(double(cap)))
                               : QStringLiteral("Limit speed…"),
                       this, [this, id]() { promptSpeedLimit(id); });
    }
    menu.addSeparator();
    menu.addAction(tr("Remove"), this, &MainWindow::removeSelected);
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
    // Progress fill colour follows the state (active / amber paused / green done);
    // the fill STYLE and the loading animation are the theme's.
    if (auto *pc = m_table->cellWidget(row, ColProgress))
        if (auto *bar = pc->findChild<motion::ThemedBar*>(QStringLiteral("p_bar")))
            bar->setAccent(statusColor(state));
    // First action button is contextual: pause (running) / resume (paused/error) /
    // open-folder (done). A queued item has nothing to toggle — show only Remove.
    if (auto *ac = m_table->cellWidget(row, ColActions)) {
        if (auto *tg = ac->findChild<QPushButton*>(QStringLiteral("a_toggle"))) {
            if (state == DownloadState::Completed) {
                tg->setText(QString::fromUtf8("🗀")); tg->setToolTip(tr("Open folder")); tg->setVisible(true);
            } else if (state == DownloadState::Downloading || state == DownloadState::Probing) {
                tg->setText(QString::fromUtf8("❚❚")); tg->setToolTip(tr("Pause"));       tg->setVisible(true);
            } else if (state == DownloadState::Queued) {
                tg->setVisible(false);
            } else {   // Paused / Error
                tg->setText(QString::fromUtf8("▶")); tg->setToolTip(tr("Resume"));        tg->setVisible(true);
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
    // The label is a glyph, so state the action for assistive technology.
    toggle->setAccessibleName(tr("Pause or resume this download"));
    auto *second = new QPushButton(QString::fromUtf8("✕"), w);
    second->setObjectName(QStringLiteral("a_second"));
    second->setProperty("ActIcon", true);
    second->setFixedSize(24, 24);
    second->setCursor(Qt::PointingHandCursor);
    second->setToolTip(tr("Remove"));
    second->setAccessibleName(tr("Remove this download"));
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
    menu.addAction(tr("Details…"), this, [this, id]() { openDetails(id); });
    menu.addSeparator();
    menu.addAction(tr("Pause"),  this, [this, id]() { m_engine->pause(id); });
    menu.addAction(tr("Resume"), this, [this, id]() { m_engine->resume(id); });
    menu.addSeparator();
    menu.addAction(tr("Open download folder"), this, &MainWindow::openDownloadFolder);
    menu.addAction(tr("Remove"), this, &MainWindow::removeSelected);
    menu.exec(globalPos);
}

void MainWindow::onTaskAdded(int id)
{
    m_whenDoneFired = false;   // a new job starts a new batch for the when-done action

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
    sizeItem->setForeground(mutedTextColor());
    m_table->setItem(row, ColSize, sizeItem);

    m_table->setCellWidget(row, ColProgress, buildProgressCell());

    auto *speedItem = new QTableWidgetItem(QStringLiteral("—"));
    speedItem->setForeground(mutedTextColor());
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
        auto *bar = pc->findChild<motion::ThemedBar*>(QStringLiteral("p_bar"));
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
        speedItem->setForeground(s.isEmpty() ? mutedTextColor() : valueTextColor());
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

    // Announce a failure once per error episode (a retry that errors again after
    // leaving Error re-announces). Skipped during the startup restore replay.
    if (state == DownloadState::Error) {
        if (!m_restoring && !m_errorNotified.contains(id)) {
            m_errorNotified.insert(id);
            notifyTray(QStringLiteral("Download failed"),
                       detail.isEmpty() ? m_engine->nameOf(id)
                                        : QStringLiteral("%1\n%2").arg(m_engine->nameOf(id), detail),
                       /*warning=*/true);
        }
    } else {
        m_errorNotified.remove(id);
    }

    // A completed task always reads 100% (covers tasks restored as Complete,
    // whose final byte counts aren't replayed through onTaskProgress).
    if (state == DownloadState::Completed)
        onTaskFinished(id);

    // A non-downloading row shows no live speed.
    if (state != DownloadState::Downloading && state != DownloadState::Probing) {
        if (auto *speedItem = m_table->item(row, ColSpeed)) {
            speedItem->setText(QStringLiteral("—"));
            speedItem->setForeground(mutedTextColor());
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
        // Tray balloon when the user isn't looking at Nexa (window hidden, in the
        // tray, or behind the browser) or when the completion dialog is disabled;
        // otherwise the IDM-style dialog below is the announcement.
        const bool dialogOn = QSettings().value(QStringLiteral("ui/showCompleteDialog"), true).toBool();
        if (!isActiveWindow() || !dialogOn || m_engine->isPlaylist(id))
            notifyTray(QStringLiteral("Download complete"), m_engine->nameOf(id));
    }
    // The final progress signal can be missed by a restored/short download, so
    // use the finished file itself as the authoritative per-row byte count.
    // Playlists intentionally keep their "N videos" label instead of showing
    // the playlist directory's filesystem metadata as a byte size.
    if (!m_engine->isPlaylist(id)) {
        qint64 finalSize = -1;
        const QFileInfo file(m_engine->savePathOf(id));
        if (file.isFile())
            finalSize = file.size();
        if (finalSize < 0) {
            for (const auto &s : m_engine->snapshot()) {
                if (s.id != id)
                    continue;
                finalSize = s.total >= 0 ? s.total : s.done;
                break;
            }
        }
        if (finalSize >= 0) {
            if (auto *sizeItem = m_table->item(row, ColSize)) {
                sizeItem->setText(humanSize(finalSize));
                sizeItem->setForeground(valueTextColor());
            }
        }
    }
    if (auto *pc = m_table->cellWidget(row, ColProgress)) {
        if (auto *bar = pc->findChild<motion::ThemedBar*>(QStringLiteral("p_bar"))) {
            bar->setRange(0, 100);
            bar->setValue(100);
        }
        if (auto *pct = pc->findChild<QLabel*>(QStringLiteral("p_pct")))
            pct->setText(QStringLiteral("100%"));
    }
    if (auto *speedItem = m_table->item(row, ColSpeed)) {
        speedItem->setText(QStringLiteral("—"));
        speedItem->setForeground(mutedTextColor());
    }
    updateStats();
    // On completion, auto-close the per-download details plate and show the
    // IDM-style completion prompt (Open / Open folder / Close) instead. Only on
    // the FIRST finish (see firstFinish), so it never double-pops. Skipped for the
    // startup restore replay and for multi-video playlist jobs.
    if (firstFinish && VirusScanner::enabled() && !m_engine->isPlaylist(id)) {
        const QString path = m_engine->savePathOf(id);
        if (!path.isEmpty() && QFileInfo::exists(path))
            m_scanner->scan(id, path);
    }
    if (firstFinish)
        QTimer::singleShot(800, this, &MainWindow::maybeRunWhenDone);
    if (firstFinish && id == m_pendingUpdateTask) {
        QTimer::singleShot(0, this, [this, id]() { offerInstallUpdate(id); });
        return;
    }
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
    m_footerLeft->setToolTip(tr("Renamed to %1").arg(newName));
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
