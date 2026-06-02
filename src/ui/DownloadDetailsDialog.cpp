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
// FireBar — clean solid fill behind the progress head; fire CA burns ONLY at
// the leading edge (tip). The head moves forward as % increases.
// ---------------------------------------------------------------------------
class FireBar : public QWidget {
public:
    explicit FireBar(QWidget *parent = nullptr) : QWidget(parent)
    {
        setFixedHeight(52);
        m_animTimer = new QTimer(this);
        m_animTimer->setInterval(40);
        connect(m_animTimer, &QTimer::timeout, this, [this]{ step(); update(); });
    }

    void setValue(int pct)          { m_pct = qBound(0, pct, 100); }
    void setIndeterminate(bool b)   { m_indet = b; }
    void setAccent(const QColor &c) { m_accent = c; }
    void startAnim() { if (!m_animTimer->isActive()) m_animTimer->start(); }
    void stopAnim()  { m_animTimer->stop(); update(); }

protected:
    void resizeEvent(QResizeEvent *) override { rebuild(); }

    void paintEvent(QPaintEvent *) override
    {
        QPainter p(this);
        const int W = width(), H = height();
        const int fillX = m_indet ? m_idHead : (m_pct * W / 100);

        // 1. Dark track.
        p.fillRect(rect(), QColor(0x111827));

        // 2. Solid gradient fill behind the head (clean, no fire here).
        if (fillX > 1) {
            QLinearGradient g(0, 0, fillX, 0);
            g.setColorAt(0.0, m_accent.darker(240));
            g.setColorAt(0.6, m_accent.darker(130));
            g.setColorAt(1.0, m_accent);
            p.fillRect(QRect(0, 0, fillX, H), g);
            // Subtle inner top-edge highlight.
            p.fillRect(QRect(0, 0, fillX, 2), QColor(255, 255, 255, 28));
        }

        // 3. Fire CA — heat only near the head, so the CA naturally produces
        //    fire only at the tip; the rest of the image is transparent.
        if (!m_field.empty() && m_W > 0 && m_H > 0) {
            QImage img(m_W, m_H, QImage::Format_ARGB32_Premultiplied);
            img.fill(Qt::transparent);
            for (int y = 0; y < m_H; ++y) {
                for (int x = 0; x < m_W; ++x) {
                    const int h = m_field[y * m_W + x];
                    if (h > 8) {
                        const QRgb c = fireColor(h);
                        const int a = qMin(255, h * 2);
                        // premultiplied ARGB
                        const int ra = qRed(c)*a/255, ga = qGreen(c)*a/255, ba = qBlue(c)*a/255;
                        reinterpret_cast<QRgb*>(img.scanLine(y))[x] = qRgba(ra, ga, ba, a);
                    }
                }
            }
            p.drawImage(0, 0, img);
        }

        // 4. Percentage text — white, centred.
        p.setPen(Qt::white);
        QFont f = p.font(); f.setBold(true); f.setPointSize(11); p.setFont(f);
        p.drawText(rect(), Qt::AlignCenter,
                   m_indet ? QString() : QStringLiteral("%1%").arg(m_pct));
    }

private:
    static QRgb fireColor(int h)
    {
        h = qBound(0, h, 255);
        if (h < 48)  return qRgb(0,           0,            0);
        if (h < 90)  return qRgb(h * 2,        0,            0);
        if (h < 130) return qRgb(255,          (h-90)*5,     0);
        if (h < 190) return qRgb(255,           130+(h-130)*2, 0);
        return             qRgb(255,           255,          (h-190)*5);
    }

    void rebuild()
    {
        m_W = qMax(1, width());
        m_H = qMax(1, height());
        m_field.assign(size_t(m_W) * m_H, 0);
    }

    void step()
    {
        if (m_W <= 0 || m_H <= 0) return;
        const int headX = m_indet ? m_idHead : (m_pct * m_W / 100);
        if (m_indet) m_idHead = (m_idHead + 2) % m_W;

        // Heat source: ONLY near the head (±16 px). Hottest at the tip.
        for (int x = 0; x < m_W; ++x) {
            const int dist = qAbs(x - headX);
            const int fuel = (dist < 18)
                ? qBound(0, 210 + QRandomGenerator::global()->bounded(45) - dist * 10, 255)
                : 0;
            m_field[(m_H - 1) * m_W + x] = fuel;
        }

        // Propagate heat upward with cooling + random flicker.
        for (int y = 0; y < m_H - 1; ++y) {
            for (int x = 0; x < m_W; ++x) {
                const int xl = qMax(x-1, 0), xr = qMin(x+1, m_W-1);
                int v = (m_field[(y+1)*m_W + xl] + m_field[(y+1)*m_W + x] +
                         m_field[(y+1)*m_W + xr]  + m_field[qMin(y+2,m_H-1)*m_W + x]) / 4;
                v -= QRandomGenerator::global()->bounded(20);
                m_field[y * m_W + x] = qBound(0, v, 255);
            }
        }
    }

    int    m_pct    = 0;
    bool   m_indet  = false;
    int    m_idHead = 0;
    QColor m_accent {0x8b5cf6};
    int    m_W = 0, m_H = 0;
    std::vector<int> m_field;
    QTimer *m_animTimer = nullptr;
};

// ---------------------------------------------------------------------------
// SpeedMeter — professional circular speedometer gauge.
// Bezel ring, dark face, coloured arc, tick marks, animated needle with glow,
// metallic hub, digital readout. All painted with QPainter.
// ---------------------------------------------------------------------------
class SpeedMeter : public QWidget {
public:
    explicit SpeedMeter(QWidget *parent = nullptr) : QWidget(parent)
    {
        setFixedSize(180, 180);
        m_animTimer = new QTimer(this);
        m_animTimer->setInterval(30);   // ~33 fps
        connect(m_animTimer, &QTimer::timeout, this, [this]{
            m_curFrac += (m_targetFrac - m_curFrac) * 0.15;
            update();
        });
        m_animTimer->start();
    }

    void setSpeed(double bps)
    {
        m_bps = bps;
        if (bps > m_maxBps * 0.85)                              m_maxBps = bps * 1.5;
        else if (bps < m_maxBps * 0.25 && m_maxBps > 512*1024.0) m_maxBps *= 0.985;
        m_targetFrac = (m_maxBps > 0) ? qBound(0.0, bps / m_maxBps, 1.0) : 0.0;
    }

protected:
    void paintEvent(QPaintEvent *) override
    {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);

        const QPointF C(width() * 0.5, height() * 0.5);
        const double R = qMin(width(), height()) * 0.5 - 3.0;

        // ── Outer bezel ring ──────────────────────────────────────────────
        {
            QRadialGradient g(C, R);
            g.setColorAt(0.76, QColor(0x1e293b));
            g.setColorAt(0.84, QColor(0x334155));
            g.setColorAt(0.90, QColor(0x475569));
            g.setColorAt(0.95, QColor(0x334155));
            g.setColorAt(1.00, QColor(0x0f172a));
            p.setBrush(g); p.setPen(Qt::NoPen);
            p.drawEllipse(C, R, R);
        }

        // ── Inner dark face ───────────────────────────────────────────────
        const double faceR = R * 0.80;
        {
            QRadialGradient g(C, faceR);
            g.setColorAt(0.0, QColor(0x1e2940));
            g.setColorAt(0.65, QColor(0x0f172a));
            g.setColorAt(1.0,  QColor(0x080c14));
            p.setBrush(g); p.setPen(Qt::NoPen);
            p.drawEllipse(C, faceR, faceR);
        }

        // ── Arc geometry (gauge: 225° → 270° CW sweep) ───────────────────
        // Angles: 225° CCW from east = lower-left. Needle sweeps CW 270°.
        // Qt drawArc: startAngle in 1/16°, positive = CCW. Span negative = CW.
        const double arcR = R * 0.68;
        const QRectF arcRect(C.x()-arcR, C.y()-arcR, arcR*2, arcR*2);

        // Track arc
        p.setPen(QPen(QColor(0x1a2437), 8, Qt::SolidLine, Qt::FlatCap));
        p.setBrush(Qt::NoBrush);
        p.drawArc(arcRect, 225*16, -270*16);

        // Coloured fill arc (conical gradient: green → amber → red)
        if (m_curFrac > 0.002) {
            QConicalGradient cg(C, 225.0);
            cg.setColorAt(0.000, QColor(0x22c55e));
            cg.setColorAt(0.375, QColor(0xfbbf24));
            cg.setColorAt(0.750, QColor(0xef4444));
            cg.setColorAt(1.000, QColor(0xef4444));
            p.setPen(QPen(QBrush(cg), 8, Qt::SolidLine, Qt::FlatCap));
            p.drawArc(arcRect, 225*16, int(-m_curFrac * 270.0 * 16));

            // Glow blob at arc tip
            const double tipAng = (225.0 - m_curFrac * 270.0) * M_PI / 180.0;
            const QPointF tip(C.x() + arcR * std::cos(tipAng),
                              C.y() - arcR * std::sin(tipAng));
            const QColor gc = (m_curFrac < 0.5) ? QColor(0x22c55e)
                            : (m_curFrac < 0.75) ? QColor(0xfbbf24)
                                                 : QColor(0xef4444);
            QRadialGradient glow(tip, 13);
            glow.setColorAt(0.0, gc);
            glow.setColorAt(1.0, Qt::transparent);
            p.setBrush(glow); p.setPen(Qt::NoPen);
            p.drawEllipse(tip, 13, 13);
        }

        // ── Tick marks ────────────────────────────────────────────────────
        // 60 ticks over 270° = 4.5°/tick; every 10th is a major tick.
        const double oT = R * 0.74, iMaj = R * 0.59, iMin = R * 0.66;
        for (int i = 0; i <= 60; ++i) {
            const bool maj = (i % 10 == 0);
            const double ang = (225.0 - i * 4.5) * M_PI / 180.0;
            const double ri = maj ? iMaj : iMin;
            p.setPen(QPen(maj ? QColor(0x94a3b8) : QColor(0x2d3850),
                          maj ? 2.0 : 1.0, Qt::SolidLine, Qt::RoundCap));
            p.drawLine(QPointF(C.x() + oT  * std::cos(ang), C.y() - oT  * std::sin(ang)),
                       QPointF(C.x() + ri  * std::cos(ang), C.y() - ri  * std::sin(ang)));
        }

        // ── "SPEED" label ─────────────────────────────────────────────────
        {
            QFont f = p.font(); f.setPointSize(6);
            f.setLetterSpacing(QFont::AbsoluteSpacing, 2.5); p.setFont(f);
            p.setPen(QColor(0x475569));
            p.drawText(QRectF(C.x()-38, C.y() - R*0.40, 76, 13),
                       Qt::AlignCenter, QStringLiteral("SPEED"));
        }

        // ── Digital readout ───────────────────────────────────────────────
        QString spdStr, unitStr;
        if (m_bps >= 1024.0*1024.0) { spdStr = QString::number(m_bps/(1024*1024),'f',1); unitStr = "MB/s"; }
        else if (m_bps >= 1024.0)   { spdStr = QString::number(m_bps/1024.0,     'f',1); unitStr = "KB/s"; }
        else if (m_bps > 0.5)       { spdStr = QString::number(int(m_bps));               unitStr = "B/s";  }
        else                        { spdStr = QStringLiteral("0.0");                      unitStr = "KB/s"; }
        {
            QFont f = p.font(); f.setBold(true); f.setPointSize(15);
            f.setLetterSpacing(QFont::PercentageSpacing, 90); p.setFont(f);
            p.setPen(QColor(0xf1f5f9));
            p.drawText(QRectF(C.x()-48, C.y()+8, 96, 26), Qt::AlignCenter, spdStr);
        }
        {
            QFont f = p.font(); f.setBold(false); f.setPointSize(8);
            f.setLetterSpacing(QFont::AbsoluteSpacing, 1.2); p.setFont(f);
            p.setPen(QColor(0x64748b));
            p.drawText(QRectF(C.x()-38, C.y()+34, 76, 16), Qt::AlignCenter, unitStr);
        }

        // ── Needle (with orange glow + white highlight + counterweight) ───
        {
            const double nAng = (225.0 - m_curFrac * 270.0) * M_PI / 180.0;
            const double nLen = R * 0.60, cwt = R * 0.13;
            const QPointF tipPt (C.x() + nLen * std::cos(nAng), C.y() - nLen * std::sin(nAng));
            const QPointF cwtPt (C.x() - cwt  * std::cos(nAng), C.y() + cwt  * std::sin(nAng));
            // Glow
            p.setPen(QPen(QColor(255, 107, 53, 55), 9, Qt::SolidLine, Qt::RoundCap));
            p.drawLine(cwtPt, tipPt);
            // Body
            p.setPen(QPen(QColor(0xff6b35), 3, Qt::SolidLine, Qt::RoundCap));
            p.drawLine(cwtPt, tipPt);
            // Highlight
            p.setPen(QPen(QColor(255, 220, 190, 180), 1, Qt::SolidLine, Qt::RoundCap));
            p.drawLine(cwtPt, tipPt);
        }

        // ── Centre hub ────────────────────────────────────────────────────
        {
            QRadialGradient hg(C, 10);
            hg.setColorAt(0.0, QColor(0xaab4c4));
            hg.setColorAt(0.5, QColor(0x475569));
            hg.setColorAt(1.0, QColor(0x1e293b));
            p.setBrush(hg); p.setPen(QPen(QColor(0x64748b), 1));
            p.drawEllipse(C, 9.5, 9.5);
            p.setBrush(QColor(0x0a0e1a)); p.setPen(Qt::NoPen);
            p.drawEllipse(C, 3.5, 3.5);
        }
    }

private:
    double m_bps        = 0.0;
    double m_maxBps     = 4.0 * 1024 * 1024;
    double m_targetFrac = 0.0;
    double m_curFrac    = 0.0;
    QTimer *m_animTimer = nullptr;
};

// ---------------------------------------------------------------------------
// DownloadDetailsDialog
// ---------------------------------------------------------------------------
DownloadDetailsDialog::DownloadDetailsDialog(DownloadEngine *engine, int id, QWidget *parent)
    : QDialog(parent), m_engine(engine), m_id(id)
{
    setAttribute(Qt::WA_DeleteOnClose);
    setWindowIcon(QIcon(QStringLiteral(":/nexa.png")));
    resize(580, 640);
    setMinimumSize(500, 600);

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
