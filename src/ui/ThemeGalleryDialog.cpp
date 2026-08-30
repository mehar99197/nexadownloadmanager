#include "ui/ThemeGalleryDialog.h"
#include "ui/Theme.h"
#include "ui/Motion.h"

#include <QApplication>
#include <QGridLayout>
#include <QHBoxLayout>
#include <QVBoxLayout>
#include <QLabel>
#include <QLinearGradient>
#include <QMouseEvent>
#include <QPainter>
#include <QPainterPath>
#include <QPushButton>
#include <QScrollArea>
#include <QScreen>
#include <QKeyEvent>
#include <QLineEdit>
#include <QGuiApplication>

#include <functional>

namespace nexa {

namespace {

constexpr int kCardW    = 262;
constexpr int kPreviewH = 132;
constexpr int kCardH    = kPreviewH + 70;
// Cards are still images; this is the moment in the animation they show, chosen
// so every loader is visibly mid-travel rather than parked at an edge.
constexpr double kPreviewPhase = 0.42;

// ---------------------------------------------------------------------------
// The miniature. It is deliberately the real Nexa layout — header bar, metrics
// strip, three download rows — so a card shows how the theme will actually
// read, not just five colour swatches.
// ---------------------------------------------------------------------------
void paintPreview(QPainter &g, const QRectF &r, const theme::Palette &p)
{
    auto c = [](const QString &s) { return QColor(s); };
    // Palette strings can be "rgba(r,g,b,a)"; QColor parses "#rrggbb" only, so
    // blend anything translucent onto the ground before use.
    auto solid = [&](const QString &s, const QColor &under) {
        if (!s.startsWith(QLatin1String("rgba(")))
            return QColor(s);
        const QStringList n = s.mid(5, s.size() - 6).split(QLatin1Char(','));
        if (n.size() != 4)
            return under;
        const double a = n[3].toDouble() / 255.0;
        const QColor top(n[0].toInt(), n[1].toInt(), n[2].toInt());
        return QColor(int(under.red()   + (top.red()   - under.red())   * a),
                      int(under.green() + (top.green() - under.green()) * a),
                      int(under.blue()  + (top.blue()  - under.blue())  * a));
    };

    const QColor ground = c(p.windowA);

    // Root gradient.
    QLinearGradient root(r.topLeft(), r.bottomRight());
    root.setColorAt(0.0,  c(p.windowA));
    root.setColorAt(0.55, c(p.windowB));
    root.setColorAt(1.0,  c(p.windowC));
    g.fillRect(r, root);

    // --- Header bar --------------------------------------------------------
    const QRectF head(r.left(), r.top(), r.width(), 24);
    QLinearGradient hg(head.topLeft(), head.topRight());
    hg.setColorAt(0.0,  c(p.headerA));
    hg.setColorAt(0.52, c(p.headerB));
    hg.setColorAt(1.0,  c(p.headerC));
    g.fillRect(head, hg);
    g.setPen(QPen(c(p.borderStrong), 1));
    g.drawLine(head.bottomLeft(), head.bottomRight());

    QLinearGradient brand(0, 0, 1, 1);
    brand.setCoordinateMode(QGradient::ObjectBoundingMode);
    brand.setColorAt(0.0,  c(p.accent));
    brand.setColorAt(0.48, c(p.accentMid));
    brand.setColorAt(1.0,  c(p.accentCool));
    g.setPen(Qt::NoPen);
    g.setBrush(brand);
    g.drawRoundedRect(QRectF(head.left() + 8, head.top() + 6, 12, 12), 4, 4);
    g.setBrush(c(p.textStrong));
    g.drawRoundedRect(QRectF(head.left() + 25, head.top() + 8, 30, 3.5), 1.75, 1.75);
    g.setBrush(c(p.textFaint));
    g.drawRoundedRect(QRectF(head.left() + 25, head.top() + 14.5, 19, 2.5), 1.25, 1.25);
    g.setBrush(brand);                                     // the "New download" pill
    g.drawRoundedRect(QRectF(head.right() - 48, head.top() + 6, 40, 12), 5, 5);

    // --- Metrics strip -----------------------------------------------------
    const QRectF met(r.left(), head.bottom() + 1, r.width(), 27);
    g.fillRect(met, solid(p.surfaceAlt, ground));
    g.setPen(QPen(c(p.borderSubtle), 1));
    g.drawLine(met.bottomLeft(), met.bottomRight());
    for (int i = 0; i < 4; ++i) {
        const double x = met.left() + 9 + i * (met.width() - 14) / 4.0;
        if (i) {
            g.setPen(QPen(c(p.borderSubtle), 1));
            g.drawLine(QPointF(x - 6, met.top() + 5), QPointF(x - 6, met.bottom() - 5));
        }
        g.setPen(Qt::NoPen);
        g.setBrush(c(p.textFaint));
        g.drawRoundedRect(QRectF(x, met.top() + 6, 22, 2.5), 1.25, 1.25);
        if (i == 1) {
            // The SPEED tile: a real sparkline, in this theme's spark style.
            static const double kDemo[] = {0.20, 0.35, 0.30, 0.55, 0.50, 0.70, 0.62,
                                           0.85, 0.80, 0.95, 0.70, 0.90, 1.00, 0.85};
            QVector<double> demo;
            for (double v : kDemo) demo.append(v);
            motion::paintSpark(g, QRectF(x, met.top() + 11.5, 40, 10), demo, demo.size(),
                               c(p.accentCool), p);
        } else {
            g.setBrush(c(p.textStrong));
            g.drawRoundedRect(QRectF(x, met.top() + 12.5, 20, 7), 2, 2);
        }
    }

    // --- Download rows -----------------------------------------------------
    const QRectF list(r.left(), met.bottom() + 1, r.width(), r.bottom() - met.bottom() - 1);
    g.fillRect(list, solid(p.tableBg, ground));

    // pct < 0 is a download whose size isn't known yet: the loader animation.
    struct RowStyle { const QString &fg; const QString &bg; const QString &line; double pct; };
    const RowStyle rows[] = {
        { p.activeFg, p.activeBg, p.activeLine,  0.62 },
        { p.doneFg,   p.doneBg,   p.doneLine,    1.00 },
        { p.activeFg, p.activeBg, p.activeLine, -1.00 },
    };
    const double rowH = list.height() / 3.0;
    for (int i = 0; i < 3; ++i) {
        const QRectF row(list.left(), list.top() + i * rowH, list.width(), rowH);
        const QColor rowGround = solid(p.tableBg, ground);
        if (i == 0) {                                       // the selected row
            g.fillRect(row, solid(p.selectionBg, rowGround));
            g.setPen(QPen(c(p.selectionEdge), 1));
            g.drawLine(row.topLeft(), row.topRight());
            g.drawLine(row.bottomLeft(), row.bottomRight());
        } else {
            g.setPen(QPen(c(p.rowLine), 1));
            g.drawLine(row.bottomLeft(), row.bottomRight());
        }
        const double cy = row.center().y();
        g.setPen(Qt::NoPen);

        // File-type tile.
        const QColor tile = c(i == 1 ? p.doneFg : p.accentCool);
        QColor tileBg = tile; tileBg.setAlpha(46);
        g.setBrush(tileBg);
        g.drawRoundedRect(QRectF(row.left() + 9, cy - 7, 14, 14), 4, 4);

        // Name + host.
        g.setBrush(c(p.textStrong));
        g.drawRoundedRect(QRectF(row.left() + 29, cy - 6.5, 58 - i * 9, 3.5), 1.75, 1.75);
        g.setBrush(c(p.textFaint));
        g.drawRoundedRect(QRectF(row.left() + 29, cy + 1.5, 34, 2.5), 1.25, 1.25);

        // Progress track + the theme's fill / loader, exactly as the app draws it.
        const QRectF track(row.left() + 104, cy - 2, 68, 5);
        g.setBrush(c(p.progressTrack));
        g.drawRoundedRect(track, 2.5, 2.5);
        g.save();
        QPainterPath tclip;
        tclip.addRoundedRect(track, 2.5, 2.5);
        g.setClipPath(tclip, Qt::IntersectClip);
        if (rows[i].pct < 0.0)
            motion::paintLoader(g, track, kPreviewPhase, c(rows[i].fg), p);
        else if (i == 0)
            motion::paintFill(g, track, rows[i].pct, kPreviewPhase, c(rows[i].fg), p);
        else
            g.fillRect(QRectF(track.left(), track.top(), track.width() * rows[i].pct, track.height()),
                       c(rows[i].fg));
        g.restore();
        g.setPen(Qt::NoPen);

        // Status badge.
        const QRectF badge(row.right() - 46, cy - 6, 37, 12);
        g.setBrush(solid(rows[i].bg, rowGround));
        g.setPen(QPen(solid(rows[i].line, rowGround), 1));
        g.drawRoundedRect(badge, 4, 4);
        g.setPen(Qt::NoPen);
        g.setBrush(c(rows[i].fg));
        g.drawRoundedRect(QRectF(badge.left() + 6, cy - 1.5, badge.width() - 12, 3), 1.5, 1.5);
    }
}

} // namespace

// ---------------------------------------------------------------------------
// One selectable card.
// ---------------------------------------------------------------------------
class ThemeCard : public QWidget {
public:
    ThemeCard(const theme::ThemeInfo &info, QWidget *parent)
        : QWidget(parent), m_info(info)
    {
        setFixedSize(kCardW, kCardH);
        setCursor(Qt::PointingHandCursor);
        setFocusPolicy(Qt::StrongFocus);
        setAttribute(Qt::WA_Hover, true);
        // The auto card shows both halves of what it can resolve to.
        if (info.automatic) {
            m_palette     = theme::paletteFor(QStringLiteral("dark"));
            m_paletteAlt  = theme::paletteFor(QStringLiteral("light"));
            m_split       = true;
            m_motion      = tr("Moves like whichever theme it resolves to");
        } else {
            m_palette = theme::paletteFor(info.id);
            m_motion  = theme::describe(m_palette.motion);
        }
        setToolTip(info.tagline + QLatin1Char('\n') + m_motion);
    }

    const theme::ThemeInfo &info() const { return m_info; }
    void setSelected(bool on) { if (m_selected != on) { m_selected = on; update(); } }
    bool isSelected() const { return m_selected; }
    // Paid-plan themes stay visible and still render their real preview — the
    // point is to show what an upgrade buys, not to hide it.
    void setLocked(bool on) { if (m_locked != on) { m_locked = on; update(); } }
    bool isLocked() const { return m_locked; }

    std::function<void(const QString &)> onPick;      // single click / Space
    std::function<void(const QString &)> onCommit;    // double click / Return

protected:
    void paintEvent(QPaintEvent *) override
    {
        const theme::Palette &app = theme::current();
        QPainter g(this);
        g.setRenderHint(QPainter::Antialiasing, true);

        const QRectF card = QRectF(rect()).adjusted(1.5, 1.5, -1.5, -1.5);
        QPainterPath outline;
        outline.addRoundedRect(card, 13, 13);

        // Card body (label area) in the APP's colours, so the grid itself stays
        // coherent while each preview speaks for its own theme.
        g.fillPath(outline, QColor(app.menuBg));

        // Preview, clipped so it keeps the card's rounded top and a flat cut
        // where the label area begins.
        const QRectF pv(card.left(), card.top(), card.width(), kPreviewH);
        g.save();
        QPainterPath pvClip;
        pvClip.addRect(pv);
        g.setClipPath(outline.intersected(pvClip));
        if (m_split) {
            QPainterPath left;                 // diagonal split: dark ↘ light
            left.moveTo(pv.topLeft());
            left.lineTo(pv.topRight());
            left.lineTo(pv.bottomLeft());
            left.closeSubpath();
            g.save(); g.setClipPath(left, Qt::IntersectClip);
            paintPreview(g, pv, m_palette);
            g.restore();
            QPainterPath right;
            right.moveTo(pv.right(), pv.top());
            right.lineTo(pv.right(), pv.bottom());
            right.lineTo(pv.left(), pv.bottom());
            right.closeSubpath();
            g.save(); g.setClipPath(right, Qt::IntersectClip);
            paintPreview(g, pv, m_paletteAlt);
            g.restore();
            g.setPen(QPen(QColor(app.borderStrong), 1));
            g.drawLine(pv.topRight(), pv.bottomLeft());
        } else {
            paintPreview(g, pv, m_palette);
        }
        g.restore();

        g.setPen(QPen(QColor(app.borderSubtle), 1));
        g.drawLine(QPointF(card.left(), pv.bottom()), QPointF(card.right(), pv.bottom()));

        // --- Label -----------------------------------------------------------
        // The app stylesheet sets font-size in PIXELS, so pointSizeF() is -1
        // here; scale whichever unit this font actually carries.
        auto scaled = [this](double delta) {
            QFont f = font();
            if (f.pointSizeF() > 0) f.setPointSizeF(qMax(6.0, f.pointSizeF() + delta));
            else                    f.setPixelSize(qMax(8, f.pixelSize() + int(qRound(delta * 1.35))));
            return f;
        };

        QFont nameFont = scaled(0.5);
        nameFont.setWeight(QFont::DemiBold);
        g.setFont(nameFont);
        g.setPen(QColor(app.textStrong));
        const QRectF nameRect(card.left() + 13, pv.bottom() + 10, card.width() - 62, 17);
        g.drawText(nameRect, Qt::AlignLeft | Qt::AlignVCenter,
                   g.fontMetrics().elidedText(m_info.name, Qt::ElideRight, int(nameRect.width())));

        g.setFont(scaled(-1.5));
        g.setPen(QColor(app.textMuted));
        const QRectF subRect(card.left() + 13, pv.bottom() + 29, card.width() - 26, 14);
        g.drawText(subRect, Qt::AlignLeft | Qt::AlignVCenter,
                   g.fontMetrics().elidedText(m_info.tagline, Qt::ElideRight, int(subRect.width())));
        // How it moves — the part a colour swatch cannot show.
        g.setFont(scaled(-2.5));
        g.setPen(QColor(app.textFaint));
        const QRectF moRect(card.left() + 13, pv.bottom() + 44, card.width() - 26, 14);
        g.drawText(moRect, Qt::AlignLeft | Qt::AlignVCenter,
                   g.fontMetrics().elidedText(m_motion, Qt::ElideRight, int(moRect.width())));

        // --- Selected / hover chrome -----------------------------------------
        if (m_selected) {
            const QColor ring(app.accentMid);
            g.setPen(QPen(ring, 2));
            g.setBrush(Qt::NoBrush);
            g.drawRoundedRect(card.adjusted(-0.5, -0.5, 0.5, 0.5), 13, 13);

            const QRectF dot(card.right() - 34, pv.bottom() + 10, 20, 20);
            g.setPen(Qt::NoPen);
            g.setBrush(ring);
            g.drawEllipse(dot);
            QPen tick(QColor(app.accentText), 2.0);
            tick.setCapStyle(Qt::RoundCap);
            tick.setJoinStyle(Qt::RoundJoin);
            g.setPen(tick);
            QPainterPath check;
            check.moveTo(dot.left() + 5.5, dot.center().y() + 0.5);
            check.lineTo(dot.center().x() - 0.5, dot.bottom() - 6.0);
            check.lineTo(dot.right() - 5.0, dot.top() + 6.5);
            g.strokePath(check, tick);
        } else {
            g.setPen(QPen(QColor(m_hover || hasFocus() ? app.focus : app.border),
                          m_hover || hasFocus() ? 1.6 : 1.0));
            g.setBrush(Qt::NoBrush);
            g.drawRoundedRect(card, 13, 13);
        }

        // --- Locked (paid) badge ---------------------------------------------
        // Drawn last so it sits above the preview. The preview itself is left
        // untouched: a Free user should see exactly what they would get.
        if (m_locked) {
            QFont badgeFont = font();
            badgeFont.setBold(true);
            badgeFont.setPointSizeF(qMax(7.0, badgeFont.pointSizeF() - 1.5));
            g.setFont(badgeFont);
            const QString label = QStringLiteral("PRO");
            const int textW = QFontMetrics(badgeFont).horizontalAdvance(label);
            const QRectF pill(card.right() - textW - 26, card.top() + 9, textW + 16, 19);
            QPainterPath pillPath;
            pillPath.addRoundedRect(pill, 9.5, 9.5);
            g.setPen(Qt::NoPen);
            g.fillPath(pillPath, QColor(app.accentMid));
            g.setPen(QColor(app.accentText));
            g.drawText(pill, Qt::AlignCenter, label);
            g.setFont(font());
        }
    }

    void enterEvent(QEnterEvent *) override { m_hover = true;  update(); }
    void leaveEvent(QEvent *)      override { m_hover = false; update(); }
    void focusInEvent(QFocusEvent *e) override  { QWidget::focusInEvent(e);  update(); }
    void focusOutEvent(QFocusEvent *e) override { QWidget::focusOutEvent(e); update(); }

    void mousePressEvent(QMouseEvent *e) override
    {
        if (e->button() == Qt::LeftButton) {
            setFocus(Qt::MouseFocusReason);
            if (onPick) onPick(m_info.id);
        }
    }
    void mouseDoubleClickEvent(QMouseEvent *e) override
    {
        if (e->button() == Qt::LeftButton && onCommit) onCommit(m_info.id);
    }
    void keyPressEvent(QKeyEvent *e) override
    {
        if (e->key() == Qt::Key_Space) {
            if (onPick) onPick(m_info.id);
        } else if (e->key() == Qt::Key_Return || e->key() == Qt::Key_Enter) {
            if (onPick)   onPick(m_info.id);
            if (onCommit) onCommit(m_info.id);
        } else {
            QWidget::keyPressEvent(e);
        }
    }

private:
    theme::ThemeInfo m_info;
    theme::Palette   m_palette;
    theme::Palette   m_paletteAlt;
    QString          m_motion;      // "Arc gauge · area spark · comet loading"
    bool m_split = false;
    bool m_selected = false;
    bool m_hover = false;
    bool m_locked = false;
};

// ---------------------------------------------------------------------------
// The gallery.
// ---------------------------------------------------------------------------
ThemeGalleryDialog::ThemeGalleryDialog(QWidget *parent)
    : QDialog(parent)
{
    setWindowTitle(tr("Themes"));
    setModal(true);
    m_originalId = theme::savedId();
    m_selected   = m_originalId;

    auto *root = new QVBoxLayout(this);
    root->setContentsMargins(0, 0, 0, 0);
    root->setSpacing(0);

    // --- Title strip -------------------------------------------------------
    auto *head = new QWidget(this);
    head->setObjectName(QStringLiteral("HeaderBar"));
    auto *hv = new QVBoxLayout(head);
    hv->setContentsMargins(22, 16, 22, 14);
    hv->setSpacing(3);
    auto *title = new QLabel(tr("Themes"), head);
    title->setObjectName(QStringLiteral("BrandTitle"));
    int looks = 0;
    for (const theme::ThemeInfo &t : theme::available())
        if (!t.automatic) ++looks;
    auto *sub = new QLabel(tr("%1 looks, each with its own gauge, sparkline and loading animation. "
                              "Click one — it is applied straight away so you can see it live.").arg(looks), head);
    sub->setWordWrap(true);
    sub->setObjectName(QStringLiteral("Muted"));
    hv->addWidget(title);
    hv->addWidget(sub);

    auto *filters = new QHBoxLayout;
    filters->setSpacing(6);
    auto mkFilter = [&](const QString &text, Filter f) {
        auto *b = new QPushButton(text, head);
        b->setObjectName(QStringLiteral("Ghost"));
        b->setCheckable(true);
        b->setCursor(Qt::PointingHandCursor);
        connect(b, &QPushButton::clicked, this, [this, f]() { setFilter(f); });
        filters->addWidget(b);
        return b;
    };
    m_fAll   = mkFilter(tr("All"),   All);
    m_fDark  = mkFilter(tr("Dark"),  DarkOnly);
    m_fLight = mkFilter(tr("Light"), LightOnly);
    m_fAll->setChecked(true);
    filters->addStretch(1);
    m_search = new QLineEdit(head);
    m_search->setPlaceholderText(tr("Search themes…"));
    m_search->setClearButtonEnabled(true);
    m_search->setFixedWidth(230);
    connect(m_search, &QLineEdit::textChanged, this, [this](const QString &q) {
        m_query = q.trimmed();
        buildGrid();
    });
    filters->addWidget(m_search);
    hv->addSpacing(6);
    hv->addLayout(filters);
    root->addWidget(head);

    // --- Card grid ---------------------------------------------------------
    auto *scroll = new QScrollArea(this);
    scroll->setWidgetResizable(true);
    scroll->setFrameShape(QFrame::NoFrame);
    scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    m_gridHost = new QWidget(scroll);
    m_grid = new QGridLayout(m_gridHost);
    m_grid->setContentsMargins(22, 18, 22, 20);
    m_grid->setHorizontalSpacing(14);
    m_grid->setVerticalSpacing(16);
    scroll->setWidget(m_gridHost);
    root->addWidget(scroll, 1);

    // --- Footer ------------------------------------------------------------
    auto *foot = new QWidget(this);
    foot->setObjectName(QStringLiteral("Toolbar"));
    auto *fh = new QHBoxLayout(foot);
    fh->setContentsMargins(22, 12, 22, 12);
    fh->setSpacing(10);
    m_footNote = new QLabel(foot);
    m_footNote->setObjectName(QStringLiteral("Muted"));
    fh->addWidget(m_footNote, 1);
    auto *cancel = new QPushButton(tr("Cancel"), foot);
    auto *ok = new QPushButton(tr("Use this theme"), foot);
    ok->setObjectName(QStringLiteral("Primary"));
    ok->setDefault(true);
    ok->setCursor(Qt::PointingHandCursor);
    cancel->setCursor(Qt::PointingHandCursor);
    fh->addWidget(cancel);
    fh->addWidget(ok);
    root->addWidget(foot);

    connect(ok,     &QPushButton::clicked, this, &QDialog::accept);
    connect(cancel, &QPushButton::clicked, this, &QDialog::reject);
    // Cancel (or the window's X) puts the look the user arrived with back.
    connect(this, &QDialog::rejected, this, [this]() {
        if (theme::savedId() != m_originalId)
            applyLive(m_originalId);
        m_selected = m_originalId;
    });

    // Three columns on a laptop, four on a desktop — never so wide it overflows.
    QScreen *scr = screen() ? screen() : QGuiApplication::primaryScreen();
    if (scr)
        m_columns = qBound(2, (scr->availableGeometry().width() - 120) / (kCardW + 14), 4);

    buildGrid();
    updateFooter();

    const int w = m_columns * kCardW + (m_columns - 1) * 14 + 44 + 24;
    resize(w, 820);
    if (scr)
        resize(w, qMin(820, int(scr->availableGeometry().height() * 0.88)));
}

void ThemeGalleryDialog::buildGrid()
{
    m_cards.clear();
    while (QLayoutItem *item = m_grid->takeAt(0)) {
        if (QWidget *w = item->widget()) {
            w->setParent(nullptr);       // out of the layout now, gone next tick
            w->deleteLater();
        }
        delete item;
    }

    int row = 0, col = 0;
    auto addHeader = [&](const QString &text) {
        if (col != 0) { ++row; col = 0; }
        auto *l = new QLabel(text, m_gridHost);
        l->setObjectName(QStringLiteral("SectionHead"));
        m_grid->addWidget(l, row, 0, 1, m_columns);
        ++row;
    };
    auto addCard = [&](const theme::ThemeInfo &info) {
        auto *card = new ThemeCard(info, m_gridHost);
        card->setSelected(info.id == m_selected);
        // buildGrid() runs again on every search/filter change, so the lock
        // state has to be re-applied to each freshly created card.
        card->setLocked(!allowsTheme(info.id));
        card->onPick   = [this](const QString &id) { choose(id); };
        card->onCommit = [this](const QString &) { accept(); };
        m_grid->addWidget(card, row, col, Qt::AlignLeft | Qt::AlignTop);
        m_cards.append(card);
        if (++col == m_columns) { col = 0; ++row; }
    };

    // The search matches name, tagline, id and the motion description, so
    // "comet" or "needle" finds every theme that moves that way.
    auto matches = [this](const theme::ThemeInfo &t) {
        if (m_query.isEmpty())
            return true;
        QString hay = t.name + QLatin1Char(' ') + t.tagline + QLatin1Char(' ') + t.id;
        if (!t.automatic)
            hay += QLatin1Char(' ') + theme::describe(theme::paletteFor(t.id).motion);
        return hay.contains(m_query, Qt::CaseInsensitive);
    };
    const QVector<theme::ThemeInfo> &all = theme::available();
    auto group = [&](const QString &title, auto pred) {
        QVector<const theme::ThemeInfo *> hits;
        for (const theme::ThemeInfo &t : all)
            if (pred(t) && matches(t))
                hits.append(&t);
        if (hits.isEmpty())
            return;
        addHeader(hits.size() > 1 ? QStringLiteral("%1 · %2").arg(title).arg(hits.size()) : title);
        for (const theme::ThemeInfo *t : hits)
            addCard(*t);
    };
    if (m_filter == All)       group(tr("AUTOMATIC"), [](const theme::ThemeInfo &t) { return t.automatic; });
    if (m_filter != LightOnly) group(tr("DARK"),      [](const theme::ThemeInfo &t) { return !t.automatic && t.dark; });
    if (m_filter != DarkOnly)  group(tr("LIGHT"),     [](const theme::ThemeInfo &t) { return !t.automatic && !t.dark; });
    if (m_cards.isEmpty()) {
        auto *none = new QLabel(tr("No theme matches “%1”.").arg(m_query), m_gridHost);
        none->setObjectName(QStringLiteral("Muted"));
        m_grid->addWidget(none, row, 0, 1, m_columns);
        ++row;
    }
    if (col != 0) ++row;
    m_grid->setRowStretch(row, 1);
    m_grid->setColumnStretch(m_columns, 1);
}

void ThemeGalleryDialog::setFilter(Filter f)
{
    m_filter = f;
    m_fAll->setChecked(f == All);
    m_fDark->setChecked(f == DarkOnly);
    m_fLight->setChecked(f == LightOnly);
    buildGrid();
}

bool ThemeGalleryDialog::allowsTheme(const QString &id) const
{
    return m_allThemesAllowed || m_allowedThemeIds.contains(id, Qt::CaseInsensitive);
}

void ThemeGalleryDialog::setThemeEntitlement(bool allThemesAllowed, const QStringList &allowedIds)
{
    m_allThemesAllowed = allThemesAllowed;
    m_allowedThemeIds = allowedIds;
    for (ThemeCard *c : m_cards)
        c->setLocked(!allowsTheme(c->info().id));

    // If the saved theme is no longer licensed (a subscription lapsed while it
    // was in use), fall back to a permitted one rather than leaving the user on
    // a theme they can no longer keep.
    if (!allowsTheme(m_selected) && !m_allowedThemeIds.isEmpty()) {
        const QString fallback = m_allowedThemeIds.first();
        m_selected = fallback;
        for (ThemeCard *c : m_cards)
            c->setSelected(c->info().id == fallback);
        applyLive(fallback);
        updateFooter();
    }
}

void ThemeGalleryDialog::choose(const QString &id)
{
    // Locked themes never apply, not even briefly — a flash of a paid theme
    // followed by a snap-back reads as a bug.
    if (!allowsTheme(id)) {
        const theme::ThemeInfo *info = theme::find(id);
        emit lockedThemeChosen(id, info ? info->name : id);
        return;
    }
    if (id == m_selected && theme::savedId() == id)
        return;
    m_selected = id;
    for (ThemeCard *c : m_cards)
        c->setSelected(c->info().id == id);
    applyLive(id);
    updateFooter();
}

void ThemeGalleryDialog::applyLive(const QString &id)
{
    theme::setSavedId(id);
    if (auto *app = qobject_cast<QApplication *>(QCoreApplication::instance()))
        theme::apply(*app);
    // The previews draw with the app palette for their labels, so they all
    // need a repaint — and so does whoever opened us.
    for (ThemeCard *c : m_cards)
        c->update();
    emit themeApplied(id);
}

void ThemeGalleryDialog::updateFooter()
{
    const theme::ThemeInfo *t = theme::find(m_selected);
    if (!t) { m_footNote->clear(); return; }
    m_footNote->setText(t->automatic
        ? tr("Now showing: %1").arg(t->name)
        : tr("Now showing: %1 — %2").arg(t->name, theme::describe(theme::paletteFor(t->id).motion)));
}

} // namespace nexa
