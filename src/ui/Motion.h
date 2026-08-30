#pragma once

#include "ui/Theme.h"

#include <QColor>
#include <QMetaObject>
#include <QObject>
#include <QRectF>
#include <QString>
#include <QVector>
#include <QWidget>

class QPainter;
class QTimer;

// Everything in Nexa that MOVES — the speed gauge, the sparkline, progress
// fills and the animation shown while something is loading — is drawn here,
// in whichever style the current theme asks for (theme::Palette::motion).
// Widgets own their state and their rect; they hand both to a painter.
namespace nexa::motion {

// Seconds since launch, scaled by the current theme's tempo. Every animated
// painter takes its phase from here, so a theme with tempo 1.3 really does
// move 30% faster everywhere at once.
double clock();

// One repaint clock for every animated widget in the process, so thirty
// active rows cost one timer rather than thirty. Widgets retain() while they
// need frames and release() when they stop; the timer runs only while
// somebody is listening.
class Ticker : public QObject {
    Q_OBJECT
public:
    static Ticker &instance();
    void retain();
    void release();

signals:
    void tick();

private:
    Ticker();
    QTimer *m_timer = nullptr;
    int     m_users = 0;
};

// ---- Painters -------------------------------------------------------------
// Each takes the rect it may paint in. Callers draw the track and set any
// rounded clip first; the painter only adds the moving part.

// Indeterminate "loading" animation across a horizontal track.
void paintLoader(QPainter &p, const QRectF &track, double phase,
                 const QColor &accent, const theme::Palette &pal);

// Determinate fill for a horizontal bar, `frac` in 0..1.
void paintFill(QPainter &p, const QRectF &track, double frac, double phase,
               const QColor &accent, const theme::Palette &pal);

// True when a fill style keeps moving after it is drawn (so it needs frames).
bool fillAnimates(theme::Fill fill);

// Sparkline of samples (oldest → newest) with the newest at the right edge.
// `capacity` is how many samples the rect represents, so a short history grows in
// from the right instead of stretching to fill.
void paintSpark(QPainter &p, const QRectF &r, const QVector<double> &samples,
                int capacity, const QColor &accent, const theme::Palette &pal);

// The circular speed gauge on the details plate.
struct Gauge {
    double frac     = 0.0;   // current speed as 0..1 of the autoscaled maximum
    double peakFrac = 0.0;
    double avgFrac  = 0.0;
    double bps      = 0.0;
    double peakBps  = 0.0;
    double maxBps   = 1.0;
    double phase    = 0.0;   // from clock()
};
void paintGauge(QPainter &p, const QRectF &r, const Gauge &g, const theme::Palette &pal);

// A progress bar that draws itself in the theme's motion style. setRange(0, 0)
// means "loading" and animates; a determinate value animates only when the
// theme's fill style moves. A drop-in for the QProgressBar calls it replaced.
class ThemedBar : public QWidget {
    Q_OBJECT
public:
    explicit ThemedBar(QWidget *parent = nullptr);
    ~ThemedBar() override;

    void setRange(int min, int max);
    void setValue(int value);
    int  value() const { return m_value; }
    bool isIndeterminate() const { return m_min == 0 && m_max == 0; }
    // Fill colour. An invalid colour means "the theme's active colour".
    void setAccent(const QColor &c);

protected:
    void paintEvent(QPaintEvent *) override;
    void showEvent(QShowEvent *) override;
    void hideEvent(QHideEvent *) override;

private:
    void syncTicker();

    int    m_min = 0, m_max = 100, m_value = 0;
    QColor m_accent;
    bool   m_listening = false;
    QMetaObject::Connection m_conn;
};

} // namespace nexa::motion
