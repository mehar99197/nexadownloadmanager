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
// FlowBar — animated progress bar with a flowing shimmer, leading-edge glow,
// and a smooth indeterminate bounce. Replaces the flat QProgressBar.
// ---------------------------------------------------------------------------
class FlowBar : public QWidget {
public:
    explicit FlowBar(QWidget *parent = nullptr) : QWidget(parent)
    {
        setFixedHeight(14);
        m_timer = new QTimer(this);
        m_timer->setInterval(33);   // ~30 fps
        connect(m_timer, &QTimer::timeout, this, [this]{ ++m_phase; update(); });
        m_timer->start();
    }

    void setRange(int min, int max) { m_min = min; m_max = max; }
    void setValue(int v)            { m_val = v; }
    void setAccent(const QColor &c) { m_accent = c; }

protected:
    void paintEvent(QPaintEvent *) override
    {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        const QRectF r = QRectF(rect()).adjusted(0.5, 0.5, -0.5, -0.5);
        const double W = r.width(), H = r.height(), rad = H / 2.0;

        // Track
        p.setBrush(QColor(0x0d1520)); p.setPen(Qt::NoPen);
        p.drawRoundedRect(r, rad, rad);

        const bool indet = (m_max == 0 && m_min == 0);
        double frac = 0.0;
        if (!indet && m_max > m_min)
            frac = qBound(0.0, double(m_val - m_min) / (m_max - m_min), 1.0);
        const double fillW = indet ? 0.0 : W * frac;

        QPainterPath clip; clip.addRoundedRect(r, rad, rad);
        p.setClipPath(clip);

        if (indet) {
            // Bouncing/flowing band for unknown size.
            const double bw = W * 0.32;
            const double t  = fmod(double(m_phase) / 70.0, 2.0);
            const double pos = (t < 1.0) ? t * (W + bw) - bw
                                         : (2.0 - t) * (W + bw) - bw;
            QLinearGradient g(r.left() + pos, 0, r.left() + pos + bw, 0);
            g.setColorAt(0.0, Qt::transparent);
            g.setColorAt(0.25, m_accent.darker(120));
            g.setColorAt(0.5,  m_accent.lighter(160));
            g.setColorAt(0.75, m_accent.darker(120));
            g.setColorAt(1.0, Qt::transparent);
            p.fillRect(r, g);
        } else if (fillW > 1.0) {
            // Base fill: dark start → accent → bright tip.
            QLinearGradient base(r.left(), 0, r.left() + fillW, 0);
            base.setColorAt(0.0, m_accent.darker(220));
            base.setColorAt(0.5, m_accent.darker(110));
            base.setColorAt(1.0, m_accent.lighter(120));
            p.fillRect(QRectF(r.left(), r.top(), fillW, H), base);

            // Moving shimmer band.
            const double sw  = fillW * 0.28;
            const double pos = fmod(double(m_phase) / 55.0, 1.0 + sw/fillW);
            const double sx  = r.left() + pos * (fillW + sw) - sw;
            QLinearGradient shim(sx, 0, sx + sw, 0);
            shim.setColorAt(0.0, Qt::transparent);
            shim.setColorAt(0.4, QColor(255, 255, 255, 50));
            shim.setColorAt(0.5, QColor(255, 255, 255, 95));
            shim.setColorAt(0.6, QColor(255, 255, 255, 50));
            shim.setColorAt(1.0, Qt::transparent);
            p.fillRect(QRectF(r.left(), r.top(), fillW, H), shim);

            // Leading-edge glow pulse.
            const double gw = qMin(20.0, fillW);
            const double pulse = 0.55 + 0.45 * std::sin(m_phase * 0.18);
            QLinearGradient glow(r.left() + fillW - gw, 0, r.left() + fillW + 3, 0);
            glow.setColorAt(0.0, Qt::transparent);
            glow.setColorAt(1.0, QColor(m_accent.red(), m_accent.green(),
                                        m_accent.blue(), int(180 * pulse)));
            p.fillRect(QRectF(r.left() + fillW - gw, r.top(), gw + 4, H), glow);

            // Bright top-edge highlight.
            p.fillRect(QRectF(r.left() + 2, r.top(), fillW - 4, 2),
                       QColor(255, 255, 255, 38));
        }
        p.setClipping(false);
    }

private:
    int    m_min = 0, m_max = 100, m_val = 0;
    int    m_phase = 0;
    QColor m_accent{0x8b5cf6};
    QTimer *m_timer = nullptr;
};

// ---------------------------------------------------------------------------
// SpeedMeter — advanced circular gauge: colour-zone track arcs, peak marker,
// smoothed average, pulsing tip glow, scale labels, animated needle.
// ---------------------------------------------------------------------------
class SpeedMeter : public QWidget {
public:
    explicit SpeedMeter(QWidget *parent = nullptr) : QWidget(parent)
    {
        setFixedSize(200, 200);
        m_animTimer = new QTimer(this);
        m_animTimer->setInterval(25);   // ~40 fps
        connect(m_animTimer, &QTimer::timeout, this, [this]{
            m_curFrac  += (m_targetFrac - m_curFrac)  * 0.13;
            m_pulse     = fmod(m_pulse + 0.07, 2.0 * M_PI);
            update();
        });
        m_animTimer->start();
    }

    void setSpeed(double bps)
    {
        m_bps = bps;
        // Smoothed average (exponential moving average, τ≈20 samples).
        m_avgBps = (m_avgBps < 1.0) ? bps : m_avgBps * 0.95 + bps * 0.05;
        // Peak: record max, decay very slowly so it stays visible but not forever.
        if (bps > m_peakBps) m_peakBps = bps;
        else m_peakBps *= 0.9998;
        // Autoscale max.
        if (bps > m_maxBps * 0.85)                                m_maxBps = bps * 1.6;
        else if (bps < m_maxBps * 0.2 && m_maxBps > 512*1024.0)  m_maxBps *= 0.992;
        m_targetFrac = (m_maxBps > 0) ? qBound(0.0, bps       / m_maxBps, 1.0) : 0.0;
        m_peakFrac   = (m_maxBps > 0) ? qBound(0.0, m_peakBps / m_maxBps, 1.0) : 0.0;
        m_avgFrac    = (m_maxBps > 0) ? qBound(0.0, m_avgBps  / m_maxBps, 1.0) : 0.0;
    }

protected:
    void paintEvent(QPaintEvent *) override
    {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);

        const QPointF C(width() * 0.5, height() * 0.5);
        const double R = qMin(width(), height()) * 0.5 - 4.0;

        // ── Outer bezel ring ──────────────────────────────────────────────
        {
            QRadialGradient g(C, R);
            g.setColorAt(0.74, QColor(0x1e293b));
            g.setColorAt(0.82, QColor(0x334155));
            g.setColorAt(0.89, QColor(0x4a5568));
            g.setColorAt(0.94, QColor(0x334155));
            g.setColorAt(1.00, QColor(0x0a0e1a));
            p.setBrush(g); p.setPen(Qt::NoPen);
            p.drawEllipse(C, R, R);
        }

        // ── Inner face ────────────────────────────────────────────────────
        const double faceR = R * 0.79;
        {
            QRadialGradient g(C, faceR);
            g.setColorAt(0.0,  QColor(0x1a2440));
            g.setColorAt(0.55, QColor(0x0d1525));
            g.setColorAt(1.0,  QColor(0x060a12));
            p.setBrush(g); p.setPen(Qt::NoPen);
            p.drawEllipse(C, faceR, faceR);
        }

        const double arcR    = R * 0.67;
        const double arcR2   = R * 0.58;   // inner arc (average)
        const QRectF arcRect (C.x()-arcR,  C.y()-arcR,  arcR*2,  arcR*2);
        const QRectF arcRect2(C.x()-arcR2, C.y()-arcR2, arcR2*2, arcR2*2);

        // ── Zone track arcs: green (0-40%), amber (40-75%), red (75-100%) ─
        // Drawn as coloured dim zones behind the main arc.
        struct Zone { int startPct, endPct; QColor col; };
        for (auto z : { Zone{0,40,QColor(0x14532d)}, Zone{40,75,QColor(0x78350f)}, Zone{75,100,QColor(0x7f1d1d)} }) {
            const int s16 = int((225.0 - z.startPct * 2.70) * 16);
            const int sp16= int(-(z.endPct - z.startPct) * 2.70 * 16);
            p.setPen(QPen(z.col, 9, Qt::SolidLine, Qt::FlatCap));
            p.setBrush(Qt::NoBrush);
            p.drawArc(arcRect, s16, sp16);
        }

        // ── Average speed arc (thin, inner ring) ─────────────────────────
        if (m_avgFrac > 0.005) {
            p.setPen(QPen(QColor(99, 102, 241, 140), 4, Qt::SolidLine, Qt::FlatCap));
            p.drawArc(arcRect2, 225*16, int(-m_avgFrac * 270.0 * 16));
        }

        // ── Main fill arc (conical gradient) ─────────────────────────────
        if (m_curFrac > 0.003) {
            QConicalGradient cg(C, 225.0);
            cg.setColorAt(0.000, QColor(0x22c55e));
            cg.setColorAt(0.375, QColor(0xfbbf24));
            cg.setColorAt(0.750, QColor(0xef4444));
            cg.setColorAt(1.000, QColor(0xef4444));
            p.setPen(QPen(QBrush(cg), 9, Qt::SolidLine, Qt::FlatCap));
            p.drawArc(arcRect, 225*16, int(-m_curFrac * 270.0 * 16));

            // Pulsing glow at arc tip.
            const double tipAng = (225.0 - m_curFrac * 270.0) * M_PI / 180.0;
            const QPointF tip(C.x() + arcR * std::cos(tipAng),
                              C.y() - arcR * std::sin(tipAng));
            const QColor gc = (m_curFrac < 0.5) ? QColor(0x22c55e)
                            : (m_curFrac < 0.75) ? QColor(0xfbbf24)
                                                 : QColor(0xef4444);
            const double glowR = 10.0 + 5.0 * (0.5 + 0.5 * std::sin(m_pulse));
            QRadialGradient glow(tip, glowR);
            QColor gc2 = gc; gc2.setAlpha(int(200 * (0.6 + 0.4 * std::sin(m_pulse))));
            glow.setColorAt(0.0, gc2);
            glow.setColorAt(1.0, Qt::transparent);
            p.setBrush(glow); p.setPen(Qt::NoPen);
            p.drawEllipse(tip, glowR, glowR);
        }

        // ── Peak speed marker (white notch that stays at max) ─────────────
        if (m_peakFrac > 0.02) {
            const double pkAng = (225.0 - m_peakFrac * 270.0) * M_PI / 180.0;
            const double o = R * 0.72, i = R * 0.56;
            p.setPen(QPen(QColor(255, 255, 255, 200), 2.5, Qt::SolidLine, Qt::RoundCap));
            p.drawLine(QPointF(C.x() + o * std::cos(pkAng), C.y() - o * std::sin(pkAng)),
                       QPointF(C.x() + i * std::cos(pkAng), C.y() - i * std::sin(pkAng)));
        }

        // ── Tick marks (60 minor + 7 major with scale labels) ─────────────
        const double oT = R * 0.73, iMaj = R * 0.57, iMin = R * 0.65;
        for (int i = 0; i <= 60; ++i) {
            const bool maj = (i % 10 == 0);
            const double ang = (225.0 - i * 4.5) * M_PI / 180.0;
            p.setPen(QPen(maj ? QColor(0x94a3b8) : QColor(0x263045),
                          maj ? 2.0 : 1.0, Qt::SolidLine, Qt::RoundCap));
            p.drawLine(QPointF(C.x() + oT           * std::cos(ang), C.y() - oT           * std::sin(ang)),
                       QPointF(C.x() + (maj?iMaj:iMin) * std::cos(ang), C.y() - (maj?iMaj:iMin) * std::sin(ang)));
        }

        // Scale labels at 0%, 25%, 50%, 75%, 100%.
        for (int pct : {0, 25, 50, 75, 100}) {
            const double ang = (225.0 - pct * 2.70) * M_PI / 180.0;
            const double lr = R * 0.50;
            const QPointF lc(C.x() + lr * std::cos(ang), C.y() - lr * std::sin(ang));
            // Derive a readable label from the max speed.
            double val = (m_maxBps / 1024.0) * (pct / 100.0);
            QString lbl = (val >= 1024.0) ? QString::number(val/1024.0,'f',0)+"M"
                                           : QString::number(val,'f',0)+"K";
            QFont f = p.font(); f.setPointSize(5); p.setFont(f);
            p.setPen(QColor(0x475569));
            p.drawText(QRectF(lc.x()-14, lc.y()-6, 28, 12), Qt::AlignCenter, lbl);
        }

        // ── "SPEED" + "PEAK" labels ───────────────────────────────────────
        {
            QFont f = p.font(); f.setPointSize(6);
            f.setLetterSpacing(QFont::AbsoluteSpacing, 2.0); p.setFont(f);
            p.setPen(QColor(0x475569));
            p.drawText(QRectF(C.x()-38, C.y()-R*0.37, 76, 12),
                       Qt::AlignCenter, QStringLiteral("SPEED"));
        }

        // ── Digital readout (current, unit, avg/peak) ─────────────────────
        auto fmtSpd = [](double bps, QString &num, QString &unit) {
            if (bps >= 1024.0*1024.0) { num=QString::number(bps/(1024*1024),'f',1); unit="MB/s"; }
            else if (bps >= 1024.0)   { num=QString::number(bps/1024.0,     'f',1); unit="KB/s"; }
            else if (bps > 0.5)       { num=QString::number(int(bps));               unit="B/s";  }
            else                      { num=QStringLiteral("0.0");                   unit="KB/s"; }
        };
        QString spdStr, unitStr, peakStr, peakUnit;
        fmtSpd(m_bps,     spdStr,  unitStr);
        fmtSpd(m_peakBps, peakStr, peakUnit);
        {
            QFont f = p.font(); f.setBold(true); f.setPointSize(16);
            f.setLetterSpacing(QFont::PercentageSpacing, 90); p.setFont(f);
            p.setPen(QColor(0xf1f5f9));
            p.drawText(QRectF(C.x()-50, C.y()+5, 100, 28), Qt::AlignCenter, spdStr);
        }
        {
            QFont f = p.font(); f.setBold(false); f.setPointSize(8);
            f.setLetterSpacing(QFont::AbsoluteSpacing, 1.5); p.setFont(f);
            p.setPen(QColor(0x64748b));
            p.drawText(QRectF(C.x()-40, C.y()+33, 80, 15), Qt::AlignCenter, unitStr);
        }
        // Peak + avg line.
        {
            QFont f = p.font(); f.setPointSize(6);
            f.setLetterSpacing(QFont::AbsoluteSpacing, 0); p.setFont(f);
            p.setPen(QColor(0x475569));
            p.drawText(QRectF(C.x()-48, C.y()+48, 96, 12), Qt::AlignCenter,
                       QStringLiteral("▲ %1 %2").arg(peakStr, peakUnit));
        }

        // ── Needle with glow + highlight + counterweight ──────────────────
        {
            const double nAng = (225.0 - m_curFrac * 270.0) * M_PI / 180.0;
            const double nLen = R * 0.59, cwt = R * 0.14;
            const QPointF tip(C.x() + nLen * std::cos(nAng), C.y() - nLen * std::sin(nAng));
            const QPointF cwPt(C.x() - cwt  * std::cos(nAng), C.y() + cwt  * std::sin(nAng));
            p.setPen(QPen(QColor(255,107,53,45), 10, Qt::SolidLine, Qt::RoundCap));
            p.drawLine(cwPt, tip);
            p.setPen(QPen(QColor(0xff6b35), 2.8, Qt::SolidLine, Qt::RoundCap));
            p.drawLine(cwPt, tip);
            p.setPen(QPen(QColor(255,220,190,160), 1, Qt::SolidLine, Qt::RoundCap));
            p.drawLine(cwPt, tip);
        }

        // ── Centre hub ────────────────────────────────────────────────────
        {
            QRadialGradient hg(C, 11);
            hg.setColorAt(0.0, QColor(0xb0bec5));
            hg.setColorAt(0.5, QColor(0x475569));
            hg.setColorAt(1.0, QColor(0x1e293b));
            p.setBrush(hg); p.setPen(QPen(QColor(0x607080), 1));
            p.drawEllipse(C, 10.0, 10.0);
            p.setBrush(QColor(0x090d17)); p.setPen(Qt::NoPen);
            p.drawEllipse(C, 4.0, 4.0);
        }
    }

private:
    double m_bps        = 0.0;
    double m_avgBps     = 0.0;
    double m_peakBps    = 0.0;
    double m_maxBps     = 3.0 * 1024 * 1024;
    double m_targetFrac = 0.0;
    double m_curFrac    = 0.0;
    double m_peakFrac   = 0.0;
    double m_avgFrac    = 0.0;
    double m_pulse      = 0.0;
    QTimer *m_animTimer = nullptr;
};

// ---------------------------------------------------------------------------
// SpeedGraph — live area chart of recent transfer-speed samples. Fills the
// plate and shows the speed trend over time, with a glowing leading dot.
// ---------------------------------------------------------------------------
class SpeedGraph : public QWidget {
public:
    explicit SpeedGraph(QWidget *parent = nullptr) : QWidget(parent)
    {
        setMinimumHeight(80);
        setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Expanding);
        m_samples.fill(0.0, kN);
    }
    void setAccent(const QColor &c) { m_accent = c; }
    void addSample(double bps)
    {
        m_samples[m_head] = bps;
        m_head = (m_head + 1) % kN;
        update();
    }

protected:
    void paintEvent(QPaintEvent *) override
    {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        const QRectF r = QRectF(rect()).adjusted(0.5, 0.5, -0.5, -0.5);
        const double W = r.width(), H = r.height();

        // Card background.
        QPainterPath bg; bg.addRoundedRect(r, 9, 9);
        p.fillPath(bg, QColor(0x0c1320));
        p.save(); p.setClipPath(bg);

        // Scale to the window max (with headroom + a floor so a flat line sits low).
        double mx = 1.0;
        for (double s : m_samples) mx = qMax(mx, s);
        mx *= 1.18;

        // Horizontal grid.
        p.setPen(QPen(QColor(0x182338), 1));
        for (int i = 1; i < 4; ++i) {
            const double y = r.top() + H * i / 4.0;
            p.drawLine(QPointF(r.left(), y), QPointF(r.right(), y));
        }

        // Build the curve oldest→newest, left→right.
        QPainterPath line, area;
        QPointF last;
        for (int i = 0; i < kN; ++i) {
            const int idx = (m_head + i) % kN;
            const double x = r.left() + W * i / double(kN - 1);
            const double y = r.bottom() - H * qBound(0.0, m_samples[idx] / mx, 1.0);
            if (i == 0) { line.moveTo(x, y); area.moveTo(x, r.bottom()); area.lineTo(x, y); }
            else        { line.lineTo(x, y); area.lineTo(x, y); }
            last = QPointF(x, y);
        }
        area.lineTo(r.right(), r.bottom());
        area.closeSubpath();

        // Area fill + line.
        QLinearGradient g(0, r.top(), 0, r.bottom());
        QColor a1 = m_accent; a1.setAlpha(150);
        QColor a2 = m_accent; a2.setAlpha(8);
        g.setColorAt(0.0, a1); g.setColorAt(1.0, a2);
        p.fillPath(area, g);
        p.strokePath(line, QPen(m_accent.lighter(125), 1.7));

        // Glowing leading dot.
        QRadialGradient dg(last, 6);
        dg.setColorAt(0.0, m_accent.lighter(160));
        dg.setColorAt(1.0, Qt::transparent);
        p.setBrush(dg); p.setPen(Qt::NoPen);
        p.drawEllipse(last, 6, 6);
        p.setBrush(m_accent.lighter(150));
        p.drawEllipse(last, 2.2, 2.2);

        p.restore();

        // Label.
        QFont f = p.font(); f.setPointSize(7);
        f.setLetterSpacing(QFont::AbsoluteSpacing, 1.5); p.setFont(f);
        p.setPen(QColor(0x475569));
        p.drawText(r.adjusted(9, 6, -9, 0), Qt::AlignLeft | Qt::AlignTop,
                   QStringLiteral("SPEED HISTORY"));
    }

private:
    static constexpr int kN = 100;
    QVector<double> m_samples;
    int    m_head = 0;
    QColor m_accent{0x8b5cf6};
};

// ---------------------------------------------------------------------------
// DownloadDetailsDialog
// ---------------------------------------------------------------------------
DownloadDetailsDialog::DownloadDetailsDialog(DownloadEngine *engine, int id, QWidget *parent)
    : QDialog(parent), m_engine(engine), m_id(id)
{
    setAttribute(Qt::WA_DeleteOnClose);
    setWindowIcon(QIcon(QStringLiteral(":/nexa.png")));
    resize(560, 620);
    setMinimumSize(480, 580);

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

    // --- Overall progress bar + speed meter ---
    auto *barRow = new QHBoxLayout;
    barRow->setSpacing(12);

    auto *barCol = new QVBoxLayout;
    barCol->setSpacing(4);
    m_bar = new FlowBar(plate);
    m_barPct = new QLabel(QStringLiteral("0%"), plate);
    m_barPct->setObjectName(QStringLiteral("Dd_barpct"));
    m_barPct->setAlignment(Qt::AlignRight);
    m_speedGraph = new SpeedGraph(plate);     // fills the space beside the meter
    barCol->addWidget(m_bar);
    barCol->addWidget(m_barPct);
    barCol->addWidget(m_speedGraph, 1);
    barRow->addLayout(barCol, 1);

    m_speedMeter = new SpeedMeter(plate);
    barRow->addWidget(m_speedMeter, 0, Qt::AlignVCenter);
    v->addLayout(barRow, 1);                  // this row absorbs the extra space

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
    m_table->setMaximumHeight(160);          // table only for segmented; graph fills the rest
    v->addWidget(m_table);

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
    m_bar->setAccent(statusColor(m_state));
    m_speedGraph->setAccent(statusColor(m_state));
    if (m_total > 0) {
        const int pct = int(m_state == DownloadState::Completed ? 100
                            : m_done * 100 / m_total);
        m_bar->setRange(0, 100);
        m_bar->setValue(pct);
        m_barPct->setText(QStringLiteral("%1%").arg(pct));
    } else if (m_state == DownloadState::Downloading || m_state == DownloadState::Probing) {
        m_bar->setRange(0, 0);   // indeterminate
        m_barPct->setText(humanSize(m_done));
    } else {
        m_bar->setRange(0, 100);
        m_bar->setValue(m_state == DownloadState::Completed ? 100 : 0);
        m_barPct->setText(m_state == DownloadState::Completed ? QStringLiteral("100%")
                                                              : humanSize(m_done));
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
    m_speedGraph->addSample(bps);
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
