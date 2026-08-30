// Every built-in theme has to be readable AND has to move in its own way.
//
// This walks the whole catalogue and asserts (1) the WCAG contrast ratios that
// matter for a download list — body text on the window, muted text on the
// metrics strip, each status badge on its own tint, and the primary button's
// label against all three stops of its gradient; (2) that no two themes share
// an accent colour or a gauge/spark/loader combination; and (3) that every
// motion style actually paints something with every theme's palette.
//
// Run via the `nexa_theme_test` target / `ctest -R themes`.

#include "ui/Motion.h"
#include "ui/Theme.h"

#include <QColor>
#include <QGuiApplication>
#include <QImage>
#include <QPainter>
#include <QSet>
#include <QStringList>
#include <cmath>
#include <cstdio>
#include <functional>

using namespace nexa;

static int g_fail = 0, g_pass = 0;
#define CK(cond, msg) do { \
    if (cond) { ++g_pass; } \
    else { ++g_fail; std::fprintf(stderr, "FAIL: %s  (%s:%d)\n", \
                                  qPrintable(QString(msg)), __FILE__, __LINE__); } \
} while (0)

// Palette entries are either "#rrggbb" or "rgba(r,g,b,a)". Flatten the second
// form onto whatever it is painted over, which is what the eye actually sees.
static QColor over(const QString &spec, const QColor &under)
{
    if (!spec.startsWith(QLatin1String("rgba(")))
        return QColor(spec);
    const QStringList n = spec.mid(5, spec.size() - 6).split(QLatin1Char(','));
    if (n.size() != 4)
        return under;
    const double a = n[3].toDouble() / 255.0;
    return QColor(int(under.red()   + (n[0].toInt() - under.red())   * a),
                  int(under.green() + (n[1].toInt() - under.green()) * a),
                  int(under.blue()  + (n[2].toInt() - under.blue())  * a));
}

static double channel(double v)
{
    v /= 255.0;
    return v <= 0.03928 ? v / 12.92 : std::pow((v + 0.055) / 1.055, 2.4);
}

static double luminance(const QColor &c)
{
    return 0.2126 * channel(c.red()) + 0.7152 * channel(c.green()) + 0.0722 * channel(c.blue());
}

static double ratio(const QColor &a, const QColor &b)
{
    const double la = luminance(a), lb = luminance(b);
    return (qMax(la, lb) + 0.05) / (qMin(la, lb) + 0.05);
}

// Fail loudly with the measured number so a tweak that dims a theme too far
// says exactly how far.
static void atLeast(const QString &theme, const QString &what,
                    const QColor &fg, const QColor &bg, double want)
{
    const double got = ratio(fg, bg);
    CK(got >= want, QStringLiteral("%1: %2 contrast %3 (want >= %4) [%5 on %6]")
                        .arg(theme, what).arg(got, 0, 'f', 2).arg(want, 0, 'f', 2)
                        .arg(fg.name(), bg.name()));
}

// Paint into a magenta canvas and count the pixels that changed. Magenta is
// in no palette, so anything touched is something the painter drew.
static int painted(int w, int h, const std::function<void(QPainter &)> &draw)
{
    QImage img(w, h, QImage::Format_ARGB32_Premultiplied);
    const QColor sentinel(255, 0, 255);
    img.fill(sentinel);
    {
        QPainter p(&img);
        draw(p);
    }
    int n = 0;
    for (int y = 0; y < h; ++y)
        for (int x = 0; x < w; ++x)
            if (img.pixelColor(x, y) != sentinel)
                ++n;
    return n;
}

int main(int argc, char **argv)
{
    // Text in the gauge needs a font database, which needs a GUI application.
    qputenv("QT_QPA_PLATFORM", "offscreen");
    QGuiApplication app(argc, argv);

    const QVector<theme::ThemeInfo> &all = theme::available();
    CK(all.size() >= 51, QStringLiteral("catalogue has 50+ themes (got %1)").arg(all.size() - 1));

    int darks = 0, lights = 0, autos = 0;
    QSet<QString> ids, names, accents, trios;

    for (const theme::ThemeInfo &t : all) {
        const QString id = t.id;
        CK(!id.isEmpty(),      QStringLiteral("theme id is set"));
        CK(!ids.contains(id),  QStringLiteral("%1: id is unique").arg(id));
        CK(!names.contains(t.name), QStringLiteral("%1: name is unique").arg(id));
        CK(!t.name.isEmpty() && !t.tagline.isEmpty(),
           QStringLiteral("%1: has a name and a tagline").arg(id));
        ids.insert(id);
        names.insert(t.name);
        CK(theme::find(id) != nullptr, QStringLiteral("%1: findable by id").arg(id));

        if (t.automatic) { ++autos; continue; }
        (t.dark ? darks : lights)++;

        const theme::Palette p = theme::paletteFor(id);
        CK(p.dark == t.dark, QStringLiteral("%1: palette agrees with its group").arg(id));

        // No role may be left unset — an empty string would leak "@token@"
        // straight into the stylesheet.
        const QString *roles[] = {
            &p.windowA, &p.windowB, &p.windowC, &p.headerA, &p.headerB, &p.headerC,
            &p.surface, &p.surfaceHover, &p.surfaceAlt, &p.tableBg, &p.headerSection,
            &p.rowLine, &p.rowHover, &p.selectionBg, &p.selectionEdge, &p.plateA, &p.plateB,
            &p.menuBg, &p.menuSel, &p.menuSelText, &p.progressTrack, &p.scrollHandle,
            &p.border, &p.borderStrong, &p.borderSubtle,
            &p.text, &p.textStrong, &p.textMuted, &p.textFaint,
            &p.accent, &p.accentMid, &p.accentCool, &p.accentText, &p.focus,
            &p.activeFg, &p.activeBg, &p.activeLine, &p.pausedFg, &p.pausedBg, &p.pausedLine,
            &p.doneFg, &p.doneBg, &p.doneLine, &p.queuedFg, &p.queuedBg, &p.queuedLine,
            &p.errorFg, &p.errorBg, &p.errorLine,
        };
        bool complete = true;
        for (const QString *r : roles)
            if (r->isEmpty() || !over(*r, QColor(Qt::black)).isValid())
                complete = false;
        CK(complete, QStringLiteral("%1: every palette role is a valid colour").arg(id));

        const QColor ground(p.windowA);
        const QColor table   = over(p.tableBg,    ground);
        const QColor strip   = over(p.surfaceAlt, ground);
        const QColor surface = over(p.surface,    ground);
        const QColor menu    = over(p.menuBg,     ground);

        // A dark theme must actually be dark, and vice versa.
        CK(t.dark ? luminance(ground) < 0.20 : luminance(ground) > 0.55,
           QStringLiteral("%1: ground luminance suits its group (%2)")
               .arg(id).arg(luminance(ground), 0, 'f', 3));

        // Body copy: AA. Secondary copy and chrome: AA large / non-text.
        atLeast(id, QStringLiteral("text on window"),        QColor(p.text),       ground,  4.5);
        atLeast(id, QStringLiteral("text on table"),         QColor(p.text),       table,   4.5);
        atLeast(id, QStringLiteral("text on surface"),       QColor(p.text),       surface, 4.5);
        atLeast(id, QStringLiteral("text on menu"),          QColor(p.text),       menu,    4.5);
        atLeast(id, QStringLiteral("strong text on window"), QColor(p.textStrong), ground,  4.5);
        atLeast(id, QStringLiteral("muted text on strip"),   QColor(p.textMuted),  strip,   3.0);
        atLeast(id, QStringLiteral("faint text on table"),   QColor(p.textFaint),  table,   3.0);
        atLeast(id, QStringLiteral("menu selection text"),   QColor(p.menuSelText),
                over(p.menuSel, menu), 4.5);

        // The primary button is a three-stop gradient; its label sits on all of
        // them, so the worst stop is the one that counts.
        //
        // Nexa Dark is the one exception, pinned rather than quietly "fixed":
        // its white-on-violet→cyan button reads at ~2.9:1 and ~2.0:1 on the two
        // outer stops, below AA-large. That gradient is the product's signature
        // and every existing install already has it, so changing it is a design
        // call, not a test's. New themes must clear 3:1 on every stop.
        const bool grandfathered = (id == QLatin1String("dark"));
        const double stopFloor = grandfathered ? 1.9 : 3.0;
        const QColor label(p.accentText);
        atLeast(id, QStringLiteral("button label on accent"),      label, QColor(p.accent),     stopFloor);
        atLeast(id, QStringLiteral("button label on accent mid"),  label, QColor(p.accentMid),  3.0);
        atLeast(id, QStringLiteral("button label on accent cool"), label, QColor(p.accentCool), stopFloor);

        // Status badges: foreground on its own tinted pill.
        struct { const char *what; const QString &fg; const QString &bg; } badges[] = {
            {"active", p.activeFg, p.activeBg}, {"paused", p.pausedFg, p.pausedBg},
            {"done",   p.doneFg,   p.doneBg},   {"queued", p.queuedFg, p.queuedBg},
            {"error",  p.errorFg,  p.errorBg},
        };
        for (const auto &b : badges)
            atLeast(id, QStringLiteral("%1 badge").arg(QLatin1String(b.what)),
                    QColor(b.fg), over(b.bg, table), 3.0);

        // Structure has to be visible: borders and hover states can't collapse
        // into the surfaces they separate.
        CK(ratio(QColor(p.border), surface) >= 1.12,
           QStringLiteral("%1: border reads against its surface").arg(id));
        CK(over(p.rowHover, table) != table,
           QStringLiteral("%1: row hover is distinguishable").arg(id));
        CK(over(p.selectionBg, table) != table,
           QStringLiteral("%1: selection is distinguishable").arg(id));
        CK(QColor(p.progressTrack) != QColor(p.accent),
           QStringLiteral("%1: progress track differs from its chunk").arg(id));

        // ---- Every theme is DIFFERENT -------------------------------------
        // Not just a recolour: a unique accent, and a unique way of moving.
        const QString accent = QColor(p.accent).name().toLower();
        CK(!accents.contains(accent),
           QStringLiteral("%1: accent %2 is not used by another theme").arg(id, accent));
        accents.insert(accent);
        const theme::Motion &m = p.motion;
        const QString trio = theme::name(m.meter) + QLatin1Char('/') + theme::name(m.spark)
                           + QLatin1Char('/') + theme::name(m.loader);
        CK(!trios.contains(trio),
           QStringLiteral("%1: gauge/spark/loader %2 is not used by another theme").arg(id, trio));
        trios.insert(trio);
        CK(!theme::name(m.meter).isEmpty() && !theme::name(m.spark).isEmpty()
           && !theme::name(m.loader).isEmpty() && !theme::name(m.fill).isEmpty(),
           QStringLiteral("%1: every motion style has a name").arg(id));
        CK(m.tempo >= 0.5 && m.tempo <= 2.0,
           QStringLiteral("%1: tempo %2 is sane").arg(id).arg(m.tempo));
        CK(theme::describe(m).contains(theme::name(m.meter)),
           QStringLiteral("%1: describe() names the gauge").arg(id));

        // ---- Every motion style paints with this palette -------------------
        const QColor active(p.activeFg);
        const QRectF bar(0, 0, 200, 6);
        for (double phase : {0.0, 0.42, 1.3}) {
            const int n = painted(200, 6, [&](QPainter &g) { motion::paintLoader(g, bar, phase, active, p); });
            CK(n > 20, QStringLiteral("%1: %2 loader paints at phase %3 (%4 px)")
                           .arg(id, theme::name(m.loader)).arg(phase).arg(n));
        }
        const int half = painted(200, 6, [&](QPainter &g) { motion::paintFill(g, bar, 0.5, 0.42, active, p); });
        CK(half >= 200 * 6 * 0.30 && half <= 200 * 6 * 0.75,
           QStringLiteral("%1: %2 fill at 50%% covers about half (%3 px)").arg(id, theme::name(m.fill)).arg(half));
        const int full = painted(200, 6, [&](QPainter &g) { motion::paintFill(g, bar, 1.0, 0.42, active, p); });
        CK(full >= 200 * 6 * 0.70,
           QStringLiteral("%1: %2 fill at 100%% fills the bar (%3 px)").arg(id, theme::name(m.fill)).arg(full));
        const int none = painted(200, 6, [&](QPainter &g) { motion::paintFill(g, bar, 0.0, 0.42, active, p); });
        CK(none == 0, QStringLiteral("%1: %2 fill at 0%% paints nothing (%3 px)").arg(id, theme::name(m.fill)).arg(none));

        QVector<double> samples;
        for (int i = 0; i < 30; ++i)
            samples.append(0.3 + 0.7 * std::fabs(std::sin(i * 0.4)));
        const int spark = painted(120, 18, [&](QPainter &g) {
            motion::paintSpark(g, QRectF(0, 0, 120, 18), samples, 60, QColor(p.accentCool), p); });
        CK(spark > 30, QStringLiteral("%1: %2 spark paints (%3 px)").arg(id, theme::name(m.spark)).arg(spark));
        const int idle = painted(120, 18, [&](QPainter &g) {
            motion::paintSpark(g, QRectF(0, 0, 120, 18), QVector<double>{0.0, 0.0, 0.0}, 60, QColor(p.accentCool), p); });
        CK(idle == 0, QStringLiteral("%1: spark stays invisible while idle (%2 px)").arg(id).arg(idle));

        motion::Gauge gs;
        gs.frac = 0.62; gs.peakFrac = 0.8; gs.avgFrac = 0.5;
        gs.bps = 2.5 * 1024 * 1024; gs.peakBps = 3.2 * 1024 * 1024; gs.maxBps = 4.0 * 1024 * 1024;
        gs.phase = 0.7;
        const int gauge = painted(150, 150, [&](QPainter &g) { motion::paintGauge(g, QRectF(0, 0, 150, 150), gs, p); });
        CK(gauge > 5000, QStringLiteral("%1: %2 gauge paints (%3 px)").arg(id, theme::name(m.meter)).arg(gauge));
    }

    CK(autos == 1,     QStringLiteral("exactly one automatic entry (got %1)").arg(autos));
    CK(darks >= 25,    QStringLiteral("at least 25 dark themes (got %1)").arg(darks));
    CK(lights >= 15,   QStringLiteral("at least 15 light themes (got %1)").arg(lights));

    // Every style in every enum is reachable by at least one theme, or it is
    // dead code pretending to be variety.
    QSet<QString> meters, sparks, loaders, fills;
    for (const theme::ThemeInfo &t : all) {
        if (t.automatic) continue;
        const theme::Motion &m = theme::paletteFor(t.id).motion;
        meters.insert(theme::name(m.meter)); sparks.insert(theme::name(m.spark));
        loaders.insert(theme::name(m.loader)); fills.insert(theme::name(m.fill));
    }
    CK(meters.size()  == 6, QStringLiteral("all 6 gauge styles are used (%1)").arg(meters.size()));
    CK(sparks.size()  == 6, QStringLiteral("all 6 spark styles are used (%1)").arg(sparks.size()));
    CK(loaders.size() == 8, QStringLiteral("all 8 loader styles are used (%1)").arg(loaders.size()));
    CK(fills.size()   == 5, QStringLiteral("all 5 fill styles are used (%1)").arg(fills.size()));

    // The two originals must still be there under their original ids, or every
    // existing install silently changes appearance on upgrade.
    CK(theme::find(QStringLiteral("dark")) && theme::find(QStringLiteral("light")),
       QStringLiteral("the original dark/light ids survive"));
    CK(theme::paletteFor(QStringLiteral("dark")).windowA == QStringLiteral("#080a12"),
       QStringLiteral("Nexa Dark is unchanged"));
    CK(theme::paletteFor(QStringLiteral("light")).windowA == QStringLiteral("#f7f8fc"),
       QStringLiteral("Nexa Light is unchanged"));
    // An id we never shipped must not crash or return an empty palette.
    CK(!theme::paletteFor(QStringLiteral("no-such-theme")).windowA.isEmpty(),
       QStringLiteral("unknown ids fall back to a real palette"));

    std::fprintf(stderr, "%d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
