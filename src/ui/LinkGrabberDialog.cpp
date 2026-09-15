#include "ui/LinkGrabberDialog.h"
#include "core/DownloadEngine.h"

#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QComboBox>
#include <QPushButton>
#include <QTableWidget>
#include <QHeaderView>
#include <QCheckBox>
#include <QUrl>
#include <QFileInfo>
#include <QSet>
#include <QMessageBox>

namespace nexa {

namespace {
// Extensions that mean "this is a file you'd download", lower-case, no dot.
const QSet<QString> &fileExtensions()
{
    static const QSet<QString> exts = {
        // archives / installers / images of disks
        QStringLiteral("zip"), QStringLiteral("rar"), QStringLiteral("7z"), QStringLiteral("tar"),
        QStringLiteral("gz"), QStringLiteral("tgz"), QStringLiteral("bz2"), QStringLiteral("xz"),
        QStringLiteral("exe"), QStringLiteral("msi"), QStringLiteral("dmg"), QStringLiteral("pkg"),
        QStringLiteral("deb"), QStringLiteral("rpm"), QStringLiteral("appimage"), QStringLiteral("iso"),
        QStringLiteral("img"), QStringLiteral("apk"), QStringLiteral("jar"),
        // media
        QStringLiteral("mp4"), QStringLiteral("mkv"), QStringLiteral("webm"), QStringLiteral("avi"),
        QStringLiteral("mov"), QStringLiteral("m4v"), QStringLiteral("mp3"), QStringLiteral("m4a"),
        QStringLiteral("flac"), QStringLiteral("wav"), QStringLiteral("aac"), QStringLiteral("ogg"),
        QStringLiteral("opus"), QStringLiteral("m3u8"), QStringLiteral("mpd"), QStringLiteral("ts"),
        // images
        QStringLiteral("jpg"), QStringLiteral("jpeg"), QStringLiteral("png"), QStringLiteral("gif"),
        QStringLiteral("webp"), QStringLiteral("bmp"), QStringLiteral("svg"), QStringLiteral("tiff"),
        QStringLiteral("psd"), QStringLiteral("raw"),
        // documents
        QStringLiteral("pdf"), QStringLiteral("epub"), QStringLiteral("doc"), QStringLiteral("docx"),
        QStringLiteral("xls"), QStringLiteral("xlsx"), QStringLiteral("ppt"), QStringLiteral("pptx"),
        QStringLiteral("csv"), QStringLiteral("txt"), QStringLiteral("srt"),
        // torrents / misc
        QStringLiteral("torrent"), QStringLiteral("bin"), QStringLiteral("dat"),
    };
    return exts;
}

QString extensionOf(const QString &url)
{
    const QString path = QUrl(url).path();
    const QString last = path.section(QLatin1Char('/'), -1);
    const int dot = last.lastIndexOf(QLatin1Char('.'));
    if (dot <= 0 || dot == last.size() - 1)
        return QString();
    const QString ext = last.mid(dot + 1).toLower();
    return ext.size() <= 8 ? ext : QString();
}
} // namespace

bool LinkGrabberDialog::looksLikeFile(const QString &url)
{
    return fileExtensions().contains(extensionOf(url));
}

QString LinkGrabberDialog::displayName(const LinkItem &item)
{
    const QString last = QUrl(item.url).path().section(QLatin1Char('/'), -1);
    if (!last.isEmpty() && (looksLikeFile(item.url) || item.text.isEmpty()))
        return QUrl::fromPercentEncoding(last.toUtf8());
    if (!item.text.isEmpty())
        return item.text;
    return QUrl(item.url).host();
}

LinkGrabberDialog::LinkGrabberDialog(DownloadEngine *engine, const QString &pageUrl,
                                     const QString &pageTitle, const QVector<LinkItem> &links,
                                     const HeaderList &headers, QWidget *parent)
    : QDialog(parent), m_engine(engine), m_links(links), m_headers(headers)
{
    setWindowTitle(tr("Download links from page"));
    setAttribute(Qt::WA_DeleteOnClose);
    setWindowFlags(Qt::Window | Qt::CustomizeWindowHint | Qt::WindowTitleHint
                   | Qt::WindowSystemMenuHint | Qt::WindowMinimizeButtonHint
                   | Qt::WindowMaximizeButtonHint | Qt::WindowCloseButtonHint);
    resize(880, 560);

    auto *outer = new QVBoxLayout(this);
    outer->setContentsMargins(14, 14, 14, 14);
    auto *plate = new QWidget(this);
    plate->setObjectName(QStringLiteral("Plate"));
    outer->addWidget(plate);
    auto *v = new QVBoxLayout(plate);
    v->setContentsMargins(18, 16, 18, 16);
    v->setSpacing(10);

    // The page title comes from the page, by way of the extension. PlainText.
    auto *title = new QLabel(pageTitle.isEmpty() ? QStringLiteral("Links found on page") : pageTitle, plate);
    title->setObjectName(QStringLiteral("Dd_title"));
    title->setTextFormat(Qt::PlainText);
    title->setWordWrap(true);
    auto *sub = new QLabel(tr("%1 link%2 on %3")
                               .arg(links.size()).arg(links.size() == 1 ? QString() : QStringLiteral("s"))
                               .arg(QUrl(pageUrl).host().isEmpty() ? QStringLiteral("this page") : QUrl(pageUrl).host()),
                           plate);
    sub->setObjectName(QStringLiteral("Dd_host"));
    v->addWidget(title);
    v->addWidget(sub);

    // Filter row
    auto *filterRow = new QHBoxLayout;
    m_search = new QLineEdit(plate);
    m_search->setPlaceholderText(tr("Filter by name, URL or extension…"));
    m_search->setClearButtonEnabled(true);
    m_kind = new QComboBox(plate);
    m_kind->addItem(tr("Files only"), QStringLiteral("files"));
    m_kind->addItem(tr("Everything"), QStringLiteral("all"));
    m_kind->addItem(tr("Images"), QStringLiteral("image"));
    m_kind->addItem(tr("Video & audio"), QStringLiteral("media"));
    m_kind->addItem(tr("Other links"), QStringLiteral("other"));
    auto *all = new QPushButton(tr("Select all"), plate);
    auto *none = new QPushButton(tr("Select none"), plate);
    for (auto *b : {all, none})
        b->setCursor(Qt::PointingHandCursor);
    filterRow->addWidget(m_search, 1);
    filterRow->addWidget(m_kind);
    filterRow->addWidget(all);
    filterRow->addWidget(none);
    v->addLayout(filterRow);

    // Table
    m_table = new QTableWidget(links.size(), 4, plate);
    m_table->setHorizontalHeaderLabels({QStringLiteral("Name"), QStringLiteral("Type"),
                                        QStringLiteral("Host"), QStringLiteral("URL")});
    m_table->verticalHeader()->setVisible(false);
    m_table->setSelectionBehavior(QAbstractItemView::SelectRows);
    m_table->setEditTriggers(QAbstractItemView::NoEditTriggers);
    m_table->setShowGrid(false);
    m_table->horizontalHeader()->setStretchLastSection(true);
    m_table->horizontalHeader()->setSectionResizeMode(0, QHeaderView::Interactive);
    m_table->setColumnWidth(0, 300);
    m_table->setColumnWidth(1, 80);
    m_table->setColumnWidth(2, 160);
    for (int i = 0; i < links.size(); ++i) {
        const LinkItem &it = links.at(i);
        auto *nameItem = new QTableWidgetItem(displayName(it));
        nameItem->setFlags((nameItem->flags() | Qt::ItemIsUserCheckable) & ~Qt::ItemIsEditable);
        const bool preTick = it.kind != QLatin1String("link") || looksLikeFile(it.url);
        nameItem->setCheckState(preTick ? Qt::Checked : Qt::Unchecked);
        nameItem->setToolTip(it.url);
        const QString ext = extensionOf(it.url);
        auto *typeItem = new QTableWidgetItem(!ext.isEmpty() ? ext.toUpper()
                                              : it.kind == QLatin1String("image") ? QStringLiteral("image")
                                              : it.kind == QLatin1String("media") ? QStringLiteral("media")
                                              : QStringLiteral("link"));
        auto *hostItem = new QTableWidgetItem(QUrl(it.url).host());
        auto *urlItem = new QTableWidgetItem(it.url);
        urlItem->setToolTip(it.url);
        m_table->setItem(i, 0, nameItem);
        m_table->setItem(i, 1, typeItem);
        m_table->setItem(i, 2, hostItem);
        m_table->setItem(i, 3, urlItem);
    }
    v->addWidget(m_table, 1);

    // Footer
    auto *footer = new QHBoxLayout;
    m_summary = new QLabel(plate);
    m_summary->setProperty("ddRole", "label");
    auto *cancel = new QPushButton(tr("Cancel"), plate);
    m_download = new QPushButton(tr("Download selected"), plate);
    m_download->setObjectName(QStringLiteral("Primary"));
    for (auto *b : {cancel, m_download})
        b->setCursor(Qt::PointingHandCursor);
    footer->addWidget(m_summary, 1);
    footer->addWidget(cancel);
    footer->addWidget(m_download);
    v->addLayout(footer);

    connect(m_search, &QLineEdit::textChanged, this, &LinkGrabberDialog::applyFilter);
    connect(m_kind, &QComboBox::currentIndexChanged, this, &LinkGrabberDialog::applyFilter);
    connect(all, &QPushButton::clicked, this, [this]() { setVisibleChecked(true); });
    connect(none, &QPushButton::clicked, this, [this]() { setVisibleChecked(false); });
    connect(m_table, &QTableWidget::itemChanged, this, [this](QTableWidgetItem *) { updateSummary(); });
    connect(cancel, &QPushButton::clicked, this, &QDialog::reject);
    connect(m_download, &QPushButton::clicked, this, &LinkGrabberDialog::downloadSelected);

    applyFilter();
}

void LinkGrabberDialog::applyFilter()
{
    const QString q = m_search->text().trimmed().toLower();
    const QString mode = m_kind->currentData().toString();
    for (int row = 0; row < m_table->rowCount(); ++row) {
        const LinkItem &it = m_links.at(row);
        bool show = true;
        if (mode == QLatin1String("files"))
            show = it.kind != QLatin1String("link") || looksLikeFile(it.url);
        else if (mode == QLatin1String("image"))
            show = it.kind == QLatin1String("image");
        else if (mode == QLatin1String("media"))
            show = it.kind == QLatin1String("media");
        else if (mode == QLatin1String("other"))
            show = it.kind == QLatin1String("link") && !looksLikeFile(it.url);
        if (show && !q.isEmpty()) {
            const QString hay = (m_table->item(row, 0)->text() + QLatin1Char(' ') + it.url
                                 + QLatin1Char(' ') + m_table->item(row, 1)->text()).toLower();
            show = hay.contains(q);
        }
        m_table->setRowHidden(row, !show);
    }
    updateSummary();
}

void LinkGrabberDialog::setVisibleChecked(bool on)
{
    m_table->blockSignals(true);
    for (int row = 0; row < m_table->rowCount(); ++row)
        if (!m_table->isRowHidden(row))
            m_table->item(row, 0)->setCheckState(on ? Qt::Checked : Qt::Unchecked);
    m_table->blockSignals(false);
    updateSummary();
}

void LinkGrabberDialog::updateSummary()
{
    int visible = 0, checked = 0;
    for (int row = 0; row < m_table->rowCount(); ++row) {
        if (m_table->isRowHidden(row))
            continue;
        ++visible;
        if (m_table->item(row, 0)->checkState() == Qt::Checked)
            ++checked;
    }
    m_summary->setText(tr("%1 of %2 shown selected").arg(checked).arg(visible));
    m_download->setEnabled(checked > 0);
    m_download->setText(checked > 0 ? QStringLiteral("Download %1 selected").arg(checked)
                                    : QStringLiteral("Download selected"));
}

void LinkGrabberDialog::downloadSelected()
{
    int added = 0;
    for (int row = 0; row < m_table->rowCount(); ++row) {
        if (m_table->isRowHidden(row) || m_table->item(row, 0)->checkState() != Qt::Checked)
            continue;
        const LinkItem &it = m_links.at(row);
        // userInitiated: the user ticked it here, so no second confirm prompt.
        // publicNetworkOnly: these targets came from a web page.
        const int id = m_engine->addDownload(QUrl(it.url), QString(), m_headers, QString(), QString(),
                                             false, /*userInitiated=*/true, QString(),
                                             /*publicNetworkOnly=*/true);
        if (id >= 0)
            ++added;
    }
    if (added == 0) {
        QMessageBox::warning(this, QStringLiteral("Nothing added"),
                             QStringLiteral("None of the selected links could be queued."));
        return;
    }
    accept();
}

} // namespace nexa
