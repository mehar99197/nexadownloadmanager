#include "ui/Theme.h"

#include <QApplication>
#include <QSettings>
#include <QStringList>
#include <QStyleHints>

#include <cmath>

namespace nexa::theme {

namespace {

constexpr auto kModeKey = "ui/theme";
Palette g_current;
QString g_currentId;
bool    g_initialised = false;

// ---------------------------------------------------------------------------
// Colour maths. Themes are described by a handful of seed colours (a recipe);
// every remaining role is derived from them so all themes share one visual
// structure and only the hues change.
// ---------------------------------------------------------------------------

QString hx(const QColor &c) { return c.name(QColor::HexRgb); }

QString rgba(const QColor &c, int alpha)
{
    return QStringLiteral("rgba(%1,%2,%3,%4)").arg(c.red()).arg(c.green()).arg(c.blue()).arg(alpha);
}

QColor mix(const QColor &a, const QColor &b, double t)
{
    t = qBound(0.0, t, 1.0);
    return QColor(int(qRound(a.red()   + (b.red()   - a.red())   * t)),
                  int(qRound(a.green() + (b.green() - a.green()) * t)),
                  int(qRound(a.blue()  + (b.blue()  - a.blue())  * t)));
}

// WCAG relative luminance / contrast ratio. Used to pick button label colours
// and asserted on by tests/ThemeContrastTest.cpp.
double channel(double v)
{
    v /= 255.0;
    return v <= 0.03928 ? v / 12.92 : std::pow((v + 0.055) / 1.055, 2.4);
}

double luminance(const QColor &c)
{
    return 0.2126 * channel(c.red()) + 0.7152 * channel(c.green()) + 0.0722 * channel(c.blue());
}

double contrast(const QColor &a, const QColor &b)
{
    const double la = luminance(a), lb = luminance(b);
    return (qMax(la, lb) + 0.05) / (qMin(la, lb) + 0.05);
}

// Flatten a palette entry ("#rrggbb" or "rgba(r,g,b,a)") onto what it is
// painted over.
QColor over(const QString &spec, const QColor &under)
{
    if (!spec.startsWith(QLatin1String("rgba(")))
        return QColor(spec);
    const QStringList n = spec.mid(5, spec.size() - 6).split(QLatin1Char(','));
    if (n.size() != 4)
        return under;
    return mix(under, QColor(n[0].toInt(), n[1].toInt(), n[2].toInt()), n[3].toDouble() / 255.0);
}

// A theme in seed form. Everything else in Palette is computed from these.
struct Recipe {
    const char *id;
    const char *name;
    const char *tagline;
    bool        dark;
    const char *bg;         // window ground
    const char *panel;      // raised surface: buttons, inputs, cards
    const char *line;       // default border
    const char *text;       // body text
    const char *muted;      // secondary text
    const char *accent;     // brand gradient, warm end
    const char *accentMid;  // brand gradient, middle — also the focus ring
    const char *accentCool; // brand gradient, cool end
    const char *info;       // "downloading"
    const char *warn;       // "paused"
    const char *ok;         // "done"
    const char *neutral;    // "queued"
    const char *danger;     // "error"
    // How the theme moves (see Theme.h). Hand-picked to suit the palette; the
    // theme test refuses two themes with the same gauge/spark/loader trio.
    Meter  meter;
    Spark  spark;
    Loader loader;
    Fill   fill;
    double tempo;
};

// --- The catalogue ---------------------------------------------------------
// Nexa Dark and Nexa Light are hand-tuned below and stay byte-for-byte what
// they always were; everything here is derived so a new theme is one row.
// Order within each group is display order.
const Recipe kRecipes[] = {
    // ---- Dark -------------------------------------------------------------
    {"midnight", "Midnight Slate", "Deep navy slate with a calm azure accent", true,
     "#0a0f1a", "#151d2e", "#28344c", "#dce6f6", "#8ea3c2",
     "#5ea8ff", "#3f7fe0", "#4fd0d8",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#93a4bf", "#ff7a8f",
     Meter::Arc, Spark::Line, Loader::Comet, Fill::Gradient, 1.00},
    {"graphite", "Graphite", "Monochrome charcoal — colour only where it means something", true,
     "#111113", "#1c1c20", "#33333a", "#e8e8ea", "#9b9ba4",
     "#e4e4e7", "#a9a9b3", "#f4f4f5",
     "#8fc7ff", "#f3c165", "#69d6a6", "#9b9ba4", "#ff7b8e",
     Meter::Bars, Spark::Steps, Loader::Segments, Fill::Solid, 0.90},
    {"carbon", "Carbon", "Industrial black lit by a molten amber", true,
     "#0d0d10", "#18181d", "#302f38", "#eae7e2", "#a09a92",
     "#ffb020", "#ff8a3d", "#ffd166",
     "#63c9f5", "#ffb020", "#7ad9a1", "#a09a92", "#ff6f6f",
     Meter::Bars, Spark::Bars, Loader::Stripes, Fill::Striped, 1.10},
    {"arctic", "Arctic", "Cool polar greys under a frost-blue sky", true,
     "#2e3440", "#3b4252", "#4c566a", "#eceff4", "#a8b4c8",
     "#88c0d0", "#81a1c1", "#8fbcbb",
     "#88c0d0", "#ebcb8b", "#a3be8c", "#a8b4c8", "#d5737c",
     Meter::Ring, Spark::Area, Loader::Pulse, Fill::Solid, 0.80},
    {"nocturne", "Nocturne", "Violet and rose over deep plum", true,
     "#282a36", "#343746", "#4a4d63", "#f6f6f2", "#a9afc4",
     "#ff79c6", "#bd93f9", "#8be9fd",
     "#8be9fd", "#ffb86c", "#50fa7b", "#a9afc4", "#ff6e6e",
     Meter::Orbit, Spark::Ribbon, Loader::Dash, Fill::Glow, 1.20},
    {"solar-dusk", "Solar Dusk", "Low-glare teal ink with warm highlights", true,
     "#002b36", "#073642", "#1a5460", "#cfe0df", "#93a1a1",
     "#d33682", "#6c71c4", "#268bd2",
     "#4aa8dd", "#c99a1a", "#9aad2a", "#93a1a1", "#e8524f",
     Meter::Needle, Spark::Steps, Loader::Shimmer, Fill::Solid, 0.90},
    {"ocean", "Deep Ocean", "Abyssal blue-green with a luminous teal", true,
     "#08161c", "#0f2831", "#1d4653", "#d5eaef", "#88a9b3",
     "#22d3ee", "#14b8a6", "#7dd3a8",
     "#42d6ea", "#f2c26b", "#5fd6a4", "#88a9b3", "#ff7a8f",
     Meter::Wave, Spark::Area, Loader::Wave, Fill::Gradient, 0.90},
    {"emerald", "Emerald Night", "Forest-dark with a crisp emerald edge", true,
     "#0a1410", "#13221c", "#244336", "#dcefe5", "#8dab9d",
     "#34d399", "#10b981", "#a3e635",
     "#5fd0e0", "#eec06a", "#4ade80", "#8dab9d", "#ff7a8f",
     Meter::Ring, Spark::Dots, Loader::Segments, Fill::Stepped, 1.00},
    {"crimson", "Crimson Noir", "Near-black with a deep rose signature", true,
     "#120c0f", "#1e1418", "#3c272e", "#f1e3e7", "#b39ba2",
     "#fb7185", "#f43f5e", "#fdba74",
     "#7cc4f0", "#fbbf24", "#5fd6a4", "#b39ba2", "#ff6b81",
     Meter::Needle, Spark::Ribbon, Loader::Comet, Fill::Glow, 1.10},
    {"obsidian", "Obsidian", "True black with a single electric blue", true,
     "#050507", "#111114", "#2a2a30", "#e6e6ea", "#9a9aa6",
     "#3b82f6", "#2563eb", "#60a5fa",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#9a9aa6", "#ff7a8f",
     Meter::Ring, Spark::Bars, Loader::Comet, Fill::Solid, 1.00},
    {"amethyst", "Amethyst", "Deep purple crystal, lit from within", true,
     "#120b1f", "#1d1430", "#372a52", "#ece4fa", "#a493c4",
     "#c084fc", "#a855f7", "#e879f9",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#a493c4", "#ff7a8f",
     Meter::Orbit, Spark::Area, Loader::Shimmer, Fill::Gradient, 1.00},
    {"copper", "Copper", "Burnished metal on warm charcoal", true,
     "#14100d", "#201914", "#3d2f25", "#f1e8df", "#b09a86",
     "#e0955a", "#c4733a", "#f2c48b",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#b09a86", "#ff7a8f",
     Meter::Needle, Spark::Bars, Loader::Stripes, Fill::Striped, 0.90},
    {"ember", "Ember", "Glowing coals — orange heat on soot", true,
     "#160a08", "#241210", "#45231f", "#f6e6e2", "#b8958d",
     "#ff6b35", "#e0451f", "#ffa06b",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#b8958d", "#ff7a8f",
     Meter::Wave, Spark::Ribbon, Loader::Pulse, Fill::Glow, 1.30},
    {"forest", "Forest", "Pine-dark greens, quiet and steady", true,
     "#0b120c", "#142016", "#27402b", "#e3efe4", "#8fab93",
     "#7fb069", "#5a8f47", "#b8d98d",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#8fab93", "#ff7a8f",
     Meter::Bars, Spark::Line, Loader::Segments, Fill::Solid, 0.80},
    {"aurora", "Aurora", "Polar night with green-cyan curtains of light", true,
     "#071016", "#0f1c25", "#1e3644", "#dcf3f5", "#86aab4",
     "#a7f3d0", "#34d399", "#67e8f9",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#86aab4", "#ff7a8f",
     Meter::Wave, Spark::Ribbon, Loader::Wave, Fill::Gradient, 1.10},
    {"synthwave", "Synthwave", "Hot pink and cyan on a retro-future grid", true,
     "#12061c", "#1e0f2e", "#3d1f57", "#fce7f3", "#c39bd3",
     "#ff2fb3", "#b537f2", "#2de2e6",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#c39bd3", "#ff7a8f",
     Meter::Orbit, Spark::Bars, Loader::Stripes, Fill::Glow, 1.40},
    {"matrix", "Matrix", "Phosphor green on a black terminal", true,
     "#020a04", "#071a0b", "#10391a", "#c8f7d0", "#6fb87e",
     "#39ff88", "#16c95a", "#7dffb3",
     "#6fb6ff", "#f0b95e", "#7dffb3", "#6fb87e", "#ff7a8f",
     Meter::Bars, Spark::Dots, Loader::Segments, Fill::Striped, 1.30},
    {"sakura-night", "Sakura Night", "Cherry-blossom pink over a plum dusk", true,
     "#17101a", "#241a29", "#43324a", "#f8e8f0", "#b99ab0",
     "#ffa7c4", "#f472b6", "#fbcfe8",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#b99ab0", "#ff7a8f",
     Meter::Ring, Spark::Dots, Loader::Pulse, Fill::Gradient, 0.80},
    {"mocha", "Mocha", "Coffee browns with a caramel accent", true,
     "#1a1412", "#281f1b", "#45362f", "#f0e6df", "#ad9b8e",
     "#d4a574", "#b5834f", "#e8c9a4",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#ad9b8e", "#ff7a8f",
     Meter::Arc, Spark::Steps, Loader::Dash, Fill::Solid, 0.80},
    {"wine", "Wine", "Bordeaux depths with a rosé highlight", true,
     "#180a10", "#26131b", "#472535", "#f6e4ec", "#b790a3",
     "#d94f7a", "#b02a56", "#f08ea9",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#b790a3", "#ff7a8f",
     Meter::Needle, Spark::Area, Loader::Comet, Fill::Solid, 0.90},
    {"royal", "Royal", "Navy velvet trimmed in gold", true,
     "#0a0d24", "#131838", "#262d5c", "#e6e9ff", "#979dcc",
     "#fbbf24", "#6366f1", "#a5b4fc",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#979dcc", "#ff7a8f",
     Meter::Arc, Spark::Ribbon, Loader::Shimmer, Fill::Stepped, 1.00},
    {"lagoon", "Lagoon", "Tropical teal water after dark", true,
     "#061a1a", "#0d2a2a", "#1c4949", "#dbf5f3", "#86b8b4",
     "#2dd4bf", "#0d9488", "#99f6e4",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#86b8b4", "#ff7a8f",
     Meter::Wave, Spark::Line, Loader::Wave, Fill::Solid, 0.90},
    {"indigo", "Indigo", "Ink-blue night with a periwinkle glow", true,
     "#0c0f2a", "#161a3f", "#2c3266", "#e4e6ff", "#9498cc",
     "#818cf8", "#4f46e5", "#c7d2fe",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#9498cc", "#ff7a8f",
     Meter::Ring, Spark::Steps, Loader::Comet, Fill::Gradient, 1.00},
    {"lava", "Lava", "Molten orange cracks through black rock", true,
     "#100806", "#1c0f0c", "#3a201a", "#fbe9e1", "#bd9a8b",
     "#ff4500", "#cc2e00", "#ffb347",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#bd9a8b", "#ff7a8f",
     Meter::Wave, Spark::Bars, Loader::Stripes, Fill::Glow, 1.40},
    {"deep-space", "Deep Space", "Starlight white and nebula blue on the void", true,
     "#04050c", "#0d0f1d", "#202440", "#dfe3ff", "#8a90bb",
     "#e0e7ff", "#7c8dff", "#38bdf8",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#8a90bb", "#ff7a8f",
     Meter::Orbit, Spark::Dots, Loader::Comet, Fill::Solid, 0.70},
    {"moss", "Moss", "Soft olive greens on damp stone", true,
     "#10140c", "#1b2216", "#35402c", "#ecf0e2", "#a3ac93",
     "#a3b86c", "#7d9b48", "#d4e29a",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#a3ac93", "#ff7a8f",
     Meter::Bars, Spark::Area, Loader::Pulse, Fill::Stepped, 0.80},
    {"steel", "Steel", "Brushed gunmetal with a cool blue edge", true,
     "#0f1215", "#1a1f24", "#313940", "#e4e9ee", "#93a0ab",
     "#8fb3c9", "#5e8ba4", "#bcd3e2",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#93a0ab", "#ff7a8f",
     Meter::Needle, Spark::Steps, Loader::Segments, Fill::Solid, 1.00},
    {"bronze", "Bronze", "Antique metal on dark walnut", true,
     "#12100b", "#1e1a13", "#3b3325", "#f0eadc", "#ad9f84",
     "#cd7f32", "#a5652a", "#e6b877",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#ad9f84", "#ff7a8f",
     Meter::Arc, Spark::Bars, Loader::Dash, Fill::Striped, 0.90},
    {"cobalt", "Cobalt", "Saturated blue on a midnight ground", true,
     "#071022", "#0f1c3a", "#1f3563", "#dfe9ff", "#8ea6d0",
     "#0ea5e9", "#2563eb", "#7dd3fc",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#8ea6d0", "#ff7a8f",
     Meter::Ring, Spark::Ribbon, Loader::Bounce, Fill::Gradient, 1.10},
    {"rose-night", "Rose Night", "Dusty rose and blush on charcoal", true,
     "#1a1214", "#2a1d20", "#4a3438", "#f9e9ea", "#bc9ea3",
     "#f4a6a6", "#e07a7a", "#fbd5c0",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#bc9ea3", "#ff7a8f",
     Meter::Orbit, Spark::Line, Loader::Pulse, Fill::Glow, 0.90},
    {"sunset", "Sunset", "Coral to gold across a darkening sky", true,
     "#1a0c14", "#2a1520", "#4b2839", "#ffe9ee", "#c497a8",
     "#ff7e5f", "#ff5e7e", "#ffc46b",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#c497a8", "#ff7a8f",
     Meter::Arc, Spark::Area, Loader::Wave, Fill::Glow, 1.00},
    {"twilight", "Twilight", "Lilac, pink and sky-blue at dusk", true,
     "#1b1a2e", "#27263f", "#444266", "#ecebfa", "#a6a3cc",
     "#ff8fab", "#9b8cff", "#6ee7ff",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#a6a3cc", "#ff7a8f",
     Meter::Orbit, Spark::Steps, Loader::Shimmer, Fill::Solid, 0.90},
    {"storm", "Storm", "Slate cloud with a flash of lightning yellow", true,
     "#14181d", "#1f252c", "#38424c", "#e6ebf0", "#96a3af",
     "#f9d548", "#6b7fd7", "#a3bffa",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#96a3af", "#ff7a8f",
     Meter::Bars, Spark::Ribbon, Loader::Comet, Fill::Striped, 1.30},
    {"tokyo-neon", "Tokyo Neon", "Rainy-city violet and blue neon", true,
     "#1a1b26", "#24283b", "#3b4261", "#c0caf5", "#7f88b0",
     "#bb9af7", "#7aa2f7", "#7dcfff",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#7f88b0", "#ff7a8f",
     Meter::Ring, Spark::Area, Loader::Stripes, Fill::Gradient, 1.10},
    {"retro-warm", "Retro Warm", "Seventies browns with orange and mustard", true,
     "#282828", "#3c3836", "#504945", "#ebdbb2", "#a89984",
     "#fe8019", "#d79921", "#8ec07c",
     "#6fb6ff", "#fabd2f", "#b8bb26", "#a89984", "#fb4934",
     Meter::Needle, Spark::Dots, Loader::Bounce, Fill::Stepped, 0.90},
    {"velvet", "Velvet", "Pastel pink and mauve on a soft dark", true,
     "#1e1e2e", "#313244", "#45475a", "#cdd6f4", "#a6adc8",
     "#f5c2e7", "#cba6f7", "#89dceb",
     "#89b4fa", "#f9e2af", "#a6e3a1", "#a6adc8", "#f38ba8",
     Meter::Orbit, Spark::Ribbon, Loader::Bounce, Fill::Solid, 0.90},
    {"harbor-night", "Harbor Night", "Blue-grey harbour with lavender lights", true,
     "#292d3e", "#34394f", "#4a5070", "#e4e7f5", "#9aa2c6",
     "#c792ea", "#82aaff", "#89ddff",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#9aa2c6", "#ff7a8f",
     Meter::Arc, Spark::Dots, Loader::Wave, Fill::Gradient, 0.90},
    {"coral-dusk", "Coral Dusk", "Coral, apricot and teal on grey-violet", true,
     "#1c1e26", "#282b38", "#40445a", "#e8e6ef", "#9c9ab5",
     "#e95678", "#fab795", "#25b2bc",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#9c9ab5", "#ff7a8f",
     Meter::Wave, Spark::Steps, Loader::Dash, Fill::Glow, 1.00},
    {"sunburst", "Sunburst", "Orange, lime and cyan on warm charcoal", true,
     "#272822", "#33342c", "#4d4e44", "#f8f8f2", "#a4a598",
     "#fd971f", "#a6e22e", "#66d9ef",
     "#6fb6ff", "#e6db74", "#a6e22e", "#a4a598", "#f92672",
     Meter::Bars, Spark::Line, Loader::Dash, Fill::Gradient, 1.20},
    {"owl", "Night Owl", "Midnight blue with lime and lavender", true,
     "#011627", "#0b2942", "#1d3b55", "#d6deeb", "#8aa1b8",
     "#addb67", "#82aaff", "#7fdbca",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#8aa1b8", "#ff7a8f",
     Meter::Needle, Spark::Ribbon, Loader::Wave, Fill::Stepped, 0.80},
    {"midnight-gold", "Midnight Gold", "Black tie: near-black with gold leaf", true,
     "#0c0c10", "#17171d", "#2e2e38", "#ede9df", "#a6a294",
     "#d4af37", "#b8902b", "#f2dc8c",
     "#6fb6ff", "#f0b95e", "#5fd6a4", "#a6a294", "#ff7a8f",
     Meter::Ring, Spark::Bars, Loader::Shimmer, Fill::Stepped, 0.90},

    // ---- Light ------------------------------------------------------------
    {"paper", "Paper", "Warm off-white with a quiet indigo", false,
     "#faf9f7", "#ffffff", "#e3ded5", "#23211e", "#6a655c",
     "#4f46e5", "#4338ca", "#0369a1",
     "#0369a1", "#a4570a", "#15803d", "#6a655c", "#b91c1c",
     Meter::Ring, Spark::Line, Loader::Pulse, Fill::Solid, 0.90},
    {"arctic-light", "Arctic Light", "Snow-bright greys under the same frost blue", false,
     "#eceff4", "#ffffff", "#d2dae6", "#2e3440", "#5a6779",
     "#5e81ac", "#4c6f9c", "#3d7d8c",
     "#2f6f96", "#8a6410", "#4a7233", "#5a6779", "#a3454f",
     Meter::Arc, Spark::Steps, Loader::Bounce, Fill::Solid, 0.85},
    {"solar-dawn", "Solar Dawn", "Warm cream paper, easy on tired eyes", false,
     "#fdf6e3", "#fffbf0", "#e2d8bd", "#073642", "#5f7379",
     "#c02f76", "#5f64ba", "#1f7fc0",
     "#1f7fc0", "#8a6600", "#5c7000", "#5f7379", "#cb2a27",
     Meter::Needle, Spark::Line, Loader::Shimmer, Fill::Gradient, 0.90},
    {"sky", "Azure Sky", "Crisp white-blue with a confident azure", false,
     "#f5f8fc", "#ffffff", "#d4dfee", "#16283c", "#526375",
     "#0284c7", "#0369a1", "#0891b2",
     "#0369a1", "#9a5b06", "#15803d", "#526375", "#be123c",
     Meter::Wave, Spark::Area, Loader::Comet, Fill::Gradient, 1.00},
    {"sandstone", "Sandstone", "Warm neutral paper with a terracotta accent", false,
     "#f7f3ec", "#fffdf9", "#e2d8c7", "#2b2420", "#6b6055",
     "#c2410c", "#a63c12", "#a16207",
     "#0f6f9c", "#a4570a", "#4d7c0f", "#6b6055", "#b91c1c",
     Meter::Bars, Spark::Dots, Loader::Dash, Fill::Stepped, 0.90},
    {"mint", "Mint", "Fresh white-green with a clean emerald", false,
     "#f0faf5", "#ffffff", "#cfe6da", "#14352a", "#557a6a",
     "#059669", "#047857", "#0284c7",
     "#0369a1", "#a4570a", "#15803d", "#557a6a", "#b91c1c",
     Meter::Ring, Spark::Area, Loader::Segments, Fill::Solid, 1.00},
    {"lavender", "Lavender", "Pale lilac paper with a violet accent", false,
     "#f6f3fc", "#ffffff", "#dcd4ee", "#2a2145", "#6c6390",
     "#8b5cf6", "#6d28d9", "#c026d3",
     "#0369a1", "#a4570a", "#15803d", "#6c6390", "#b91c1c",
     Meter::Orbit, Spark::Line, Loader::Shimmer, Fill::Gradient, 0.90},
    {"rose", "Rose", "Blush white with a deep rose accent", false,
     "#fdf2f6", "#ffffff", "#f0d3df", "#3d1f2d", "#8a6274",
     "#e11d48", "#be123c", "#db2777",
     "#0369a1", "#a4570a", "#15803d", "#8a6274", "#b91c1c",
     Meter::Arc, Spark::Dots, Loader::Bounce, Fill::Glow, 1.00},
    {"peach", "Peach", "Soft apricot cream with a tangerine accent", false,
     "#fff5ee", "#fffaf6", "#f3d9c7", "#3b271a", "#8a6a55",
     "#ea580c", "#c2410c", "#e11d48",
     "#0369a1", "#a4570a", "#15803d", "#8a6a55", "#b91c1c",
     Meter::Wave, Spark::Bars, Loader::Bounce, Fill::Solid, 1.00},
    {"lemon", "Lemon", "Pale yellow paper with a mustard accent", false,
     "#fefce8", "#fffef5", "#ece5b8", "#35310f", "#7a7440",
     "#a16207", "#854d0e", "#65a30d",
     "#0369a1", "#a4570a", "#15803d", "#7a7440", "#b91c1c",
     Meter::Bars, Spark::Steps, Loader::Pulse, Fill::Gradient, 1.10},
    {"sage", "Sage", "Grey-green linen with an olive accent", false,
     "#f3f6f1", "#fbfcf9", "#d5ddd0", "#26301f", "#647059",
     "#4d7c0f", "#3f6212", "#0f766e",
     "#0369a1", "#a4570a", "#15803d", "#647059", "#b91c1c",
     Meter::Needle, Spark::Area, Loader::Segments, Fill::Stepped, 0.85},
    {"cloud", "Cloud", "Neutral grey-white with a slate accent", false,
     "#f4f6f8", "#ffffff", "#d9dfe6", "#1f2933", "#5f6c7b",
     "#475569", "#334155", "#0284c7",
     "#0369a1", "#a4570a", "#15803d", "#5f6c7b", "#b91c1c",
     Meter::Ring, Spark::Steps, Loader::Dash, Fill::Solid, 1.00},
    {"linen", "Linen", "Natural fibre tones with a walnut accent", false,
     "#faf7f2", "#fffdfa", "#e6dfd2", "#2c2620", "#6f665b",
     "#8b5e34", "#6b4423", "#b45309",
     "#0369a1", "#a4570a", "#15803d", "#6f665b", "#b91c1c",
     Meter::Arc, Spark::Line, Loader::Segments, Fill::Solid, 0.85},
    {"ivory", "Ivory", "Warm ivory with a burnt-orange accent", false,
     "#fffff4", "#ffffff", "#e9e6cf", "#2b2a1e", "#6e6c58",
     "#b45309", "#92400e", "#0f766e",
     "#0369a1", "#a4570a", "#15803d", "#6e6c58", "#b91c1c",
     Meter::Needle, Spark::Dots, Loader::Dash, Fill::Gradient, 0.90},
    {"snow", "Snow", "Clean white with a royal blue accent", false,
     "#f8fafc", "#ffffff", "#d6dde6", "#0f172a", "#526278",
     "#2563eb", "#1d4ed8", "#0891b2",
     "#0369a1", "#a4570a", "#15803d", "#526278", "#b91c1c",
     Meter::Arc, Spark::Bars, Loader::Comet, Fill::Solid, 1.00},
    {"retro-light", "Retro Light", "Parchment cream with seventies orange", false,
     "#fbf1c7", "#fdf6d8", "#d5c4a1", "#3c3836", "#7c6f64",
     "#d65d0e", "#b57614", "#689d6a",
     "#076678", "#b57614", "#79740e", "#7c6f64", "#9d0006",
     Meter::Bars, Spark::Dots, Loader::Bounce, Fill::Striped, 0.90},
    {"latte", "Latte", "Cool grey-white with a mauve accent", false,
     "#eff1f5", "#ffffff", "#ccd0da", "#4c4f69", "#6c6f85",
     "#8839ef", "#1e66f5", "#179299",
     "#1e66f5", "#a4570a", "#15803d", "#6c6f85", "#d20f39",
     Meter::Orbit, Spark::Area, Loader::Pulse, Fill::Solid, 0.90},
    {"tokyo-day", "Tokyo Day", "Daylight version of the neon city", false,
     "#e6e7ed", "#f7f7fb", "#c4c8da", "#343b58", "#6a6f8e",
     "#9854f1", "#2e7de9", "#007197",
     "#0369a1", "#a4570a", "#15803d", "#6a6f8e", "#b91c1c",
     Meter::Ring, Spark::Line, Loader::Stripes, Fill::Gradient, 1.00},
    {"seafoam", "Seafoam", "Pale aqua with a deep teal accent", false,
     "#eefaf8", "#ffffff", "#c9e7e1", "#143633", "#4f7a74",
     "#0d9488", "#0f766e", "#2563eb",
     "#0369a1", "#a4570a", "#15803d", "#4f7a74", "#b91c1c",
     Meter::Wave, Spark::Dots, Loader::Shimmer, Fill::Solid, 1.00},
    {"blush", "Blush", "Rosy white with a raspberry accent", false,
     "#fff1f2", "#fff8f8", "#f5cfd4", "#4a1d24", "#8f5f68",
     "#f43f5e", "#be123c", "#a21caf",
     "#0369a1", "#a4570a", "#15803d", "#8f5f68", "#b91c1c",
     Meter::Orbit, Spark::Ribbon, Loader::Comet, Fill::Gradient, 1.00},
    {"coral-light", "Coral Reef", "Sun-bleached white with living coral", false,
     "#fff4f0", "#fffaf8", "#f5d5cb", "#3d2419", "#8a6558",
     "#ff6f61", "#d94a3d", "#2a9d8f",
     "#0369a1", "#a4570a", "#15803d", "#8a6558", "#b91c1c",
     Meter::Wave, Spark::Line, Loader::Dash, Fill::Striped, 1.10},
};

// Derive a full palette from a recipe. The maths mirrors how the two
// hand-tuned palettes are built: surfaces step away from the ground, borders
// step back toward it, and the brand hue tints the deepest corners.
Palette build(const Recipe &r)
{
    const bool dark = r.dark;
    const QColor white(255, 255, 255), black(0, 0, 0);
    const QColor bg(r.bg), panel(r.panel), line(r.line);
    const QColor body(r.text), muted(r.muted);
    const QColor acc(r.accent), accM(r.accentMid), accC(r.accentCool);

    // "raise" always moves toward white (both themes light their chrome from
    // above); "depth" moves away from the ground in whichever direction the
    // theme has room for.
    auto raise = [&](const QColor &c, double t) { return mix(c, white, t); };
    auto depth = [&](const QColor &c, double t) { return mix(c, dark ? white : black, dark ? t : t * 0.55); };

    Palette p;
    p.dark = dark;

    p.windowA = hx(bg);
    p.windowB = hx(depth(mix(bg, acc, 0.045), 0.015));
    p.windowC = hx(depth(mix(bg, acc, 0.100), 0.040));
    p.headerA = hx(raise(bg, dark ? 0.020 : 0.700));
    p.headerB = hx(mix(raise(bg, dark ? 0.030 : 0.750), accM, 0.035));
    p.headerC = hx(mix(raise(bg, dark ? 0.040 : 0.750), acc,  dark ? 0.120 : 0.085));

    p.surface      = dark ? rgba(panel, 230) : hx(panel);
    p.surfaceHover = dark ? rgba(mix(raise(panel, 0.09), accM, 0.16), 242)
                          : hx(depth(mix(bg, acc, 0.070), 0.012));
    p.surfaceAlt   = dark ? rgba(mix(bg, panel, 0.35), 209) : hx(raise(bg, 0.62));

    p.tableBg       = dark ? rgba(bg, 87) : hx(panel);
    p.headerSection = dark ? rgba(mix(bg, panel, 0.50), 240) : hx(mix(bg, accM, 0.030));
    p.rowLine       = hx(mix(line, bg, 0.50));
    p.rowHover      = dark ? rgba(mix(bg, acc, 0.32), 82) : hx(mix(bg, acc, 0.055));
    p.selectionBg   = dark ? rgba(mix(bg, accM, 0.48), 107) : hx(mix(bg, accM, 0.150));
    p.selectionEdge = dark ? hx(mix(accM, bg, 0.15)) : hx(mix(accM, white, 0.45));

    p.plateA = dark ? rgba(mix(raise(bg, 0.085), acc, 0.070), 250) : rgba(panel, 255);
    p.plateB = dark ? rgba(raise(bg, 0.015), 250) : rgba(mix(raise(bg, 0.55), acc, 0.030), 255);

    p.menuBg      = dark ? hx(mix(raise(bg, 0.055), accM, 0.05)) : hx(raise(panel, 0.35));
    p.menuSel     = dark ? hx(mix(bg, acc, 0.28)) : hx(mix(bg, acc, 0.130));
    p.menuSelText = dark ? hx(mix(acc, white, 0.45)) : hx(mix(acc, black, 0.35));

    p.progressTrack = hx(mix(bg, line, dark ? 0.60 : 0.70));
    p.scrollHandle  = hx(line);

    p.border       = hx(line);
    p.borderStrong = hx(mix(line, bg, 0.22));
    p.borderSubtle = hx(mix(line, bg, 0.45));

    p.text       = hx(body);
    p.textStrong = dark ? hx(mix(body, white, 0.55)) : hx(mix(body, black, 0.45));
    p.textMuted  = hx(muted);
    p.textFaint  = hx(mix(muted, bg, 0.16));

    p.accent     = hx(acc);
    p.accentMid  = hx(accM);
    p.accentCool = hx(accC);
    // The primary button is a three-stop gradient, so its label has to stay
    // readable over ALL three stops: take whichever of white / near-black holds
    // up worst-case. That is why a lime or amber theme gets dark button text.
    {
        const QColor ink = mix(bg, black, dark ? 0.55 : 0.80);
        auto worst = [&](const QColor &fg) {
            return qMin(qMin(contrast(fg, acc), contrast(fg, accM)), contrast(fg, accC));
        };
        p.accentText = worst(white) >= worst(ink) ? hx(white) : hx(ink);
    }
    p.focus = dark ? hx(mix(accM, white, 0.12)) : hx(accM);

    const int fillA = dark ? 33 : 26;
    const int lineA = dark ? 104 : 92;
    auto status = [&](const char *hexColour, QString &fg, QString &fill, QString &edge) {
        const QColor c(hexColour);
        fg = hx(c); fill = rgba(c, fillA); edge = rgba(c, lineA);
    };
    status(r.info,    p.activeFg, p.activeBg, p.activeLine);
    status(r.warn,    p.pausedFg, p.pausedBg, p.pausedLine);
    status(r.ok,      p.doneFg,   p.doneBg,   p.doneLine);
    status(r.neutral, p.queuedFg, p.queuedBg, p.queuedLine);
    status(r.danger,  p.errorFg,  p.errorBg,  p.errorLine);
    p.motion = Motion{r.meter, r.spark, r.loader, r.fill, r.tempo};
    return p;
}

Palette darkPalette()
{
    Palette p;
    p.dark = true;
    p.windowA = QStringLiteral("#080a12");
    p.windowB = QStringLiteral("#0b0e19");
    p.windowC = QStringLiteral("#101126");
    p.headerA = QStringLiteral("#0b0e19");
    p.headerB = QStringLiteral("#0c1020");
    p.headerC = QStringLiteral("#11112a");
    p.surface        = QStringLiteral("rgba(16,21,38,230)");
    p.surfaceHover   = QStringLiteral("rgba(36,42,75,242)");
    p.surfaceAlt     = QStringLiteral("rgba(8,12,24,209)");
    p.tableBg        = QStringLiteral("rgba(7,10,19,87)");
    p.headerSection  = QStringLiteral("rgba(11,15,28,240)");
    p.rowLine        = QStringLiteral("#1c2541");
    p.rowHover       = QStringLiteral("rgba(45,42,91,82)");
    p.selectionBg    = QStringLiteral("rgba(66,55,126,107)");
    p.selectionEdge  = QStringLiteral("#6d63d5");
    p.plateA         = QStringLiteral("rgba(25,27,57,250)");
    p.plateB         = QStringLiteral("rgba(10,13,26,250)");
    p.menuBg         = QStringLiteral("#11152a");
    p.menuSel        = QStringLiteral("#30275d");
    p.menuSelText    = QStringLiteral("#d9c4ff");
    p.progressTrack  = QStringLiteral("#172039");
    p.scrollHandle   = QStringLiteral("#30365a");
    p.border         = QStringLiteral("#30365a");
    p.borderStrong   = QStringLiteral("#29284c");
    p.borderSubtle   = QStringLiteral("#20254a");
    p.text           = QStringLiteral("#dbe5ff");
    p.textStrong     = QStringLiteral("#ffffff");
    p.textMuted      = QStringLiteral("#8190b5");
    p.textFaint      = QStringLiteral("#7180a2");
    p.accent         = QStringLiteral("#b87cff");
    p.accentMid      = QStringLiteral("#786cff");
    p.accentCool     = QStringLiteral("#35c7ff");
    p.accentText     = QStringLiteral("#ffffff");
    p.focus          = QStringLiteral("#8d76ff");
    p.activeFg = QStringLiteral("#65d9ff"); p.activeBg = QStringLiteral("rgba(53,199,255,33)");  p.activeLine = QStringLiteral("rgba(53,199,255,107)");
    p.pausedFg = QStringLiteral("#f6c76b"); p.pausedBg = QStringLiteral("rgba(246,199,107,31)"); p.pausedLine = QStringLiteral("rgba(246,199,107,97)");
    p.doneFg   = QStringLiteral("#63e6c1"); p.doneBg   = QStringLiteral("rgba(69,223,193,31)");  p.doneLine   = QStringLiteral("rgba(69,223,193,97)");
    p.queuedFg = QStringLiteral("#9ba9c3"); p.queuedBg = QStringLiteral("rgba(126,140,177,31)"); p.queuedLine = QStringLiteral("rgba(126,140,177,77)");
    p.errorFg  = QStringLiteral("#ff718c"); p.errorBg  = QStringLiteral("rgba(255,113,140,31)"); p.errorLine  = QStringLiteral("rgba(255,113,140,97)");
    // The original details-plate gauge and shimmering bar live on here.
    p.motion = Motion{Meter::Arc, Spark::Area, Loader::Shimmer, Fill::Glow, 1.0};
    return p;
}

// The light theme keeps Nexa's violet→cyan brand but moves it onto paper-white
// surfaces: cool near-white grounds, a single indigo accent for interactive
// chrome, and status colours darkened until they pass contrast on white.
Palette lightPalette()
{
    Palette p;
    p.dark = false;
    p.windowA = QStringLiteral("#f7f8fc");
    p.windowB = QStringLiteral("#f2f4fa");
    p.windowC = QStringLiteral("#eef0fa");
    p.headerA = QStringLiteral("#ffffff");
    p.headerB = QStringLiteral("#fbfbff");
    p.headerC = QStringLiteral("#f4f2ff");
    p.surface        = QStringLiteral("#ffffff");
    p.surfaceHover   = QStringLiteral("#eef1fb");
    p.surfaceAlt     = QStringLiteral("#fbfcff");
    p.tableBg        = QStringLiteral("#ffffff");
    p.headerSection  = QStringLiteral("#f4f6fc");
    p.rowLine        = QStringLiteral("#e6e9f2");
    p.rowHover       = QStringLiteral("#f3f1fe");
    p.selectionBg    = QStringLiteral("#e8e4ff");
    p.selectionEdge  = QStringLiteral("#a99cf5");
    p.plateA         = QStringLiteral("#ffffff");
    p.plateB         = QStringLiteral("#f8f9ff");
    p.menuBg         = QStringLiteral("#ffffff");
    p.menuSel        = QStringLiteral("#ece7ff");
    p.menuSelText    = QStringLiteral("#3d2b8f");
    p.progressTrack  = QStringLiteral("#e7e9f4");
    p.scrollHandle   = QStringLiteral("#c3c9dd");
    p.border         = QStringLiteral("#d7dbe9");
    p.borderStrong   = QStringLiteral("#cbd0e3");
    p.borderSubtle   = QStringLiteral("#e4e7f1");
    p.text           = QStringLiteral("#1b2138");
    p.textStrong     = QStringLiteral("#0d1123");
    p.textMuted      = QStringLiteral("#5b6480");
    p.textFaint      = QStringLiteral("#727c96");
    p.accent         = QStringLiteral("#7c4dd6");
    p.accentMid      = QStringLiteral("#5b4ee0");
    p.accentCool     = QStringLiteral("#1d8fd1");
    p.accentText     = QStringLiteral("#ffffff");
    p.focus          = QStringLiteral("#6c5ce7");
    p.activeFg = QStringLiteral("#0b6f96"); p.activeBg = QStringLiteral("rgba(29,143,209,26)"); p.activeLine = QStringLiteral("rgba(29,143,209,92)");
    p.pausedFg = QStringLiteral("#8a5a00"); p.pausedBg = QStringLiteral("rgba(180,120,0,26)");  p.pausedLine = QStringLiteral("rgba(180,120,0,92)");
    p.doneFg   = QStringLiteral("#0f7a56"); p.doneBg   = QStringLiteral("rgba(15,122,86,26)");  p.doneLine   = QStringLiteral("rgba(15,122,86,92)");
    p.queuedFg = QStringLiteral("#586179"); p.queuedBg = QStringLiteral("rgba(88,97,121,20)");  p.queuedLine = QStringLiteral("rgba(88,97,121,72)");
    p.errorFg  = QStringLiteral("#c02c48"); p.errorBg  = QStringLiteral("rgba(192,44,72,26)");  p.errorLine  = QStringLiteral("rgba(192,44,72,92)");
    p.motion = Motion{Meter::Ring, Spark::Line, Loader::Bounce, Fill::Gradient, 1.0};
    return p;
}

bool systemPrefersDark()
{
#if QT_VERSION >= QT_VERSION_CHECK(6, 5, 0)
    if (const QStyleHints *hints = QGuiApplication::styleHints())
        return hints->colorScheme() == Qt::ColorScheme::Dark;
#endif
    return true;   // Nexa's own default look
}

// --- Registry --------------------------------------------------------------

struct Entry {
    ThemeInfo info;
    Palette (*make)();          // set for the two hand-tuned themes
    const Recipe *recipe;       // set for everything else
};

const QVector<Entry> &entries()
{
    static const QVector<Entry> list = []() {
        QVector<Entry> v;
        v.push_back({{autoId(), QStringLiteral("Match my system"),
                      QStringLiteral("Follows your desktop's light or dark setting"),
                      true, true}, nullptr, nullptr});
        v.push_back({{QStringLiteral("dark"), QStringLiteral("Nexa Dark"),
                      QStringLiteral("The signature violet-and-cyan night look"),
                      true, false}, &darkPalette, nullptr});
        for (const Recipe &r : kRecipes)
            if (r.dark)
                v.push_back({{QString::fromUtf8(r.id), QString::fromUtf8(r.name),
                              QString::fromUtf8(r.tagline), true, false}, nullptr, &r});
        v.push_back({{QStringLiteral("light"), QStringLiteral("Nexa Light"),
                      QStringLiteral("Paper-white surfaces with the same brand violet"),
                      false, false}, &lightPalette, nullptr});
        for (const Recipe &r : kRecipes)
            if (!r.dark)
                v.push_back({{QString::fromUtf8(r.id), QString::fromUtf8(r.name),
                              QString::fromUtf8(r.tagline), false, false}, nullptr, &r});
        return v;
    }();
    return list;
}

const Entry *entryFor(const QString &id)
{
    for (const Entry &e : entries())
        if (e.info.id == id)
            return &e;
    return nullptr;
}

Palette paletteOf(const Entry &e)
{
    if (e.make)   return e.make();
    if (e.recipe) return build(*e.recipe);
    return darkPalette();
}

// The one stylesheet, written against palette ROLES. Both themes render from it.
QString buildStyleSheet(const Palette &p)
{
    // The item view paints its OWN selection highlight (the desktop's accent
    // colour) underneath our rule. A translucent selection background lets that
    // bleed through, so every theme ends up wearing the same system blue no
    // matter what it asked for. Flatten the two item backgrounds onto the row
    // ground first and the theme gets the last word.
    Palette q = p;
    const QColor rowGround = over(p.tableBg, QColor(p.windowB));
    q.selectionBg = over(p.selectionBg, rowGround).name(QColor::HexRgb);
    q.rowHover    = over(p.rowHover,    rowGround).name(QColor::HexRgb);

    QString qss = QStringLiteral(R"(
        QWidget { background: @windowA@; color: @text@; font-size: 13px;
                   font-family: "Inter", "Segoe UI", sans-serif; }
        QLabel { background: transparent; }
        #Root { background: qlineargradient(x1:0,y1:0,x2:1,y2:1,
                    stop:0 @windowA@, stop:0.55 @windowB@, stop:1 @windowC@); }

        /* ---- Header bar ---- */
        #HeaderBar { background: qlineargradient(x1:0,y1:0,x2:1,y2:0,
                         stop:0 @headerA@, stop:0.52 @headerB@, stop:1 @headerC@);
                     border-bottom: 1px solid @borderStrong@; }
        #BrandLogo { background: transparent; border-radius: 13px; }
        #BrandTitle { color: @textStrong@; font-size: 17px; font-weight: 750; }
        #BrandSub { color: @textMuted@; font-size: 9px; font-weight: 700; }
        /* A resting pill: it must not wear the hover surface, or it reads as a
           permanently hovered block in the middle of the header. */
        #Breadcrumb { color: @textMuted@; font-size: 12px; background: @surface@;
                      border: 1px solid @border@; border-radius: 13px;
                      padding: 5px 14px; }
        #IconBtn { background: @surface@; color: @textMuted@; border: 1px solid @border@;
                   border-radius: 9px; padding: 8px 12px; font-size: 12px; min-width: 16px; }
        #IconBtn:hover { background: @surfaceHover@; color: @textStrong@; border-color: @focus@; }
        #Primary { background: qlineargradient(x1:0,y1:0,x2:1,y2:0,
                       stop:0 @accent@, stop:0.48 @accentMid@, stop:1 @accentCool@);
                   color: @accentText@; border: 0; border-radius: 10px;
                   padding: 8px 15px; font-size: 12px; font-weight: 750; }
        #Primary:hover { background: qlineargradient(x1:0,y1:0,x2:1,y2:0,
                       stop:0 @accentMid@, stop:1 @accentCool@); }
        #NewDl { background: qlineargradient(x1:0,y1:0,x2:1,y2:1,
                       stop:0 @accent@, stop:0.48 @accentMid@, stop:1 @accentCool@);
                 color: @accentText@; border: 0; border-radius: 10px;
                 padding: 9px 16px; font-size: 12px; font-weight: 750; }
        #NewDl:hover { background: qlineargradient(x1:0,y1:0,x2:1,y2:1,
                       stop:0 @accentMid@, stop:1 @accentCool@); }

        /* ---- Metrics bar ---- */
        #MetricsBar { background: @surfaceAlt@; border-bottom: 1px solid @borderSubtle@; }
        #Metric { background: @surfaceAlt@; border-left: 1px solid @borderSubtle@; }
        #MetricFirst { background: @surfaceAlt@; }
        #MetricLabel { color: @textMuted@; font-size: 10px; font-weight: 750; }
        #MetricValue { color: @textStrong@; font-size: 24px; font-weight: 750; }
        #MetricSub { color: @textFaint@; font-size: 11px; }
        #MetricSub[good="true"] { color: @doneFg@; }

        /* ---- Toolbar ---- */
        #Toolbar { background: @surfaceAlt@; border-bottom: 1px solid @borderSubtle@; }
        #Ghost { background: @surface@; color: @textMuted@; border: 1px solid @border@;
                 border-radius: 9px; padding: 8px 13px; font-size: 12px; font-weight: 600; }
        #Ghost:hover { background: @surfaceHover@; color: @textStrong@; border-color: @accentMid@; }
        #Ghost:disabled { background: transparent; color: @textFaint@; border-color: @borderSubtle@; }
        #Ghost:checked { background: @menuSel@; color: @menuSelText@; border-color: @accentMid@; }
        QLineEdit#Search { background: @surface@; border: 1px solid @border@; border-radius: 10px;
                    padding: 8px 11px 8px 30px; color: @text@;
                    selection-background-color: @accentMid@; selection-color: @accentText@; }
        QLineEdit#Search:focus { border-color: @focus@; }

        /* ---- Generic controls (dialogs) ---- */
        QPushButton { background: @surface@; color: @text@; border: 1px solid @border@;
                      border-radius: 9px; padding: 8px 14px; font-weight: 600; }
        QPushButton:hover { background: @surfaceHover@; color: @textStrong@; border-color: @accentMid@; }
        QPushButton:pressed { background: @surfaceHover@; }
        QPushButton:disabled { color: @textFaint@; border-color: @borderSubtle@; }
        QPushButton#Primary { color: @accentText@; border: 0; }
        QLineEdit, QComboBox, QSpinBox, QDoubleSpinBox, QDateTimeEdit, QPlainTextEdit, QTextEdit {
                    background: @surface@; border: 1px solid @border@; border-radius: 9px;
                    padding: 8px 10px; color: @text@;
                    selection-background-color: @accentMid@; selection-color: @accentText@; }
        QLineEdit:focus, QComboBox:focus, QSpinBox:focus, QDoubleSpinBox:focus,
        QDateTimeEdit:focus, QPlainTextEdit:focus, QTextEdit:focus { border-color: @focus@; }
        QComboBox QAbstractItemView { background: @menuBg@; color: @text@;
                    border: 1px solid @border@; selection-background-color: @menuSel@;
                    selection-color: @menuSelText@; }
        QCheckBox { color: @text@; spacing: 8px; }
        QCheckBox::indicator { width: 15px; height: 15px; border: 1px solid @borderStrong@;
                    border-radius: 4px; background: @surface@; }
        QCheckBox::indicator:checked { background: @accentMid@; border-color: @accent@; }
        QCheckBox:disabled { color: @textFaint@; }

        /* ---- Per-row icon-action buttons ---- */
        QPushButton[ActIcon="true"] { background: @surface@; color: @textMuted@;
                      border: 1px solid @border@; border-radius: 7px; padding: 0; font-size: 11px; }
        QPushButton[ActIcon="true"]:hover { background: @surfaceHover@; color: @textStrong@; border-color: @focus@; }

        /* ---- Sponsored strip (Free plan only) ---- */
        #AdBar { background: @surfaceAlt@; border-top: 1px solid @borderSubtle@;
                 border-bottom: 1px solid @borderSubtle@; }
        #AdKicker { color: @accent@; font-size: 9px; font-weight: 750; letter-spacing: 1px; }
        #AdTitle { color: @textStrong@; font-size: 12px; font-weight: 650; }
        #AdBody { color: @textMuted@; font-size: 11px; }
        #AdThumb { background: transparent; border: 1px solid @borderSubtle@; border-radius: 9px; }
        #AdCta { background: qlineargradient(x1:0,y1:0,x2:1,y2:0,
                     stop:0 @accent@, stop:0.48 @accentMid@, stop:1 @accentCool@);
                 color: @accentText@; border: 0; border-radius: 8px;
                 padding: 6px 14px; font-size: 11px; font-weight: 750; }
        #AdCta:hover { background: qlineargradient(x1:0,y1:0,x2:1,y2:0,
                     stop:0 @accentMid@, stop:1 @accentCool@); }
        #AdRemove { background: transparent; color: @textFaint@; border: 0;
                    padding: 6px 4px; font-size: 11px; font-weight: 600; }
        #AdRemove:hover { color: @accent@; }

        /* ---- Download list ---- */
        QLabel#f_name { color: @textStrong@; font-weight: 650; font-size: 13px; }
        QLabel#f_host { color: @textFaint@; font-size: 10px; }
        QLabel#p_pct  { color: @textMuted@; font-size: 11px; }

        QTableWidget { background: @tableBg@; border: 0; outline: 0; }
        QTableWidget::item { border: 0; border-bottom: 1px solid @rowLine@; padding: 0; }
        /* No ::item:hover on purpose. Qt applies it per CELL, and the cells that
           carry widgets (file tile, bar, badge, actions) cover it, so the row lit
           up block by block. The view paints one row-wide band instead
           (ReorderTable in MainWindow.cpp), faded in with the theme's tempo. */
        QTableWidget::item:selected { background: @selectionBg@; color: @textStrong@;
                    border-top: 1px solid @selectionEdge@; border-bottom: 1px solid @selectionEdge@; }
        QHeaderView::section { background: @headerSection@; color: @textFaint@; padding: 10px 10px;
                       border: 0; border-bottom: 1px solid @border@;
                       font-size: 10px; font-weight: 750; }

        QProgressBar { background: @progressTrack@; border: 0; border-radius: 4px; }
        QProgressBar::chunk { border-radius: 3px;
                       background: qlineargradient(x1:0,y1:0,x2:1,y2:0,
                        stop:0 @accentCool@, stop:0.55 @accentMid@, stop:1 @accent@); }

        /* ---- Status badges (colour via the "st" property) ---- */
        QLabel#s_badge { font-size: 10px; font-weight: 750; border-radius: 7px; padding: 3px 8px; }
        QLabel#s_badge[st="active"] { background: @activeBg@; color: @activeFg@; border: 1px solid @activeLine@; }
        QLabel#s_badge[st="paused"] { background: @pausedBg@; color: @pausedFg@; border: 1px solid @pausedLine@; }
        QLabel#s_badge[st="done"]   { background: @doneBg@;   color: @doneFg@;   border: 1px solid @doneLine@; }
        QLabel#s_badge[st="queued"] { background: @queuedBg@; color: @queuedFg@; border: 1px solid @queuedLine@; }
        QLabel#s_badge[st="error"]  { background: @errorBg@;  color: @errorFg@;  border: 1px solid @errorLine@; }

        /* ---- Empty state ---- */
        #EmptyPage { background: qlineargradient(x1:0,y1:0,x2:1,y2:1,
                       stop:0 @windowB@, stop:1 @windowC@); }
        #EmptyTitle { color: @textStrong@; font-size: 18px; font-weight: 750; }
        #EmptyKicker { color: @accent@; font-size: 10px; font-weight: 750; }
        #EmptyHint  { color: @textFaint@; font-size: 12px; }

        /* ---- Footer ---- */
        QStatusBar { background: @surfaceAlt@; border-top: 1px solid @borderSubtle@; }
        QStatusBar::item { border: 0; }
        #FootStat { color: @textFaint@; font-size: 11px; }
        #FootVer  { color: @textFaint@; font-size: 11px; }

        /* ---- Scrollbars / menus / tooltips ---- */
        QScrollBar:vertical { background: transparent; width: 10px; margin: 2px; }
        QScrollBar::handle:vertical { background: @scrollHandle@; border-radius: 5px; min-height: 30px; }
        QScrollBar::handle:vertical:hover { background: @accentMid@; }
        QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
        QMenuBar { background: @headerA@; color: @text@; border-bottom: 1px solid @borderSubtle@; padding: 2px 6px; }
        QMenuBar::item { padding: 4px 10px; border-radius: 6px; background: transparent; }
        QMenuBar::item:selected { background: @menuSel@; color: @menuSelText@; }
        QMenuBar::item:pressed { background: @menuSel@; color: @menuSelText@; }
        QMenu { background: @menuBg@; color: @text@; border: 1px solid @border@;
                border-radius: 8px; padding: 5px; }
        QMenu::item { padding: 6px 16px; border-radius: 6px; }
        QMenu::item:selected { background: @menuSel@; color: @menuSelText@; }
        QMenu::item:disabled { color: @textFaint@; }
        QMenu::separator { height: 1px; background: @border@; margin: 4px 8px; }
        QToolTip { background: @menuBg@; color: @text@; border: 1px solid @border@; padding: 5px 9px; }

        /* ---- Dialogs (details plate / settings) ---- */
        QDialog { background: @windowA@; }
        #Plate { background: qlineargradient(x1:0,y1:0,x2:1,y2:1,
                    stop:0 @plateA@, stop:1 @plateB@);
                 border: 1px solid @border@; border-radius: 15px; }
        #Dd_title { color: @textStrong@; font-size: 15px; font-weight: 700; }
        #Dd_host  { color: @textFaint@; font-size: 11px; }
        #Dd_seclabel { color: @textMuted@; font-size: 11px; }
        #Dd_barpct { color: @textMuted@; font-size: 11px; }
        #SectionHead { color: @accent@; font-weight: 700; font-size: 12px; }
        #Muted { color: @textMuted@; }
        QLabel[ddRole="label"] { color: @textMuted@; font-size: 11px; }
        QLabel[ddRole="value"] { color: @text@; font-size: 13px; }
        #DdCancel { background: @errorBg@; color: @errorFg@; border: 1px solid @errorLine@; }
        #DdCancel:hover { background: @errorBg@; border-color: @errorFg@; }
        QWizard, QWizardPage { background: @windowA@; }
        QProgressDialog { background: @windowA@; }
    )");

    const struct { const char *token; const QString *value; } map[] = {
        {"@windowA@", &q.windowA}, {"@windowB@", &q.windowB}, {"@windowC@", &q.windowC},
        {"@headerA@", &q.headerA}, {"@headerB@", &q.headerB}, {"@headerC@", &q.headerC},
        {"@surfaceHover@", &q.surfaceHover}, {"@surfaceAlt@", &q.surfaceAlt}, {"@surface@", &q.surface},
        {"@tableBg@", &q.tableBg}, {"@headerSection@", &q.headerSection},
        {"@rowLine@", &q.rowLine}, {"@rowHover@", &q.rowHover},
        {"@selectionBg@", &q.selectionBg}, {"@selectionEdge@", &q.selectionEdge},
        {"@plateA@", &q.plateA}, {"@plateB@", &q.plateB},
        {"@menuBg@", &q.menuBg}, {"@menuSelText@", &q.menuSelText}, {"@menuSel@", &q.menuSel},
        {"@progressTrack@", &q.progressTrack}, {"@scrollHandle@", &q.scrollHandle},
        {"@borderStrong@", &q.borderStrong}, {"@borderSubtle@", &q.borderSubtle}, {"@border@", &q.border},
        {"@textStrong@", &q.textStrong}, {"@textMuted@", &q.textMuted},
        {"@textFaint@", &q.textFaint}, {"@text@", &q.text},
        {"@accentMid@", &q.accentMid}, {"@accentCool@", &q.accentCool},
        {"@accentText@", &q.accentText}, {"@accent@", &q.accent}, {"@focus@", &q.focus},
        {"@activeFg@", &q.activeFg}, {"@activeBg@", &q.activeBg}, {"@activeLine@", &q.activeLine},
        {"@pausedFg@", &q.pausedFg}, {"@pausedBg@", &q.pausedBg}, {"@pausedLine@", &q.pausedLine},
        {"@doneFg@", &q.doneFg},     {"@doneBg@", &q.doneBg},     {"@doneLine@", &q.doneLine},
        {"@queuedFg@", &q.queuedFg}, {"@queuedBg@", &q.queuedBg}, {"@queuedLine@", &q.queuedLine},
        {"@errorFg@", &q.errorFg},   {"@errorBg@", &q.errorBg},   {"@errorLine@", &q.errorLine},
    };
    // Longest-first ordering above matters: "@surface@" must not eat "@surfaceAlt@".
    for (const auto &e : map)
        qss.replace(QLatin1String(e.token), *e.value);
    return qss;
}

} // namespace

const QVector<ThemeInfo> &available()
{
    static const QVector<ThemeInfo> list = []() {
        QVector<ThemeInfo> v;
        for (const Entry &e : entries())
            v.push_back(e.info);
        return v;
    }();
    return list;
}

QString name(Meter m)
{
    switch (m) {
    case Meter::Arc:    return QStringLiteral("Arc");
    case Meter::Ring:   return QStringLiteral("Ring");
    case Meter::Bars:   return QStringLiteral("Bars");
    case Meter::Needle: return QStringLiteral("Needle");
    case Meter::Orbit:  return QStringLiteral("Orbit");
    case Meter::Wave:   return QStringLiteral("Wave");
    }
    return QString();
}

QString name(Spark s)
{
    switch (s) {
    case Spark::Line:   return QStringLiteral("Line");
    case Spark::Area:   return QStringLiteral("Area");
    case Spark::Bars:   return QStringLiteral("Bars");
    case Spark::Dots:   return QStringLiteral("Dots");
    case Spark::Steps:  return QStringLiteral("Steps");
    case Spark::Ribbon: return QStringLiteral("Ribbon");
    }
    return QString();
}

QString name(Loader l)
{
    switch (l) {
    case Loader::Bounce:   return QStringLiteral("Bounce");
    case Loader::Shimmer:  return QStringLiteral("Shimmer");
    case Loader::Stripes:  return QStringLiteral("Stripes");
    case Loader::Pulse:    return QStringLiteral("Pulse");
    case Loader::Comet:    return QStringLiteral("Comet");
    case Loader::Dash:     return QStringLiteral("Dash");
    case Loader::Segments: return QStringLiteral("Segments");
    case Loader::Wave:     return QStringLiteral("Wave");
    }
    return QString();
}

QString name(Fill f)
{
    switch (f) {
    case Fill::Gradient: return QStringLiteral("Gradient");
    case Fill::Solid:    return QStringLiteral("Solid");
    case Fill::Striped:  return QStringLiteral("Striped");
    case Fill::Glow:     return QStringLiteral("Glow");
    case Fill::Stepped:  return QStringLiteral("Stepped");
    }
    return QString();
}

QString describe(const Motion &m)
{
    return QStringLiteral("%1 gauge · %2 spark · %3 loading")
        .arg(name(m.meter), name(m.spark).toLower(), name(m.loader).toLower());
}

QColor flatten(const QString &spec, const QColor &under)
{
    return over(spec, under);
}

const ThemeInfo *find(const QString &id)
{
    const Entry *e = entryFor(id);
    return e ? &e->info : nullptr;
}

QString resolvedId()
{
    const QString id = savedId();
    if (id == autoId())
        return systemPrefersDark() ? QStringLiteral("dark") : QStringLiteral("light");
    return id;
}

Palette paletteFor(const QString &id)
{
    const QString wanted = id == autoId()
        ? (systemPrefersDark() ? QStringLiteral("dark") : QStringLiteral("light"))
        : id;
    if (const Entry *e = entryFor(wanted))
        return paletteOf(*e);
    return darkPalette();
}

QString savedId()
{
    const QString id = QSettings().value(QLatin1String(kModeKey), autoId()).toString();
    return entryFor(id) ? id : autoId();      // an unknown/removed theme falls back to auto
}

void setSavedId(const QString &id)
{
    QSettings().setValue(QLatin1String(kModeKey), entryFor(id) ? id : autoId());
}

const Palette &current()
{
    if (!g_initialised) {            // painted before apply() ran (tests, early UI)
        g_current = darkPalette();
        g_currentId = QStringLiteral("dark");
        g_initialised = true;
    }
    return g_current;
}

void apply(QApplication &app)
{
    g_currentId = resolvedId();
    g_current = paletteFor(g_currentId);
    g_initialised = true;
    app.setStyleSheet(buildStyleSheet(g_current));
}

} // namespace nexa::theme
