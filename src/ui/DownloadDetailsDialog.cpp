#include "ui/DownloadDetailsDialog.h"
#include "ui/UiHelpers.h"
#include "core/DownloadEngine.h"
#include "core/DownloadTask.h"

#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QGridLayout>
#include <QLabel>
#include <QProgressBar>
#include <QPushButton>
#include <QTableWidget>
#include <QHeaderView>
#include <QTimer>
#include <QMessageBox>
#include <QFontMetrics>
#include <QPainter>
#include <QPainterPath>
#include <QPaintEvent>
#include <QIcon>
#include <QVector>
#include <QImage>
#include <QRandomGenerator>
#include <QtGlobal>
#include <cmath>

namespace nexa {

// Anything at or above this byte position is the "unbounded size unknown"
// sentinel DownloadTask uses (qint64(1) << 62) for a single non-range segment.
static const qint64 kUnbounded = qint64(1) << 61;

// ---------------------------------------------------------------------------
// ConnStrip — the "start positions and download progress by connections" rail.
// ---------------------------------------------------------------------------
class ConnStrip : public QWidget {
public:
    explicit ConnStrip(QWidget *parent = nullptr) : QWidget(parent) {}

    void setData(const QVector<SegmentInfo> &segs, qint64 total,
                 const QColor &accent, int phase)
    {
        m_segs = segs; m_total = total; m_accent = accent; m_phase = phase;
        update();
    }

protected:
    void paintEvent(QPaintEvent *) override
    {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing, true);
        const QRectF r = QRectF(rect()).adjusted(0.5, 0.5, -0.5, -0.5);
        const double R = 4.0;

        QPainterPath track;
        track.addRoundedRect(r, R, R);
        p.fillPath(track, QColor(0x1a2133));   // rail track
        p.setClipPath(track);                  // round the fill ends

        const double W = r.width();
        const bool single = m_segs.size() <= 1;
        const bool unbounded = single &&
            (m_total <= 0 || (m_segs.size() == 1 && m_segs[0].end >= kUnbounded));

        // Single rail (1 connection / no ranges / fallback for non-HTTP jobs).
        if (m_segs.isEmpty() || unbounded) {
            if (m_total > 0) {
                const qint64 done = m_segs.isEmpty() ? 0 : m_segs[0].done;
                double frac = qBound(0.0, double(done) / double(m_total), 1.0);
                p.fillRect(QRectF(r.left(), r.top(), W * frac, r.height()), m_accent);
            } else {
                // Unknown total -> moving indeterminate band.
                const double bandW = W * 0.28;
                const double x = r.left() + (double(m_phase % 100) / 100.0) * (W + bandW) - bandW;
                p.fillRect(QRectF(x, r.top(), bandW, r.height()), m_accent);
            }
            return;
        }

        // Multi-segment: map each byte range to its slice of the rail.
        const double axis = m_total > 0 ? double(m_total) : 1.0;
        for (const SegmentInfo &s : m_segs) {
            const double x0   = r.left() + W * (double(s.start) / axis);
            const double segW = W * (double(s.length()) / axis);
            if (s.index > 0)   // start-position tick (skip the first, at the edge)
                p.fillRect(QRectF(x0, r.top(), 1.0, r.height()), QColor(0x2d3650));
            const double frac = s.length() > 0
                ? qBound(0.0, double(s.done) / double(s.length()), 1.0) : 0.0;
            const QColor c = (s.done == 0)            ? QColor(0x38bdf8)   // connecting
                           : (s.done >= s.length())   ? QColor(0x22c55e)   // completed
                                                      : m_accent;          // receiving
            p.fillRect(QRectF(x0, r.top(), segW * frac, r.height()), c);
        }
    }

private:
    QVector<SegmentInfo> m_segs;
    qint64 m_total = -1;
    QColor m_accent = QColor(0x8b5cf6);
    int    m_phase = 0;
};

namespace {
enum ConnCol { CN = 0, CDownloaded, CInfo };
}

// ---------------------------------------------------------------------------
// FireBar — a cellular automaton fire animation used as the overall progress bar.
// The "fuel" line is set to the progress fraction and heat rises upward with
// random flicker, painted through a fire colour palette.
// ---------------------------------------------------------------------------
class FireBar : public QWidget {
public:
    explicit FireBar(QWidget *parent = nullptr) : QWidget(parent)
    {
        setFixedHeight(40);
        m_animTimer = new QTimer(this);
        m_animTimer->setInterval(40);   // ~25 fps
        connect(m_animTimer, &QTimer::timeout, this, [this]{ tick(); update(); });
    }

    void setValue(int pct)       { m_pct = qBound(0, pct, 100); }
    void setIndeterminate(bool b){ m_indet = b; }
    void setAccent(const QColor &c){ m_accent = c; }

    void startAnim() { if (!m_animTimer->isActive()) m_animTimer->start(); }
    void stopAnim()  { m_animTimer->stop(); update(); }

protected:
    void resizeEvent(QResizeEvent *) override { rebuildField(); }

    void paintEvent(QPaintEvent *) override
    {
        QPainter p(this);
        p.setRenderHint(QPainter::SmoothPixmapTransform);

        // Draw the heat field as a colour-mapped image.
        if (!m_field.empty() && m_W > 0 && m_H > 0) {
            QImage img(m_W, m_H, QImage::Format_RGB32);
            for (int y = 0; y < m_H; ++y)
                for (int x = 0; x < m_W; ++x)
                    img.setPixel(x, y, fireColor(m_field[y * m_W + x]));
            p.drawImage(rect(), img);
        } else {
            // No field yet — plain dark rect.
            p.fillRect(rect(), QColor(0x1a2133));
        }

        // Percentage text centred on top.
        if (!m_indet) {
            const QString txt = QStringLiteral("%1%").arg(m_pct);
            p.setPen(Qt::white);
            QFont f = p.font(); f.setBold(true); f.setPointSize(11); p.setFont(f);
            p.drawText(rect(), Qt::AlignCenter, txt);
        }
    }

private:
    // Classic fire cellular automaton fire color palette.
    static QRgb fireColor(int heat)
    {
        heat = qBound(0, heat, 255);
        if (heat < 64)  return qRgb(0, 0, 0);
        if (heat < 96)  return qRgb(heat * 2, 0, 0);
        if (heat < 128) return qRgb(255, (heat - 96) * 4, 0);
        if (heat < 192) return qRgb(255, (heat - 128) * 4, 0);
        return qRgb(255, 255, (heat - 192) * 4);
    }

    void rebuildField()
    {
        m_W = qMax(1, width());
        m_H = qMax(1, height());
        m_field.assign(m_W * m_H, 0);
    }

    void tick()
    {
        if (m_W <= 0 || m_H <= 0) return;

        // Bottom row = fuel: heat proportional to progress (or scrolling if indeterminate).
        for (int x = 0; x < m_W; ++x) {
            int fuel;
            if (m_indet) {
                // Moving wave for unknown size.
                const double phase = (m_idPhase / 40.0) * 2.0 * M_PI;
                fuel = int(128 + 100 * std::sin(phase + x * 0.15));
            } else {
                const int fill = (m_pct * m_W) / 100;
                fuel = (x < fill) ? (180 + QRandomGenerator::global()->bounded(75)) : 0;
            }
            m_field[(m_H - 1) * m_W + x] = qBound(0, fuel, 255);
        }
        ++m_idPhase;

        // Propagate heat upward with cooling + random flicker.
        for (int y = 0; y < m_H - 1; ++y) {
            for (int x = 0; x < m_W; ++x) {
                const int xl = qMax(x - 1, 0), xr = qMin(x + 1, m_W - 1);
                int v = (m_field[(y + 1) * m_W + xl] +
                         m_field[(y + 1) * m_W + x]  +
                         m_field[(y + 1) * m_W + xr]  +
                         m_field[qMin(y + 2, m_H - 1) * m_W + x]) / 4;
                v -= QRandomGenerator::global()->bounded(18);
                m_field[y * m_W + x] = qBound(0, v, 255);
            }
        }
    }

    int    m_pct   = 0;
    bool   m_indet = false;
    int    m_idPhase = 0;
    QColor m_accent{0x8b5cf6};
    int    m_W = 0, m_H = 0;
    std::vector<int> m_field;
    QTimer *m_animTimer = nullptr;
};

// ---------------------------------------------------------------------------
// SpeedMeter — a circular gauge (speedometer) widget.
// Arc background, coloured fill, animated needle, digital readout in centre.
// ---------------------------------------------------------------------------
class SpeedMeter : public QWidget {
public:
    explicit SpeedMeter(QWidget *parent = nullptr) : QWidget(parent)
    {
        setFixedSize(140, 140);
        m_animTimer = new QTimer(this);
        m_animTimer->setInterval(40);
        connect(m_animTimer, &QTimer::timeout, this, [this]{
            // Smooth the needle toward the target.
            const double delta = m_targetAngle - m_currentAngle;
            m_currentAngle += delta * 0.18;
            update();
        });
        m_animTimer->start();
    }

    // bps in bytes per second.
    void setSpeed(double bps)
    {
        m_bps = bps;
        // Autoscale the max: grow when needed, shrink slowly.
        if (bps > m_maxBps * 0.9)
            m_maxBps = bps * 1.4;
        else if (bps < m_maxBps * 0.3 && m_maxBps > 1024.0 * 1024.0)
            m_maxBps *= 0.97;
        const double frac = (m_maxBps > 0) ? qBound(0.0, bps / m_maxBps, 1.0) : 0.0;
        m_targetAngle = kStartAngle + frac * kSweep;
    }

protected:
    void paintEvent(QPaintEvent *) override
    {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        const QRectF r = QRectF(rect()).adjusted(8, 8, -8, -8);

        // Track arc (dark).
        p.setPen(QPen(QColor(0x1a2133), 10, Qt::SolidLine, Qt::FlatCap));
        p.drawArc(r, int(-kStartAngle * 16), int(-kSweep * 16));

        // Filled arc — colour shifts green → yellow → red with speed.
        const double frac = (m_maxBps > 0) ? qBound(0.0, m_bps / m_maxBps, 1.0) : 0.0;
        const double filled = frac * kSweep;
        if (filled > 0.5) {
            const int r1 = int(frac < 0.5 ? 2 * frac * 255 : 255);
            const int g1 = int(frac < 0.5 ? 255 : 2 * (1.0 - frac) * 255);
            p.setPen(QPen(QColor(r1, g1, 60), 10, Qt::SolidLine, Qt::FlatCap));
            p.drawArc(r, int(-kStartAngle * 16), int(-filled * 16));
        }

        // Needle.
        const double angle = (m_currentAngle) * M_PI / 180.0;
        const QPointF centre = r.center();
        const double len = r.width() / 2.0 - 8;
        const QPointF tip(centre.x() - len * std::cos(angle),
                          centre.y() - len * std::sin(angle));
        p.setPen(QPen(QColor(0xff6b35), 2.5, Qt::SolidLine, Qt::RoundCap));
        p.drawLine(centre, tip);

        // Centre hub.
        p.setBrush(QColor(0xff6b35)); p.setPen(Qt::NoPen);
        p.drawEllipse(centre, 5.0, 5.0);

        // Digital speed readout.
        QString spd, unit;
        if (m_bps >= 1024.0 * 1024.0)      { spd = QString::number(m_bps / (1024*1024), 'f', 1); unit = "MB/s"; }
        else if (m_bps >= 1024.0)           { spd = QString::number(m_bps / 1024.0,      'f', 1); unit = "KB/s"; }
        else if (m_bps > 0)                 { spd = QString::number(int(m_bps));            unit = "B/s"; }
        else                                { spd = "0";                                     unit = "KB/s"; }

        p.setPen(Qt::white);
        QFont bf = p.font(); bf.setBold(true); bf.setPointSize(11); p.setFont(bf);
        const QRectF topHalf(r.left(), centre.y() - 22, r.width(), 22);
        p.drawText(topHalf, Qt::AlignCenter | Qt::AlignBottom, spd);
        QFont sf = p.font(); sf.setBold(false); sf.setPointSize(8); p.setFont(sf);
        p.setPen(QColor(0x94a3b8));
        const QRectF botHalf(r.left(), centre.y() + 2, r.width(), 18);
        p.drawText(botHalf, Qt::AlignCenter | Qt::AlignTop, unit);
    }

private:
    static constexpr double kStartAngle = 220.0;   // degrees from east, clockwise
    static constexpr double kSweep      = 260.0;   // total arc

    double m_bps         = 0.0;
    double m_maxBps      = 4.0 * 1024 * 1024;   // initial max: 4 MB/s
    double m_targetAngle = kStartAngle;
    double m_currentAngle= kStartAngle;
    QTimer *m_animTimer  = nullptr;
};

// ---------------------------------------------------------------------------
// DownloadDetailsDialog
// ---------------------------------------------------------------------------
DownloadDetailsDialog::DownloadDetailsDialog(DownloadEngine *engine, int id, QWidget *parent)
    : QDialog(parent), m_engine(engine), m_id(id)
{
    setAttribute(Qt::WA_DeleteOnClose);
    setWindowIcon(QIcon(QStringLiteral(":/nexa.png")));
    resize(560, 600);
    setMinimumSize(480, 560);

    // Seed from the engine's current view so an already-running download paints
    // immediately when opened by double-click.
    for (const auto &s : m_engine->snapshot()) {
        if (s.id == m_id) { m_done = s.done; m_total = s.total; m_bps = s.speed; break; }
    }
    m_state = m_engine->stateOf(m_id);
    if (auto *t = m_engine->task(m_id)) m_url = t->url().toString();
    else m_url = m_engine->hostOf(m_id);

    buildUi();

    connect(m_engine, &DownloadEngine::taskProgress,     this, &DownloadDetailsDialog::onProgress);
    connect(m_engine, &DownloadEngine::taskStateChanged, this, &DownloadDetailsDialog::onStateChanged);
    connect(m_engine, &DownloadEngine::taskRenamed,      this, &DownloadDetailsDialog::onRenamed);
    connect(m_engine, &DownloadEngine::taskRemoved,      this, &DownloadDetailsDialog::onRemoved);

    refreshHeader();
    refreshFields();
    refreshOverallBar();
    refreshConnections();
    updateButtons();
    syncTimer();
}

void DownloadDetailsDialog::buildUi()
{
    auto *outer = new QVBoxLayout(this);
    outer->setContentsMargins(14, 14, 14, 14);

    auto *plate = new QWidget(this);
    plate->setObjectName(QStringLiteral("Plate"));
    outer->addWidget(plate);

    auto *v = new QVBoxLayout(plate);
    v->setContentsMargins(18, 16, 18, 16);
    v->setSpacing(14);

    // --- Header: tile + title/host, state pill on the right ---
    auto *head = new QHBoxLayout;
    head->setSpacing(11);
    m_tile = new QLabel(plate);
    m_tile->setObjectName(QStringLiteral("Dd_tile"));
    m_tile->setFixedSize(44, 44);
    m_tile->setAlignment(Qt::AlignCenter);
    auto *titles = new QVBoxLayout;
    titles->setSpacing(2);
    m_title = new QLabel(plate); m_title->setObjectName(QStringLiteral("Dd_title"));
    m_host  = new QLabel(plate); m_host->setObjectName(QStringLiteral("Dd_host"));
    titles->addWidget(m_title);
    titles->addWidget(m_host);
    m_pill = new QLabel(plate); m_pill->setObjectName(QStringLiteral("Dd_pill"));
    m_pill->setAlignment(Qt::AlignCenter);
    head->addWidget(m_tile);
    head->addLayout(titles);
    head->addStretch(1);
    head->addWidget(m_pill, 0, Qt::AlignTop);
    v->addLayout(head);

    // --- Field grid ---
    auto *grid = new QGridLayout;
    grid->setHorizontalSpacing(16);
    grid->setVerticalSpacing(8);
    grid->setColumnStretch(1, 1);
    auto addField = [&](int row, const QString &name) -> QLabel * {
        auto *l = new QLabel(name, plate);
        l->setProperty("ddRole", "label");
        l->setAlignment(Qt::AlignRight | Qt::AlignVCenter);
        auto *val = new QLabel(plate);
        val->setProperty("ddRole", "value");
        grid->addWidget(l,   row, 0);
        grid->addWidget(val, row, 1);
        return val;
    };
    m_vUrl    = addField(0, QStringLiteral("URL"));
    m_vUrl->setTextInteractionFlags(Qt::TextSelectableByMouse);
    m_vStatus = addField(1, QStringLiteral("Status"));
    m_vSize   = addField(2, QStringLiteral("File size"));
    m_vDone   = addField(3, QStringLiteral("Downloaded"));
    m_vRate   = addField(4, QStringLiteral("Transfer rate"));
    m_vEta    = addField(5, QStringLiteral("Time left"));
    m_vResume = addField(6, QStringLiteral("Resume capability"));
    v->addLayout(grid);

    // --- Fire progress bar + speed meter side by side ---
    auto *barRow = new QHBoxLayout;
    barRow->setSpacing(12);

    auto *barCol = new QVBoxLayout;
    barCol->setSpacing(4);
    m_bar = new FireBar(plate);
    m_barPct = new QLabel(QStringLiteral("0%"), plate);
    m_barPct->setObjectName(QStringLiteral("Dd_barpct"));
    m_barPct->setAlignment(Qt::AlignRight);
    // The percent is overlaid ON the FireBar (it draws it itself); hide the label.
    m_barPct->setVisible(false);
    barCol->addWidget(m_bar);
    barRow->addLayout(barCol, 1);

    m_speedMeter = new SpeedMeter(plate);
    barRow->addWidget(m_speedMeter, 0, Qt::AlignVCenter);
    v->addLayout(barRow);

    // --- Connections strip ---
    auto *secRow = new QHBoxLayout;
    auto *sec = new QLabel(QStringLiteral("Start positions and download progress by connections"), plate);
    sec->setObjectName(QStringLiteral("Dd_seclabel"));
    m_connCount = new QLabel(plate);
    m_connCount->setObjectName(QStringLiteral("Dd_seclabel"));
    m_connCount->setAlignment(Qt::AlignRight);
    secRow->addWidget(sec);
    secRow->addStretch(1);
    secRow->addWidget(m_connCount);
    v->addLayout(secRow);

    m_strip = new ConnStrip(plate);
    m_strip->setFixedHeight(26);
    v->addWidget(m_strip);

    // --- Connection table ---
    m_table = new QTableWidget(0, 3, plate);
    m_table->setObjectName(QStringLiteral("Dd_table"));
    m_table->setHorizontalHeaderLabels({QStringLiteral("N."), QStringLiteral("Downloaded"),
                                        QStringLiteral("Info")});
    m_table->verticalHeader()->setVisible(false);
    m_table->setShowGrid(false);
    m_table->setSelectionMode(QAbstractItemView::NoSelection);
    m_table->setFocusPolicy(Qt::NoFocus);
    m_table->setEditTriggers(QAbstractItemView::NoEditTriggers);
    m_table->horizontalHeader()->setSectionResizeMode(CN, QHeaderView::Fixed);
    m_table->horizontalHeader()->setSectionResizeMode(CDownloaded, QHeaderView::Fixed);
    m_table->horizontalHeader()->setSectionResizeMode(CInfo, QHeaderView::Stretch);
    m_table->setColumnWidth(CN, 44);
    m_table->setColumnWidth(CDownloaded, 150);
    m_table->verticalHeader()->setDefaultSectionSize(30);
    v->addWidget(m_table, 1);

    // --- Buttons ---
    auto *btns = new QHBoxLayout;
    m_pause  = new QPushButton(QString::fromUtf8("❚❚  Pause"), plate);
    m_resume = new QPushButton(QString::fromUtf8("▷  Resume"), plate);
    m_cancel = new QPushButton(QString::fromUtf8("✕  Cancel"), plate);
    m_cancel->setObjectName(QStringLiteral("DdCancel"));
    for (auto *b : {m_pause, m_resume, m_cancel}) b->setCursor(Qt::PointingHandCursor);
    btns->addWidget(m_pause);
    btns->addWidget(m_resume);
    btns->addStretch(1);
    btns->addWidget(m_cancel);
    v->addLayout(btns);

    connect(m_pause,  &QPushButton::clicked, this, [this]{ m_engine->pause(m_id); });
    connect(m_resume, &QPushButton::clicked, this, [this]{ m_engine->resume(m_id); });
    connect(m_cancel, &QPushButton::clicked, this, [this] {
        if (QMessageBox::question(this, QStringLiteral("Cancel Download"),
                                  QStringLiteral("Remove this download from the list?\n"
                                                 "(The partially downloaded file is kept.)"))
            == QMessageBox::Yes) {
            m_engine->remove(m_id, false);   // taskRemoved closes this dialog
        }
    });

    m_tick = new QTimer(this);
    m_tick->setInterval(500);
    connect(m_tick, &QTimer::timeout, this, &DownloadDetailsDialog::onTick);
}

bool DownloadDetailsDialog::isSegmented() const
{
    auto *t = m_engine->task(m_id);
    return t && t->rangesSupported() && t->segments().size() > 1;
}

void DownloadDetailsDialog::syncTimer()
{
    const bool active = (m_state == DownloadState::Downloading ||
                         m_state == DownloadState::Probing);
    if (isSegmented() && active) {
        if (!m_tick->isActive()) m_tick->start();
    } else {
        m_tick->stop();
    }
}

// --- refreshers -----------------------------------------------------------

void DownloadDetailsDialog::refreshHeader()
{
    const QString name = m_engine->nameOf(m_id);
    paintIcon(m_tile, name);
    const QFontMetrics fm(m_title->font());
    m_title->setText(fm.elidedText(name, Qt::ElideMiddle, 330));
    m_title->setToolTip(name);
    m_host->setText(m_engine->hostOf(m_id));

    const QColor c = statusColor(m_state);
    m_pill->setText(QStringLiteral("● %1").arg(statusLabel(m_state)));
    m_pill->setStyleSheet(QStringLiteral(
        "color:%1; border:1px solid rgba(%2,%3,%4,115); background:rgba(%2,%3,%4,30); "
        "border-radius:11px; padding:3px 11px; font-size:11px; font-weight:600;")
        .arg(c.name()).arg(c.red()).arg(c.green()).arg(c.blue()));

    const int pct = (m_total > 0) ? int(m_done * 100 / m_total) : -1;
    setWindowTitle(pct >= 0 ? QStringLiteral("%1%  %2").arg(pct).arg(name)
                            : QStringLiteral("%1").arg(name));
}

void DownloadDetailsDialog::refreshFields()
{
    // Recompute the source each refresh: a torrent's source ("peer swarm")
    // isn't known until it registers, after this dialog first opened.
    if (auto *t = m_engine->task(m_id)) m_url = t->url().toString();
    else                                m_url = m_engine->hostOf(m_id);

    const QFontMetrics fm(m_vUrl->font());
    m_vUrl->setText(fm.elidedText(m_url, Qt::ElideMiddle, 360));
    m_vUrl->setToolTip(m_url);

    m_vStatus->setText(m_detail.isEmpty() ? statusLabel(m_state) : m_detail);
    m_vSize->setText(m_total > 0 ? humanSize(m_total) : QStringLiteral("Unknown"));

    if (m_total > 0)
        m_vDone->setText(QStringLiteral("%1  (%2%)")
                             .arg(humanSize(m_done)).arg(int(m_done * 100 / m_total)));
    else
        m_vDone->setText(humanSize(m_done));

    const QString rate = humanSpeed(m_bps);
    m_vRate->setText(rate.isEmpty() ? QStringLiteral("—") : rate);

    m_vEta->setText((m_total > 0 && m_bps > 1.0)
        ? humanTime(qint64((m_total - m_done) / m_bps))
        : QStringLiteral("—"));

    // Resume capability: known only for HTTP DownloadTasks (after probe).
    if (auto *t = m_engine->task(m_id)) {
        const bool yes = t->rangesSupported();
        m_vResume->setText(yes ? QStringLiteral("Yes") : QStringLiteral("No"));
        m_vResume->setStyleSheet(yes ? QStringLiteral("color:#22c55e;")
                                     : QStringLiteral("color:#ef4444;"));
    } else {
        m_vResume->setText(QStringLiteral("Unknown"));
        m_vResume->setStyleSheet(QStringLiteral("color:#8b94a7;"));
    }
}

void DownloadDetailsDialog::refreshOverallBar()
{
    const bool active = (m_state == DownloadState::Downloading ||
                         m_state == DownloadState::Probing);
    m_bar->setAccent(statusColor(m_state));

    if (m_state == DownloadState::Completed) {
        m_bar->setValue(100);
        m_bar->setIndeterminate(false);
        m_bar->stopAnim();
        // Show a brief final flash then freeze.
        m_bar->update();
    } else if (m_total > 0) {
        const int p = int(m_done * 100 / m_total);
        m_bar->setValue(p);
        m_bar->setIndeterminate(false);
        if (active) m_bar->startAnim(); else m_bar->stopAnim();
    } else {
        m_bar->setIndeterminate(active);
        m_bar->setValue(0);
        if (active) m_bar->startAnim(); else m_bar->stopAnim();
    }
}

void DownloadDetailsDialog::refreshConnections()
{
    auto *t = m_engine->task(m_id);

    if (isSegmented()) {
        const QVector<SegmentInfo> segs = t->segments();
        m_strip->setData(segs, t->totalBytes(), statusColor(m_state), m_phase);

        m_table->setVisible(true);
        if (m_table->rowCount() != segs.size())
            m_table->setRowCount(segs.size());
        for (int i = 0; i < segs.size(); ++i) {
            const SegmentInfo &s = segs.at(i);
            QString info; DownloadState segState;
            if (m_state == DownloadState::Completed) {
                info = QStringLiteral("Completed");           segState = DownloadState::Completed;
            } else if (s.done == 0) {
                info = QStringLiteral("Connecting");          segState = DownloadState::Probing;
            } else if (s.done >= s.length()) {
                info = QStringLiteral("Completed");           segState = DownloadState::Completed;
            } else {
                info = QStringLiteral("Receiving data…");     segState = DownloadState::Downloading;
            }
            auto setCell = [&](int col, const QString &text, const QColor &fg) {
                QTableWidgetItem *it = m_table->item(i, col);
                if (!it) { it = new QTableWidgetItem; m_table->setItem(i, col, it); }
                it->setText(text);
                it->setForeground(fg);
            };
            setCell(CN,          QString::number(s.index + 1), QColor(0x8b94a7));
            setCell(CDownloaded, humanSize(s.done),            QColor(0xc7cedb));
            setCell(CInfo,       info,                         statusColor(segState));
        }
        const int n = segs.size();
        m_connCount->setText(QStringLiteral("%1 connections").arg(n));
        return;
    }

    // Fallback: single aggregate rail; no per-connection table.
    m_table->setVisible(false);
    SegmentInfo s;
    s.index = 0; s.start = 0;
    s.end  = (m_total > 0) ? (m_total - 1) : (qint64(1) << 62);
    s.done = m_done;
    m_strip->setData(QVector<SegmentInfo>{s}, m_total, statusColor(m_state), m_phase);

    if (t) {
        const int n = t->segments().size();
        m_connCount->setText(n > 0 ? QStringLiteral("%1 connection%2").arg(n).arg(n == 1 ? "" : "s")
                                   : m_detail);
    } else {
        m_connCount->setText(m_detail);   // carries "N connections / fragment i/n / peers"
    }
}

void DownloadDetailsDialog::updateButtons()
{
    const bool active = (m_state == DownloadState::Downloading ||
                         m_state == DownloadState::Probing ||
                         m_state == DownloadState::Queued);
    const bool paused = (m_state == DownloadState::Paused);
    const bool errored = (m_state == DownloadState::Error);
    m_pause->setEnabled(active);
    m_resume->setEnabled(paused || errored);
    m_cancel->setEnabled(true);
}

// --- slots ----------------------------------------------------------------

void DownloadDetailsDialog::onProgress(int id, qint64 done, qint64 total, double bps)
{
    if (id != m_id) return;
    m_done = done; m_total = total; m_bps = bps;
    ++m_phase;                       // keeps the indeterminate rail moving
    m_speedMeter->setSpeed(bps);
    refreshHeader();
    refreshFields();
    refreshOverallBar();
    refreshConnections();
}

void DownloadDetailsDialog::onStateChanged(int id, DownloadState state, const QString &detail)
{
    if (id != m_id) return;
    m_state = state;
    m_detail = detail;
    // Needle falls to zero when not actively downloading.
    if (state != DownloadState::Downloading && state != DownloadState::Probing)
        m_speedMeter->setSpeed(0.0);
    refreshHeader();
    refreshFields();
    refreshOverallBar();
    refreshConnections();
    updateButtons();
    syncTimer();
}

void DownloadDetailsDialog::onRenamed(int id, const QString &)
{
    if (id != m_id) return;
    refreshHeader();
}

void DownloadDetailsDialog::onRemoved(int id)
{
    if (id != m_id) return;
    m_tick->stop();
    close();                         // WA_DeleteOnClose frees us
}

void DownloadDetailsDialog::onTick()
{
    if (!m_engine->task(m_id)) { m_tick->stop(); return; }
    ++m_phase;
    refreshConnections();
    refreshFields();                 // live ETA between progress signals
}

} // namespace nexa
