#include "ui/BatchDownloadDialog.h"
#include "core/DownloadEngine.h"

#include <QDialogButtonBox>
#include <QLabel>
#include <QListWidget>
#include <QPlainTextEdit>
#include <QPushButton>
#include <QUrl>
#include <QVBoxLayout>

namespace nexa {

BatchDownloadDialog::BatchDownloadDialog(DownloadEngine *engine, QWidget *parent)
    : QDialog(parent), m_engine(engine)
{
    setWindowTitle(tr("Batch download"));

    auto *outer = new QVBoxLayout(this);
    outer->setContentsMargins(14, 14, 14, 14);
    auto *plate = new QWidget(this);
    plate->setObjectName(QStringLiteral("Plate"));
    outer->addWidget(plate);
    auto *v = new QVBoxLayout(plate);
    v->setContentsMargins(18, 16, 18, 16);
    v->setSpacing(10);

    auto *intro = new QLabel(
        tr("One address per line. A numbered range in square brackets expands into "
           "one download each, and the zero-padding of the first number is kept:\n"
           "    https://example.com/scan[001-240].jpg"), plate);
    intro->setWordWrap(true);
    intro->setProperty("ddRole", "label");
    v->addWidget(intro);

    m_input = new QPlainTextEdit(plate);
    m_input->setPlaceholderText(QStringLiteral("https://example.com/part[1-20].zip"));
    m_input->setTabChangesFocus(true);
    v->addWidget(m_input, 1);

    m_count = new QLabel(plate);
    m_count->setWordWrap(true);
    v->addWidget(m_count);

    auto *previewLabel = new QLabel(tr("What will be queued"), plate);
    previewLabel->setProperty("ddRole", "label");
    v->addWidget(previewLabel);

    m_preview = new QListWidget(plate);
    m_preview->setSelectionMode(QAbstractItemView::NoSelection);
    m_preview->setFocusPolicy(Qt::NoFocus);
    m_preview->setMaximumHeight(190);
    v->addWidget(m_preview);

    m_buttons = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel, plate);
    v->addWidget(m_buttons);

    connect(m_input,   &QPlainTextEdit::textChanged,  this, &BatchDownloadDialog::refreshPreview);
    connect(m_buttons, &QDialogButtonBox::accepted,   this, &BatchDownloadDialog::queueThem);
    connect(m_buttons, &QDialogButtonBox::rejected,   this, &QDialog::reject);

    refreshPreview();
    resize(660, 520);
}

QStringList BatchDownloadDialog::expandInput(const QString &text, bool *truncated)
{
    if (truncated)
        *truncated = false;

    QStringList out;
    // Split on whitespace by hand rather than with a regular expression: the
    // pattern would be one backslash escape, and this loop cannot be mangled by
    // one. Same result, and it is the hot path for a 10,000 line paste.
    QStringList tokens;
    QString current;
    for (const QChar &c : text) {
        if (c.isSpace()) {
            if (!current.isEmpty()) { tokens.append(current); current.clear(); }
        } else {
            current.append(c);
        }
    }
    if (!current.isEmpty())
        tokens.append(current);
    for (const QString &token : tokens) {
        // Exactly the engine's expansion, not a second implementation of it:
        // a preview that disagreed with what gets queued would be worse than no
        // preview at all.
        for (const QString &expanded : DownloadEngine::expandPattern(token)) {
            if (out.size() >= kPreviewCeiling) {
                if (truncated)
                    *truncated = true;
                return out;
            }
            const bool hasScheme = expanded.contains(QLatin1String("://"))
                                || expanded.startsWith(QLatin1String("magnet:"), Qt::CaseInsensitive);
            const QUrl url = QUrl::fromUserInput(expanded);
            const QString scheme = url.scheme().toLower();
            // Mirror what addBatch() will accept, so the count is the truth and
            // not an optimistic guess that quietly drops half the list.
            if (!url.isValid())
                continue;
            if (scheme != QLatin1String("http") && scheme != QLatin1String("https")
                && scheme != QLatin1String("magnet"))
                continue;
            // QUrl::fromUserInput is deliberately generous: it turns the bare
            // word "just" into http://just, which is a valid URL with a valid
            // host. A batch box is exactly where somebody pastes a paragraph,
            // and without this every word in it became a download. A token is
            // only taken when it either spells its scheme out or names a host
            // with a dot in it -- which is every real address, and no prose.
            if (!hasScheme && !url.host().contains(QLatin1Char('.')))
                continue;
            out.append(expanded);
        }
    }
    return out;
}

void BatchDownloadDialog::refreshPreview()
{
    bool truncated = false;
    const QStringList urls = expandInput(m_input->toPlainText(), &truncated);

    m_preview->clear();
    for (int i = 0; i < urls.size() && i < kPreviewRows; ++i)
        m_preview->addItem(urls.at(i));
    // Show the LAST one too when the middle is elided. The end of a range is
    // where an off-by-one or a missing zero-pad actually shows up.
    if (urls.size() > kPreviewRows + 1) {
        m_preview->addItem(tr("... %n more ...", nullptr, urls.size() - kPreviewRows - 1));
        m_preview->addItem(urls.last());
    } else if (urls.size() == kPreviewRows + 1) {
        m_preview->addItem(urls.last());   // nothing elided, so say nothing
    }

    if (urls.isEmpty()) {
        m_count->setText(tr("Nothing to queue yet."));
    } else if (truncated) {
        m_count->setText(tr("More than %1 addresses - only the first %1 will be queued. "
                            "Narrow the range and add the rest afterwards.")
                             .arg(kPreviewCeiling));
    } else {
        m_count->setText(tr("%n download(s) will be queued.", nullptr, urls.size()));
    }
    m_buttons->button(QDialogButtonBox::Ok)->setEnabled(!urls.isEmpty());
    m_buttons->button(QDialogButtonBox::Ok)->setText(
        urls.isEmpty() ? tr("Add") : tr("Add %n download(s)", nullptr, urls.size()));
}

void BatchDownloadDialog::queueThem()
{
    bool truncated = false;
    const QStringList urls = expandInput(m_input->toPlainText(), &truncated);
    if (urls.isEmpty())
        return;

    // Hand over the already-expanded list rather than the raw text: the dialog
    // has capped it, and addBatch would otherwise expand the patterns a second
    // time and could queue more than the preview promised.
    //
    // userInitiated: the user confirmed this whole list here. Without it, "ask
    // before download" would raise one prompt per address.
    m_engine->addBatch(urls.join(QLatin1Char('\n')), {}, /*userInitiated=*/true);
    m_queued = urls;
    accept();
}

} // namespace nexa
