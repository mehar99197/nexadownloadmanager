#include "ui/Motion.h"

#include <QConicalGradient>
#include <QElapsedTimer>
#include <QFont>
#include <QLinearGradient>
#include <QPainter>
#include <QPainterPath>
#include <QPolygonF>
#include <QRadialGradient>
#include <QTimer>

#include <algorithm>
#include <cmath>

namespace nexa::motion {

namespace {

constexpr double kPi = 3.14159265358979323846;

QElapsedTimer &launchClock()
{
    static QElapsedTimer t = []() { QElapsedTimer e; e.start(); return e; }();
    return t;
}

QColor alpha(QColor c, int a) { c.setAlpha(qBound(0, a, 255)); return c; }

QColor mix(const QColor &a, const QColor &b, double t)
{
    t = qBound(0.0, t, 1.0);
    return QColor(int(std::lround(a.red()   + (b.red()   - a.red())   * t)),
                  int(std::lround(a.green() + (b.green() - a.green()) * t)),
                  int(std::lround(a.blue()  + (b.blue()  - a.blue())  * t)));
}

// Diagonal barber-pole stripes scrolling left→right across `r`. Shared by the
// Stripes loader and the Striped fill.
void stripes(QPainter &p, const QRectF &r, double t, const QColor &ink, int a)
{
    const double H = r.height();
    const double period = qMax(8.0, H * 1.6);
    const double offset = std::fmod(t * 30.0, period);
    p.setPen(Qt::NoPen);
    p.setBrush(alpha(ink, a));
    for (double x = r.left() - H - period + offset; x < r.right() + period; x += period) {
        QPolygonF q;
        q << QPointF(x, r.top()) << QPointF(x + period / 2.0, r.top())
          << QPointF(x + period / 2.0 - H, r.bottom()) << QPointF(x - H, r.bottom());
        p.drawPolygon(q);
    }
}

void formatSpeed(double bps, QString &num, QString &unit)
{
    if (bps >= 1024.0 * 1024.0) { num = QString::number(bps / (1024.0 * 1024.0), 'f', 1); unit = QStringLiteral("MB/s"); }
    else if (bps >= 1024.0)     { num = QString::number(bps / 1024.0, 'f', 1);            unit = QStringLiteral("KB/s"); }
    else if (bps > 0.5)         { num = QString::number(int(bps));                        unit = QStringLiteral("B/s"); }
    else                        { num = QStringLiteral("0.0");                            unit = QStringLiteral("KB/s"); }
}

} // namespace

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

double clock()
{
    return launchClock().elapsed() / 1000.0 * theme::current().motion.tempo;
}

Ticker &Ticker::instance()
{
    // Heap-allocated and never freed on purpose: a static QObject would be
    // destroyed after QApplication, and its timer with it.
    static Ticker *t = new Ticker;
    return *t;
}

Ticker::Ticker()
    : m_timer(new QTimer(this))
{
    m_timer->setInterval(40);   // 25 fps is plenty for a progress strip
    m_timer->setTimerType(Qt::CoarseTimer);
    connect(m_timer, &QTimer::timeout, this, &Ticker::tick);
}

void Ticker::retain()
{
    if (++m_users == 1)
        m_timer->start();
}

void Ticker::release()
{
    if (m_users > 0 && --m_users == 0)
        m_timer->stop();
}

// ---------------------------------------------------------------------------
// Loader (indeterminate)
// ---------------------------------------------------------------------------

void paintLoader(QPainter &p, const QRectF &r, double t, const QColor &accent, const theme::Palette &pal)
{
    const double W = r.width(), H = r.height();
    if (W <= 0.0 || H <= 0.0)
        return;
    p.save();
    p.setPen(Qt::NoPen);
    const QColor ink = pal.dark ? QColor(0, 0, 0) : QColor(255, 255, 255);

    switch (pal.motion.loader) {
    case theme::Loader::Bounce: {
        // One band gliding to the far end and back.
        const double bw = qMax(8.0, W * 0.32);
        const double u = std::fmod(t / 1.4, 2.0);
        const double pos = (u < 1.0 ? u : 2.0 - u) * (W - bw);
        QLinearGradient g(r.left() + pos, 0, r.left() + pos + bw, 0);
        g.setColorAt(0.0,  Qt::transparent);
        g.setColorAt(0.25, accent.darker(120));
        g.setColorAt(0.5,  accent.lighter(150));
        g.setColorAt(0.75, accent.darker(120));
        g.setColorAt(1.0,  Qt::transparent);
        p.fillRect(r, g);
        break;
    }
    case theme::Loader::Shimmer: {
        // A dim full fill with a bright sweep passing over it.
        p.fillRect(r, alpha(accent, 70));
        const double bw = qMax(12.0, W * 0.35);
        const double x = r.left() + std::fmod(t * (W + bw) / 1.3, W + bw) - bw;
        QLinearGradient g(x, 0, x + bw, 0);
        const QColor hi = pal.dark ? QColor(255, 255, 255) : accent.lighter(135);
        g.setColorAt(0.0, Qt::transparent);
        g.setColorAt(0.5, alpha(hi, pal.dark ? 120 : 220));
        g.setColorAt(1.0, Qt::transparent);
        p.fillRect(r, g);
        break;
    }
    case theme::Loader::Stripes:
        p.fillRect(r, accent);
        stripes(p, r, t, ink, 70);
        break;
    case theme::Loader::Pulse: {
        const double k = 0.5 + 0.5 * std::sin(t * 2.0 * kPi / 1.2);
        p.fillRect(r, alpha(accent, int(60 + 160 * k)));
        break;
    }
    case theme::Loader::Comet: {
        // A bright head dragging a fading tail, left to right, forever.
        const double tail = qMax(16.0, W * 0.45);
        const double head = r.left() + std::fmod(t * (W + tail) / 1.5, W + tail);
        QLinearGradient g(head - tail, 0, head, 0);
        g.setColorAt(0.0, Qt::transparent);
        g.setColorAt(1.0, accent);
        p.fillRect(QRectF(head - tail, r.top(), tail, H), g);
        const double hr = H * 0.6 + 1.0;
        QRadialGradient rg(QPointF(head, r.center().y()), hr * 2.2);
        rg.setColorAt(0.0, accent.lighter(160));
        rg.setColorAt(0.5, alpha(accent, 160));
        rg.setColorAt(1.0, Qt::transparent);
        p.setBrush(rg);
        p.drawEllipse(QPointF(head, r.center().y()), hr * 2.2, hr * 2.2);
        break;
    }
    case theme::Loader::Dash: {
        // Three dashes breathing in sequence, centred on the track. They are a
        // third of a cycle apart, so one is always near full brightness: the
        // loader never has a dead moment where all three sit dim together.
        const int n = 3;
        const double dw = qMax(6.0, qMin(W / 8.0, H * 3.0));
        const double gap = dw * 0.6;
        const double x0 = r.center().x() - (n * dw + (n - 1) * gap) / 2.0;
        const double rad = qMin(H, dw) / 2.0;
        for (int i = 0; i < n; ++i) {
            const double k = 0.5 + 0.5 * std::sin(t * 2.0 * kPi / 1.1 - i * 2.0 * kPi / 3.0);
            p.setBrush(alpha(accent, int(60 + 195 * k)));
            p.drawRoundedRect(QRectF(x0 + i * (dw + gap), r.top(), dw, H), rad, rad);
        }
        break;
    }
    case theme::Loader::Segments: {
        // Discrete blocks lighting up in turn with a short trail.
        const int n = qBound(6, int(W / 14.0), 24);
        const double gap = 2.0;
        const double sw = (W - gap * (n - 1)) / n;
        const int head = int(t * 9.0) % n;
        for (int i = 0; i < n; ++i) {
            const int d = (head - i + n) % n;
            const int a = d == 0 ? 255 : d == 1 ? 150 : d == 2 ? 80 : 35;
            p.setBrush(alpha(accent, a));
            p.drawRect(QRectF(r.left() + i * (sw + gap), r.top(), sw, H));
        }
        break;
    }
    case theme::Loader::Wave: {
        // A ripple of brightness travelling along the track.
        QLinearGradient g(r.left(), 0, r.right(), 0);
        const int stops = 24;
        for (int i = 0; i <= stops; ++i) {
            const double u = double(i) / stops;
            const double k = 0.5 + 0.5 * std::sin(u * 4.0 * kPi - t * 5.0);
            g.setColorAt(u, alpha(accent, int(50 + 200 * k)));
        }
        p.fillRect(r, g);
        break;
    }
    }
    p.restore();
}

// ---------------------------------------------------------------------------
// Fill (determinate)
// ---------------------------------------------------------------------------

bool fillAnimates(theme::Fill fill)
{
    return fill == theme::Fill::Striped || fill == theme::Fill::Glow;
}

void paintFill(QPainter &p, const QRectF &r, double frac, double t, const QColor &accent, const theme::Palette &pal)
{
    const double W = r.width(), H = r.height();
    frac = qBound(0.0, frac, 1.0);
    const double fw = W * frac;
    if (fw < 0.5 || H <= 0.0)
        return;
    const QRectF f(r.left(), r.top(), fw, H);
    p.save();
    p.setPen(Qt::NoPen);

    switch (pal.motion.fill) {
    case theme::Fill::Gradient: {
        QLinearGradient g(r.left(), 0, r.left() + fw, 0);
        g.setColorAt(0.0, accent.darker(135));
        g.setColorAt(0.6, accent);
        g.setColorAt(1.0, accent.lighter(118));
        p.fillRect(f, g);
        break;
    }
    case theme::Fill::Solid:
        p.fillRect(f, accent);
        break;
    case theme::Fill::Striped: {
        p.fillRect(f, accent);
        p.save();
        p.setClipRect(f, Qt::IntersectClip);
        stripes(p, f, t, pal.dark ? QColor(0, 0, 0) : QColor(255, 255, 255), 55);
        p.restore();
        break;
    }
    case theme::Fill::Glow: {
        // Dark start → accent → bright tip, a shimmer passing over it, and a
        // leading edge that breathes.
        QLinearGradient base(r.left(), 0, r.left() + fw, 0);
        base.setColorAt(0.0, accent.darker(200));
        base.setColorAt(0.5, accent.darker(110));
        base.setColorAt(1.0, accent.lighter(120));
        p.fillRect(f, base);

        const double sw = qMax(6.0, fw * 0.28);
        const double pos = std::fmod(t / 1.8, 1.0 + sw / fw);
        const double sx = r.left() + pos * (fw + sw) - sw;
        QLinearGradient shim(sx, 0, sx + sw, 0);
        const QColor hi = pal.dark ? QColor(255, 255, 255) : accent.lighter(150);
        shim.setColorAt(0.0, Qt::transparent);
        shim.setColorAt(0.5, alpha(hi, pal.dark ? 95 : 170));
        shim.setColorAt(1.0, Qt::transparent);
        p.fillRect(f, shim);

        const double gw = qMin(20.0, fw);
        const double pulse = 0.55 + 0.45 * std::sin(t * 5.4);
        QLinearGradient glow(r.left() + fw - gw, 0, r.left() + fw + 3, 0);
        glow.setColorAt(0.0, Qt::transparent);
        glow.setColorAt(1.0, alpha(accent.lighter(130), int(180 * pulse)));
        p.fillRect(QRectF(r.left() + fw - gw, r.top(), gw + 4, H), glow);
        if (H >= 6.0)
            p.fillRect(QRectF(r.left() + 2, r.top(), qMax(0.0, fw - 4), 2),
                       alpha(QColor(255, 255, 255), pal.dark ? 38 : 70));
        break;
    }
    case theme::Fill::Stepped: {
        const int n = qBound(5, int(W / 9.0), 40);
        const double gap = 2.0;
        const double sw = (W - gap * (n - 1)) / n;
        const int lit = int(std::lround(frac * n));
        for (int i = 0; i < lit; ++i)
            p.fillRect(QRectF(r.left() + i * (sw + gap), r.top(), sw, H),
                       i == lit - 1 ? accent.lighter(115) : accent);
        break;
    }
    }
    p.restore();
}

// ---------------------------------------------------------------------------
// Spark
// ---------------------------------------------------------------------------

void paintSpark(QPainter &p, const QRectF &r, const QVector<double> &samples,
                int capacity, const QColor &accent, const theme::Palette &pal)
{
    const int n = samples.size();
    if (n < 2)
        return;
    double peak = 0.0;
    for (double s : samples)
        peak = qMax(peak, s);
    if (peak <= 0.0)
        return;
    capacity = qMax(capacity, n);
    const double W = r.width(), H = r.height();
    const double step = W / double(capacity - 1);
    const double x0 = r.right() - step * double(n - 1);

    QVector<QPointF> pts;
    pts.reserve(n);
    for (int i = 0; i < n; ++i)
        pts.append(QPointF(x0 + step * i, r.bottom() - (qMax(0.0, samples[i]) / peak) * H));

    p.save();
    p.setRenderHint(QPainter::Antialiasing, true);

    QPainterPath line;
    line.moveTo(pts[0]);
    for (int i = 1; i < n; ++i)
        line.lineTo(pts[i]);
    auto areaOf = [&](const QPainterPath &src) {
        QPainterPath a = src;
        a.lineTo(pts.last().x(), r.bottom());
        a.lineTo(pts.first().x(), r.bottom());
        a.closeSubpath();
        return a;
    };
    QLinearGradient fade(0, r.top(), 0, r.bottom());
    fade.setColorAt(0.0, alpha(accent, 110));
    fade.setColorAt(1.0, alpha(accent, 0));
    const QPen stroke(accent, 1.6, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin);

    switch (pal.motion.spark) {
    case theme::Spark::Line:
        p.strokePath(line, stroke);
        break;
    case theme::Spark::Area:
        p.fillPath(areaOf(line), fade);
        p.strokePath(line, stroke);
        break;
    case theme::Spark::Bars: {
        const double bw = qMax(1.0, step * 0.6);
        p.setPen(Qt::NoPen);
        for (int i = 0; i < n; ++i) {
            p.setBrush(alpha(accent, i == n - 1 ? 255 : 170));
            p.drawRect(QRectF(pts[i].x() - bw / 2.0, pts[i].y(), bw, r.bottom() - pts[i].y()));
        }
        break;
    }
    case theme::Spark::Dots: {
        p.strokePath(line, QPen(alpha(accent, 70), 1.0));
        p.setPen(Qt::NoPen);
        const double rad = qBound(1.2, step * 0.32, 3.0);
        for (int i = 0; i < n; ++i) {
            p.setBrush(i == n - 1 ? accent.lighter(130) : accent);
            p.drawEllipse(pts[i], rad, rad);
        }
        break;
    }
    case theme::Spark::Steps: {
        QPainterPath st;
        st.moveTo(pts[0]);
        for (int i = 1; i < n; ++i) {
            st.lineTo(pts[i].x(), pts[i - 1].y());
            st.lineTo(pts[i]);
        }
        p.fillPath(areaOf(st), alpha(accent, 45));
        p.strokePath(st, QPen(accent, 1.5, Qt::SolidLine, Qt::FlatCap, Qt::MiterJoin));
        break;
    }
    case theme::Spark::Ribbon:
        p.strokePath(line, QPen(alpha(accent, 80), qMax(3.0, H * 0.35),
                                Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
        p.strokePath(line, QPen(accent.lighter(115), 1.4, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
        break;
    }
    p.restore();
}

// ---------------------------------------------------------------------------
// Gauge
// ---------------------------------------------------------------------------

void paintGauge(QPainter &p, const QRectF &r, const Gauge &g, const theme::Palette &pal)
{
    p.save();
    p.setRenderHint(QPainter::Antialiasing, true);
    const QPointF C = r.center();
    const double R = qMin(r.width(), r.height()) * 0.5 - 4.0;
    if (R < 10.0) { p.restore(); return; }

    const bool   dark = pal.dark;
    const QColor bg     = theme::flatten(pal.windowA, QColor(Qt::black));
    const QColor panel  = theme::flatten(pal.surface, bg);
    const QColor track  (pal.progressTrack);
    const QColor line   (pal.border);
    const QColor lineSub(pal.borderSubtle);
    const QColor tStrong(pal.textStrong), tMuted(pal.textMuted), tFaint(pal.textFaint);
    const QColor acc(pal.accent), accM(pal.accentMid), accC(pal.accentCool);
    const QColor faceIn  = dark ? mix(panel, accM, 0.10).lighter(112) : panel;
    const QColor faceOut = dark ? bg.darker(105) : mix(bg, line, 0.35);

    auto polar = [&](double deg, double rad) {
        const double a = deg * kPi / 180.0;
        return QPointF(C.x() + rad * std::cos(a), C.y() - rad * std::sin(a));
    };
    auto arcRect = [&](double rad) { return QRectF(C.x() - rad, C.y() - rad, 2 * rad, 2 * rad); };
    // A clockwise sweep of `span` degrees from `start`, cool at the start and
    // warm at the end. Qt's conical gradient runs counter-clockwise, so the
    // sweep walks DOWN the gradient from position 1.0.
    auto sweep = [&](double start, double span) {
        QConicalGradient cg(C, start);
        const double end = qMax(0.0, 1.0 - span / 360.0);
        cg.setColorAt(0.0, acc);
        cg.setColorAt(end, acc);
        cg.setColorAt(end + (1.0 - end) * 0.5, accM);
        cg.setColorAt(1.0, accC);
        return cg;
    };
    auto drawFace = [&](double bezelR, double faceR) {
        QRadialGradient bz(C, bezelR);
        bz.setColorAt(0.74, panel);
        bz.setColorAt(0.82, line);
        bz.setColorAt(0.89, line.lighter(dark ? 135 : 95));
        bz.setColorAt(0.94, line);
        bz.setColorAt(1.00, bg);
        p.setBrush(bz); p.setPen(Qt::NoPen);
        p.drawEllipse(C, bezelR, bezelR);
        QRadialGradient fg(C, faceR);
        fg.setColorAt(0.0,  faceIn);
        fg.setColorAt(0.55, mix(faceIn, faceOut, 0.5));
        fg.setColorAt(1.0,  faceOut);
        p.setBrush(fg);
        p.drawEllipse(C, faceR, faceR);
    };
    auto ticks = [&](double outer, double innerMaj, double innerMin, int count, double start, double span) {
        const int every = qMax(1, count / 6);
        for (int i = 0; i <= count; ++i) {
            const bool maj = (i % every == 0);
            const double deg = start - span * i / count;
            p.setPen(QPen(maj ? tMuted : lineSub, maj ? 2.0 : 1.0, Qt::SolidLine, Qt::RoundCap));
            p.drawLine(polar(deg, outer), polar(deg, maj ? innerMaj : innerMin));
        }
    };
    auto scaleLabels = [&](double rad, double start, double span) {
        QFont f = p.font(); f.setPointSize(5); p.setFont(f);
        p.setPen(tFaint);
        for (int pct : {0, 25, 50, 75, 100}) {
            const QPointF lc = polar(start - span * pct / 100.0, rad);
            const double val = (g.maxBps / 1024.0) * (pct / 100.0);
            const QString lbl = val >= 1024.0 ? QString::number(val / 1024.0, 'f', 0) + QLatin1Char('M')
                                              : QString::number(val, 'f', 0) + QLatin1Char('K');
            p.drawText(QRectF(lc.x() - 14, lc.y() - 6, 28, 12), Qt::AlignCenter, lbl);
        }
    };
    auto needle = [&](double deg, double len, double cw) {
        const QPointF tip = polar(deg, len), tail = polar(deg + 180.0, cw);
        p.setPen(QPen(alpha(accC, 70), 10, Qt::SolidLine, Qt::RoundCap));
        p.drawLine(tail, tip);
        p.setPen(QPen(dark ? tStrong : acc, 2.8, Qt::SolidLine, Qt::RoundCap));
        p.drawLine(tail, tip);
        p.setPen(QPen(alpha(dark ? QColor(255, 255, 255) : tStrong, 200), 1, Qt::SolidLine, Qt::RoundCap));
        p.drawLine(tail, tip);
    };
    auto hub = [&](double rad) {
        QRadialGradient hg(C, rad + 1);
        hg.setColorAt(0.0, tMuted);
        hg.setColorAt(0.5, line);
        hg.setColorAt(1.0, panel);
        p.setBrush(hg); p.setPen(QPen(line, 1));
        p.drawEllipse(C, rad, rad);
        p.setBrush(bg); p.setPen(Qt::NoPen);
        p.drawEllipse(C, rad * 0.4, rad * 0.4);
    };
    auto peakNotch = [&](double deg, double outer, double inner) {
        p.setPen(QPen(alpha(tStrong, 200), 2.5, Qt::SolidLine, Qt::RoundCap));
        p.drawLine(polar(deg, outer), polar(deg, inner));
    };
    auto tipGlow = [&](const QPointF &tip, const QColor &c) {
        const double glowR = 10.0 + 5.0 * (0.5 + 0.5 * std::sin(g.phase * 2.8));
        QRadialGradient glow(tip, glowR);
        glow.setColorAt(0.0, alpha(c, int(200 * (0.6 + 0.4 * std::sin(g.phase * 2.8)))));
        glow.setColorAt(1.0, Qt::transparent);
        p.setBrush(glow); p.setPen(Qt::NoPen);
        p.drawEllipse(tip, glowR, glowR);
    };

    QString spd, unit, pk, pkUnit;
    formatSpeed(g.bps, spd, unit);
    formatSpeed(g.peakBps, pk, pkUnit);
    auto readout = [&](double top, double scale) {
        QFont f = p.font();
        f.setBold(true); f.setPointSizeF(16.0 * scale);
        f.setLetterSpacing(QFont::PercentageSpacing, 90); p.setFont(f);
        p.setPen(tStrong);
        p.drawText(QRectF(C.x() - 50, top, 100, 28 * scale), Qt::AlignCenter, spd);
        f.setBold(false); f.setPointSizeF(qMax(6.0, 8.0 * scale));
        f.setLetterSpacing(QFont::AbsoluteSpacing, 1.5); p.setFont(f);
        p.setPen(tMuted);
        p.drawText(QRectF(C.x() - 40, top + 28 * scale, 80, 15), Qt::AlignCenter, unit);
        f.setPointSizeF(6.0); f.setLetterSpacing(QFont::AbsoluteSpacing, 0); p.setFont(f);
        p.setPen(tFaint);
        p.drawText(QRectF(C.x() - 48, top + 28 * scale + 15, 96, 12), Qt::AlignCenter,
                   QStringLiteral("▲ %1 %2").arg(pk, pkUnit));
    };
    auto caption = [&](double cy) {
        QFont f = p.font(); f.setPointSize(6);
        f.setLetterSpacing(QFont::AbsoluteSpacing, 2.0); p.setFont(f);
        p.setPen(tFaint);
        p.drawText(QRectF(C.x() - 38, cy, 76, 12), Qt::AlignCenter, QStringLiteral("SPEED"));
    };
    const QColor tipColour = g.frac < 0.5 ? accC : g.frac < 0.75 ? accM : acc;

    switch (pal.motion.meter) {
    case theme::Meter::Arc: {
        // The classic: 270° dial, colour-zone track, conic fill, needle, hub.
        drawFace(R, R * 0.79);
        const double arcR = R * 0.67, arcR2 = R * 0.58;
        struct Zone { int s, e; QColor c; };
        for (const Zone &z : { Zone{0, 40, accC}, Zone{40, 75, accM}, Zone{75, 100, acc} }) {
            p.setPen(QPen(alpha(z.c, dark ? 60 : 45), 9, Qt::SolidLine, Qt::FlatCap));
            p.setBrush(Qt::NoBrush);
            p.drawArc(arcRect(arcR), int((225.0 - z.s * 2.7) * 16), int(-(z.e - z.s) * 2.7 * 16));
        }
        if (g.avgFrac > 0.005) {
            p.setPen(QPen(alpha(accC, 150), 4, Qt::SolidLine, Qt::FlatCap));
            p.drawArc(arcRect(arcR2), 225 * 16, int(-g.avgFrac * 270.0 * 16));
        }
        if (g.frac > 0.003) {
            p.setPen(QPen(QBrush(sweep(225.0, 270.0)), 9, Qt::SolidLine, Qt::FlatCap));
            p.drawArc(arcRect(arcR), 225 * 16, int(-g.frac * 270.0 * 16));
            tipGlow(polar(225.0 - g.frac * 270.0, arcR), tipColour);
        }
        if (g.peakFrac > 0.02)
            peakNotch(225.0 - g.peakFrac * 270.0, R * 0.72, R * 0.56);
        ticks(R * 0.73, R * 0.57, R * 0.65, 60, 225.0, 270.0);
        scaleLabels(R * 0.50, 225.0, 270.0);
        caption(C.y() - R * 0.37);
        readout(C.y() + 5, 1.0);
        needle(225.0 - g.frac * 270.0, R * 0.59, R * 0.14);
        hub(10.0);
        break;
    }
    case theme::Meter::Ring: {
        // A full circle that fills clockwise from the top; digits in the middle.
        drawFace(R, R * 0.86);
        const double ringR = R * 0.74, innerR = R * 0.62;
        p.setPen(QPen(track, 8, Qt::SolidLine, Qt::FlatCap));
        p.setBrush(Qt::NoBrush);
        p.drawEllipse(C, ringR, ringR);
        if (g.avgFrac > 0.005) {
            p.setPen(QPen(alpha(accC, 140), 3, Qt::SolidLine, Qt::FlatCap));
            p.drawArc(arcRect(innerR), 90 * 16, int(-g.avgFrac * 360.0 * 16));
        }
        if (g.frac > 0.003) {
            p.setPen(QPen(QBrush(sweep(90.0, 360.0)), 8, Qt::SolidLine, Qt::FlatCap));
            p.drawArc(arcRect(ringR), 90 * 16, int(-g.frac * 360.0 * 16));
            const QPointF tip = polar(90.0 - g.frac * 360.0, ringR);
            tipGlow(tip, tipColour);
            p.setBrush(tStrong); p.setPen(Qt::NoPen);
            p.drawEllipse(tip, 3.0, 3.0);
        }
        if (g.peakFrac > 0.02)
            peakNotch(90.0 - g.peakFrac * 360.0, ringR + 7, ringR + 3);
        caption(C.y() - R * 0.40);
        readout(C.y() - 14, 1.0);
        break;
    }
    case theme::Meter::Bars: {
        // Radial LED segments lighting up around a 270° sweep.
        drawFace(R, R * 0.84);
        const int n = 28;
        const double span = 270.0 / n, gapDeg = 2.2;
        const double barR = R * 0.68;
        const int lit = int(std::lround(g.frac * n));
        for (int i = 0; i < n; ++i) {
            const double start = 225.0 - i * span;
            const QColor c = i < lit ? mix(accC, acc, double(i) / (n - 1)) : track;
            p.setPen(QPen(c, R * 0.16, Qt::SolidLine, Qt::FlatCap));
            p.setBrush(Qt::NoBrush);
            p.drawArc(arcRect(barR), int(start * 16), int(-(span - gapDeg) * 16));
        }
        if (lit > 0)
            tipGlow(polar(225.0 - (lit - 0.5) * span, barR), tipColour);
        if (g.avgFrac > 0.005) {
            p.setPen(Qt::NoPen); p.setBrush(accC);
            p.drawEllipse(polar(225.0 - g.avgFrac * 270.0, R * 0.52), 2.5, 2.5);
        }
        if (g.peakFrac > 0.02)
            peakNotch(225.0 - g.peakFrac * 270.0, R * 0.82, R * 0.77);
        caption(C.y() - R * 0.30);
        readout(C.y() - 8, 0.95);
        break;
    }
    case theme::Meter::Needle: {
        // An analogue instrument: no fill, a marked scale, a long needle.
        drawFace(R, R * 0.82);
        const double arcR = R * 0.70;
        p.setPen(QPen(track, 5, Qt::SolidLine, Qt::FlatCap));
        p.setBrush(Qt::NoBrush);
        p.drawArc(arcRect(arcR), 225 * 16, int(-270.0 * 16));
        p.setPen(QPen(alpha(acc, dark ? 110 : 90), 5, Qt::SolidLine, Qt::FlatCap));   // the red-zone
        p.drawArc(arcRect(arcR), int((225.0 - 0.75 * 270.0) * 16), int(-0.25 * 270.0 * 16));
        if (g.avgFrac > 0.005) {
            p.setPen(QPen(alpha(accC, 150), 2.5, Qt::SolidLine, Qt::FlatCap));
            p.drawArc(arcRect(R * 0.60), 225 * 16, int(-g.avgFrac * 270.0 * 16));
        }
        ticks(R * 0.76, R * 0.60, R * 0.68, 60, 225.0, 270.0);
        scaleLabels(R * 0.50, 225.0, 270.0);
        if (g.peakFrac > 0.02)
            peakNotch(225.0 - g.peakFrac * 270.0, R * 0.78, R * 0.64);
        caption(C.y() - R * 0.36);
        readout(C.y() + R * 0.22, 0.72);
        needle(225.0 - g.frac * 270.0, R * 0.68, R * 0.16);
        hub(8.0);
        break;
    }
    case theme::Meter::Orbit: {
        // A satellite circling faster as the speed climbs, with a trail.
        drawFace(R, R * 0.86);
        const double orbR = R * 0.72;
        p.setPen(QPen(track, 3, Qt::SolidLine, Qt::FlatCap));
        p.setBrush(Qt::NoBrush);
        p.drawEllipse(C, orbR, orbR);
        if (g.frac > 0.003) {
            p.setPen(QPen(alpha(accM, 170), 3, Qt::SolidLine, Qt::FlatCap));
            p.drawArc(arcRect(orbR), 90 * 16, int(-g.frac * 360.0 * 16));
        }
        if (g.avgFrac > 0.005) {
            p.setPen(QPen(alpha(accC, 120), 2, Qt::SolidLine, Qt::FlatCap));
            p.drawArc(arcRect(R * 0.62), 90 * 16, int(-g.avgFrac * 360.0 * 16));
        }
        const double ang = 90.0 - std::fmod(g.phase * (60.0 + 420.0 * g.frac), 360.0);
        p.setPen(Qt::NoPen);
        for (int k = 12; k >= 1; --k) {
            const double rad = 1.0 + 3.0 * (1.0 - k / 12.0);
            p.setBrush(alpha(tipColour, int(200 * (1.0 - k / 13.0))));
            p.drawEllipse(polar(ang + k * 5.0, orbR), rad, rad);
        }
        const QPointF head = polar(ang, orbR);
        QRadialGradient hg(head, 9);
        hg.setColorAt(0.0, tipColour.lighter(150));
        hg.setColorAt(0.45, tipColour);
        hg.setColorAt(1.0, Qt::transparent);
        p.setBrush(hg);
        p.drawEllipse(head, 9.0, 9.0);
        if (g.peakFrac > 0.02)
            peakNotch(90.0 - g.peakFrac * 360.0, orbR + 8, orbR + 4);
        caption(C.y() - R * 0.40);
        readout(C.y() - 14, 1.0);
        break;
    }
    case theme::Meter::Wave: {
        // A liquid level rising with the speed, two waves lapping across it.
        drawFace(R, R * 0.86);
        const double fr = R * 0.86 - 3.0;
        QPainterPath clip;
        clip.addEllipse(C, fr, fr);
        p.save();
        p.setClipPath(clip);
        const double level = C.y() + fr - 2.0 * fr * qBound(0.02, g.frac, 0.98);
        auto wave = [&](double amp, double lambda, double speed, double shift, const QBrush &b) {
            QPainterPath w;
            w.moveTo(C.x() - fr - 2, C.y() + fr + 2);
            for (double x = C.x() - fr - 2; x <= C.x() + fr + 2; x += 2.0)
                w.lineTo(x, level + amp * std::sin((x - C.x()) / lambda * 2.0 * kPi + g.phase * speed + shift));
            w.lineTo(C.x() + fr + 2, C.y() + fr + 2);
            w.closeSubpath();
            p.setPen(Qt::NoPen);
            p.fillPath(w, b);
        };
        QLinearGradient lg(0, level, 0, C.y() + fr);
        lg.setColorAt(0.0, accM);
        lg.setColorAt(1.0, acc.darker(130));
        wave(fr * 0.07, fr * 1.1, 2.2, 0.0, alpha(accC, 120));
        wave(fr * 0.06, fr * 0.9, 2.8, 1.7, QBrush(lg));
        p.restore();
        p.setPen(QPen(line, 2)); p.setBrush(Qt::NoBrush);
        p.drawEllipse(C, fr, fr);
        if (g.peakFrac > 0.02) {
            // Peak as a tide-mark on the rim.
            const double y = C.y() + fr - 2.0 * fr * g.peakFrac;
            p.setPen(QPen(alpha(tStrong, 200), 2.5, Qt::SolidLine, Qt::RoundCap));
            p.drawLine(QPointF(C.x() - fr + 4, y), QPointF(C.x() - fr + 14, y));
        }
        p.setPen(Qt::NoPen); p.setBrush(alpha(panel, dark ? 170 : 200));
        p.drawRoundedRect(QRectF(C.x() - 46, C.y() - 26, 92, 64), 10, 10);
        readout(C.y() - 20, 1.0);
        break;
    }
    }
    p.restore();
}

// ---------------------------------------------------------------------------
// ThemedBar
// ---------------------------------------------------------------------------

ThemedBar::ThemedBar(QWidget *parent)
    : QWidget(parent)
{
    setAttribute(Qt::WA_TransparentForMouseEvents);
    // The app-wide sheet gives every QWidget the window background; this one
    // paints its own rounded track, so keep the square corners clear.
    setStyleSheet(QStringLiteral("background: transparent;"));
}

ThemedBar::~ThemedBar()
{
    if (m_listening)
        Ticker::instance().release();
}

void ThemedBar::setRange(int min, int max)
{
    if (m_min == min && m_max == max)
        return;
    m_min = min;
    m_max = max;
    if (max > min)
        m_value = qBound(min, m_value, max);
    syncTicker();
    update();
}

void ThemedBar::setValue(int value)
{
    if (m_max > m_min)
        value = qBound(m_min, value, m_max);
    if (value == m_value)
        return;
    m_value = value;
    syncTicker();
    update();
}

void ThemedBar::setAccent(const QColor &c)
{
    m_accent = c;
    update();
}

void ThemedBar::paintEvent(QPaintEvent *)
{
    const theme::Palette &pal = theme::current();
    QPainter p(this);
    p.setRenderHint(QPainter::Antialiasing, true);
    const QRectF r = QRectF(rect()).adjusted(0.5, 0.5, -0.5, -0.5);
    const double rad = r.height() / 2.0;
    QPainterPath clip;
    clip.addRoundedRect(r, rad, rad);
    p.fillPath(clip, QColor(pal.progressTrack));
    p.setClipPath(clip);
    const QColor accent = m_accent.isValid() ? m_accent : QColor(pal.activeFg);
    if (isIndeterminate())
        paintLoader(p, r, clock(), accent, pal);
    else if (m_max > m_min)
        paintFill(p, r, double(m_value - m_min) / double(m_max - m_min), clock(), accent, pal);
    // The theme (and with it the fill style) can change under us; re-check
    // whether frames are still needed each time we draw.
    syncTicker();
}

void ThemedBar::showEvent(QShowEvent *) { syncTicker(); }
void ThemedBar::hideEvent(QHideEvent *) { syncTicker(); }

void ThemedBar::syncTicker()
{
    const bool partial = m_max > m_min && m_value > m_min && m_value < m_max;
    const bool want = isVisible()
        && (isIndeterminate() || (partial && fillAnimates(theme::current().motion.fill)));
    if (want == m_listening)
        return;
    m_listening = want;
    if (want) {
        Ticker::instance().retain();
        m_conn = connect(&Ticker::instance(), &Ticker::tick, this, [this]() { update(); });
    } else {
        disconnect(m_conn);
        Ticker::instance().release();
    }
}

} // namespace nexa::motion
