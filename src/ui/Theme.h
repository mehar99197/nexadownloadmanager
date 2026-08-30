#pragma once

#include <QString>
#include <QColor>
#include <QVector>

class QApplication;

namespace nexa::theme {

// How a theme MOVES. Colours make a theme look different; these make it feel
// different: the gauge on the details plate, the sparkline in the SPEED tile,
// the animation shown while something is loading, and how a progress bar
// fills. No two built-in themes share the same combination (a test enforces
// it), so switching theme changes the motion, not just the paint.
enum class Meter  { Arc, Ring, Bars, Needle, Orbit, Wave };
enum class Spark  { Line, Area, Bars, Dots, Steps, Ribbon };
enum class Loader { Bounce, Shimmer, Stripes, Pulse, Comet, Dash, Segments, Wave };
enum class Fill   { Gradient, Solid, Striped, Glow, Stepped };

struct Motion {
    Meter  meter  = Meter::Arc;
    Spark  spark  = Spark::Area;
    Loader loader = Loader::Shimmer;
    Fill   fill   = Fill::Glow;
    double tempo  = 1.0;      // animation speed multiplier: 0.7 calm … 1.4 lively
};

// Palette entries are "#rrggbb" or "rgba(r,g,b,a)"; flatten one onto what it
// is painted over so QPainter code gets a real colour.
QColor flatten(const QString &spec, const QColor &under);

// "Arc gauge · area spark · shimmer loading" — for tooltips and the gallery.
QString describe(const Motion &m);
QString name(Meter m);
QString name(Spark s);
QString name(Loader l);
QString name(Fill f);

// Every colour the UI uses, named by ROLE rather than by shade, so the same
// stylesheet template renders every theme. Anything drawn with QPainter
// (icons, bars, the speed graph) reads these too, so nothing is hard-coded
// to one look.
struct Palette {
    bool dark = true;

    // Surfaces
    QString windowA, windowB, windowC;      // root background gradient
    QString headerA, headerB, headerC;      // header bar gradient
    QString surface;                        // buttons, inputs
    QString surfaceHover;
    QString surfaceAlt;                     // metrics strip, toolbar
    QString tableBg, headerSection, rowLine, rowHover, selectionBg, selectionEdge;
    QString plateA, plateB;                 // dialog plate gradient
    QString menuBg, menuSel, menuSelText;
    QString progressTrack, scrollHandle;

    // Lines
    QString border, borderStrong, borderSubtle;

    // Text
    QString text, textStrong, textMuted, textFaint;

    // Brand
    QString accent, accentMid, accentCool, accentText, focus;

    // Status (badge foreground / background / border)
    QString activeFg, activeBg, activeLine;
    QString pausedFg, pausedBg, pausedLine;
    QString doneFg,   doneBg,   doneLine;
    QString queuedFg, queuedBg, queuedLine;
    QString errorFg,  errorBg,  errorLine;

    // Motion
    Motion motion;
};

// One entry in the theme picker. `id` is what lands in QSettings, so it must
// never change once shipped.
struct ThemeInfo {
    QString id;
    QString name;        // "Midnight Slate"
    QString tagline;     // one line, shown under the name in the gallery
    bool    dark = true; // which group it sits in (ignored when `automatic`)
    bool    automatic = false;   // the "Match my system" pseudo-theme
};

// The special id that follows the desktop's own light/dark preference.
inline QString autoId() { return QStringLiteral("system"); }

// Every selectable theme, in display order: auto first, then dark, then light.
const QVector<ThemeInfo> &available();
// Metadata for one id, or nullptr when the id is unknown.
const ThemeInfo *find(const QString &id);
// Colours for one id. "system" resolves against the desktop preference and an
// unknown id falls back to Nexa Dark.
Palette paletteFor(const QString &id);

// Read the saved mode, resolve it, and apply the resulting stylesheet to the
// application. Safe to call again when the user changes the setting.
void apply(QApplication &app);

// The palette currently in force — for widgets that paint themselves.
const Palette &current();

// Persisted theme id (settings key "ui/theme"). savedId() may be "system";
// resolvedId() is the concrete theme that "system" currently maps to.
QString savedId();
void    setSavedId(const QString &id);
QString resolvedId();

// True when the resolved theme is a dark one.
inline bool isDark() { return current().dark; }

} // namespace nexa::theme
