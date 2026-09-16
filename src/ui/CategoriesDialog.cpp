#include "ui/CategoriesDialog.h"
#include "core/DownloadEngine.h"

#include <QAbstractItemModel>
#include <QDialogButtonBox>
#include <QDir>
#include <QFileDialog>
#include <QFileInfo>
#include <QFormLayout>
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QListWidget>
#include <QMessageBox>
#include <QPushButton>
#include <QUrl>
#include <QVBoxLayout>

namespace nexa {

namespace {

// The rules of a category, in one line, for the list and the detail label.
QString ruleSummary(const Category &c)
{
    QStringList bits;
    if (!c.sites.isEmpty())
        bits << QObject::tr("%n site(s)", nullptr, int(c.sites.size()));
    if (!c.extensions.isEmpty())
        bits << QObject::tr("%n file type(s)", nullptr, int(c.extensions.size()));
    if (bits.isEmpty())
        return QObject::tr("everything not claimed above");
    return bits.join(QStringLiteral(" + "));
}

QString listLabel(const Category &c)
{
    const QString icon = c.icon.trimmed();
    const QString name = icon.isEmpty() ? c.name : (icon + QLatin1Char(' ') + c.name);
    return QStringLiteral("%1  -  %2").arg(name, ruleSummary(c));
}

// Split a free-text rule field. Commas, semicolons and whitespace all separate,
// because every one of them is what somebody will actually type.
QStringList splitRules(const QString &text)
{
    QString flat = text;
    for (QChar &ch : flat) {
        if (ch == QLatin1Char(',') || ch == QLatin1Char(';') || ch.isSpace())
            ch = QLatin1Char(' ');
    }
    return flat.split(QLatin1Char(' '), Qt::SkipEmptyParts);
}

} // namespace

CategoriesDialog::CategoriesDialog(DownloadEngine *engine, QWidget *parent)
    : QDialog(parent), m_engine(engine)
{
    setWindowTitle(tr("Download Categories"));
    resize(640, 500);
    buildUi();
    reload();
}

void CategoriesDialog::buildUi()
{
    auto *outer = new QVBoxLayout(this);
    outer->setContentsMargins(14, 14, 14, 14);

    auto *plate = new QWidget(this);
    plate->setObjectName(QStringLiteral("Plate"));
    outer->addWidget(plate);

    auto *v = new QVBoxLayout(plate);
    v->setContentsMargins(18, 16, 18, 16);
    v->setSpacing(12);

    auto *title = new QLabel(tr("Download Categories"), plate);
    title->setObjectName(QStringLiteral("Dd_title"));
    v->addWidget(title);

    auto *hint = new QLabel(
        tr("Checked from the top down - the first category whose site or file type matches a "
           "download claims it. Drag a row to change that order."), plate);
    hint->setProperty("ddRole", "label");
    hint->setWordWrap(true);
    v->addWidget(hint);

    m_list = new QListWidget(plate);
    m_list->setDragDropMode(QAbstractItemView::InternalMove);
    m_list->setSelectionMode(QAbstractItemView::SingleSelection);
    m_list->setAlternatingRowColors(true);
    m_list->setAccessibleName(tr("Categories, in priority order"));
    v->addWidget(m_list, 1);

    m_detail = new QLabel(plate);
    m_detail->setProperty("ddRole", "value");
    m_detail->setWordWrap(true);
    m_detail->setMinimumHeight(38);
    v->addWidget(m_detail);

    auto *row = new QHBoxLayout;
    auto *add = new QPushButton(tr("Add..."), plate);
    add->setObjectName(QStringLiteral("Primary"));
    add->setCursor(Qt::PointingHandCursor);
    m_edit = new QPushButton(tr("Edit..."), plate);
    m_edit->setCursor(Qt::PointingHandCursor);
    m_delete = new QPushButton(tr("Delete"), plate);
    m_delete->setCursor(Qt::PointingHandCursor);
    row->addWidget(add);
    row->addWidget(m_edit);
    row->addWidget(m_delete);
    row->addStretch(1);
    auto *close = new QPushButton(tr("Close"), plate);
    close->setCursor(Qt::PointingHandCursor);
    row->addWidget(close);
    v->addLayout(row);

    connect(add,      &QPushButton::clicked, this, &CategoriesDialog::addCategory);
    connect(m_edit,   &QPushButton::clicked, this, &CategoriesDialog::editSelected);
    connect(m_delete, &QPushButton::clicked, this, &CategoriesDialog::deleteSelected);
    connect(close,    &QPushButton::clicked, this, &QDialog::accept);
    connect(m_list,   &QListWidget::itemSelectionChanged, this, [this] {
        updateButtons();
        showPreview();
    });
    connect(m_list,   &QListWidget::itemDoubleClicked, this, &CategoriesDialog::editSelected);
    // A drop has already moved the row by the time the model reports it, so the
    // new visual order is simply read back and renumbered.
    connect(m_list->model(), &QAbstractItemModel::rowsMoved, this, [this] {
        if (!m_reloading)
            persistOrder();
    });
}

void CategoriesDialog::reload()
{
    const int keepId = selectedCategory().id;
    m_reloading = true;
    m_list->clear();
    for (const Category &c : m_engine->categories().all()) {
        auto *item = new QListWidgetItem(listLabel(c), m_list);
        item->setData(Qt::UserRole, c.id);
        if (c.builtin)
            item->setToolTip(tr("Built in - editable, but it cannot be deleted."));
    }
    m_reloading = false;
    for (int i = 0; i < m_list->count(); ++i) {
        if (m_list->item(i)->data(Qt::UserRole).toInt() == keepId) {
            m_list->setCurrentRow(i);
            break;
        }
    }
    if (m_list->currentRow() < 0 && m_list->count() > 0)
        m_list->setCurrentRow(0);
    updateButtons();
    showPreview();
}

Category CategoriesDialog::selectedCategory() const
{
    if (!m_list)
        return Category();
    QListWidgetItem *item = m_list->currentItem();
    if (!item)
        return Category();
    const Category *c = m_engine->categories().byId(item->data(Qt::UserRole).toInt());
    return c ? *c : Category();
}

void CategoriesDialog::updateButtons()
{
    const Category c = selectedCategory();
    const bool have = c.id > 0;
    m_edit->setEnabled(have);
    // The seeded set stays: those are the folders already sitting in the user's
    // download directory, and the rule-less one is where everything unmatched
    // goes. Deleting that would leave downloads with nowhere to fall through to.
    m_delete->setEnabled(have && !c.builtin);
}

void CategoriesDialog::showPreview()
{
    const Category c = selectedCategory();
    if (c.id <= 0) {
        m_detail->clear();
        return;
    }
    const QString folder = c.resolvedFolder(m_engine->downloadDir());
    QStringList lines;
    lines << tr("Saves to: %1").arg(QDir::toNativeSeparators(folder));
    if (!c.sites.isEmpty())
        lines << tr("Sites: %1").arg(c.sites.join(QStringLiteral(", ")));
    if (!c.extensions.isEmpty()) {
        QStringList dotted;
        for (const QString &e : c.extensions)
            dotted << QLatin1Char('.') + e;
        lines << tr("File types: %1").arg(dotted.join(QStringLiteral(" ")));
    }
    m_detail->setText(lines.join(QLatin1Char('\n')));
}

void CategoriesDialog::persistOrder()
{
    QVector<Category> ordered;
    ordered.reserve(m_list->count());
    for (int i = 0; i < m_list->count(); ++i) {
        const int id = m_list->item(i)->data(Qt::UserRole).toInt();
        if (const Category *c = m_engine->categories().byId(id))
            ordered.push_back(*c);
    }
    m_engine->saveCategoryOrder(ordered);
    reload();
}

void CategoriesDialog::addCategory()
{
    Category cat;
    cat.priority = m_engine->categories().nextPriority();
    if (!editCategory(cat, true))
        return;
    if (!m_engine->saveCategory(cat)) {
        QMessageBox::warning(this, tr("Download Categories"),
                             tr("That category could not be saved."));
        return;
    }
    reload();
}

void CategoriesDialog::editSelected()
{
    Category cat = selectedCategory();
    if (cat.id <= 0)
        return;
    if (!editCategory(cat, false))
        return;
    if (!m_engine->saveCategory(cat)) {
        QMessageBox::warning(this, tr("Download Categories"),
                             tr("That category could not be saved."));
        return;
    }
    reload();
}

void CategoriesDialog::deleteSelected()
{
    const Category cat = selectedCategory();
    if (cat.id <= 0 || cat.builtin)
        return;
    const auto answer = QMessageBox::question(
        this, tr("Delete category"),
        tr("Delete \"%1\"?\n\nFiles already downloaded stay where they are. New downloads that "
           "matched it will fall through to the category below.").arg(cat.name),
        QMessageBox::Yes | QMessageBox::No, QMessageBox::No);
    if (answer != QMessageBox::Yes)
        return;
    if (!m_engine->removeCategory(cat.id)) {
        QMessageBox::warning(this, tr("Download Categories"),
                             tr("That category could not be deleted."));
        return;
    }
    reload();
}

bool CategoriesDialog::editCategory(Category &cat, bool isNew)
{
    QDialog dlg(this);
    dlg.setWindowTitle(isNew ? tr("New category") : tr("Edit category"));

    auto *outer = new QVBoxLayout(&dlg);
    outer->setContentsMargins(14, 14, 14, 14);
    auto *plate = new QWidget(&dlg);
    plate->setObjectName(QStringLiteral("Plate"));
    outer->addWidget(plate);
    auto *v = new QVBoxLayout(plate);
    v->setContentsMargins(18, 16, 18, 16);
    v->setSpacing(10);

    auto *form = new QFormLayout;
    auto *name = new QLineEdit(cat.name, plate);
    name->setMinimumWidth(320);
    auto *icon = new QLineEdit(cat.icon, plate);
    icon->setMaxLength(8);
    icon->setPlaceholderText(tr("An emoji"));

    auto *folderRow = new QWidget(plate);
    auto *folderLay = new QHBoxLayout(folderRow);
    folderLay->setContentsMargins(0, 0, 0, 0);
    auto *folder = new QLineEdit(cat.folder, folderRow);
    folder->setPlaceholderText(tr("Blank = a folder named after the category"));
    auto *browse = new QPushButton(tr("Browse..."), folderRow);
    browse->setCursor(Qt::PointingHandCursor);
    folderLay->addWidget(folder, 1);
    folderLay->addWidget(browse);

    QStringList dotted;
    for (const QString &e : cat.extensions)
        dotted << QLatin1Char('.') + e;
    auto *exts = new QLineEdit(dotted.join(QStringLiteral(" ")), plate);
    exts->setPlaceholderText(QStringLiteral(".mp4 .mkv .avi"));
    auto *sites = new QLineEdit(cat.sites.join(QStringLiteral(" ")), plate);
    sites->setPlaceholderText(QStringLiteral("youtube.com vimeo.com"));

    form->addRow(tr("Name"), name);
    form->addRow(tr("Icon"), icon);
    form->addRow(tr("Folder"), folderRow);
    form->addRow(tr("File types"), exts);
    form->addRow(tr("Sites"), sites);
    v->addLayout(form);

    auto *note = new QLabel(
        tr("A site rule covers its subdomains: \"youtube.com\" also claims m.youtube.com. "
           "Leave both rules blank and the category only catches what nothing else did."),
        plate);
    note->setProperty("ddRole", "label");
    note->setWordWrap(true);
    v->addWidget(note);

    auto *box = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel, plate);
    v->addWidget(box);
    connect(box, &QDialogButtonBox::rejected, &dlg, &QDialog::reject);
    connect(browse, &QPushButton::clicked, &dlg, [this, folder, &dlg] {
        const QString start = folder->text().trimmed().isEmpty()
                                  ? m_engine->downloadDir()
                                  : folder->text().trimmed();
        const QString picked = QFileDialog::getExistingDirectory(&dlg, tr("Category folder"), start);
        if (picked.isEmpty())
            return;
        // Keep it relative when it sits under the download folder: the user can
        // then move their Downloads directory and every category follows.
        const QString base = QDir(m_engine->downloadDir()).absolutePath();
        const QString abs  = QDir(picked).absolutePath();
        if (abs.startsWith(base + QLatin1Char('/')))
            folder->setText(abs.mid(base.size() + 1));
        else
            folder->setText(QDir::toNativeSeparators(abs));
    });
    connect(box, &QDialogButtonBox::accepted, &dlg, [this, &dlg, name, &cat] {
        const QString trimmed = name->text().trimmed();
        if (trimmed.isEmpty()) {
            QMessageBox::warning(&dlg, tr("Edit category"), tr("A category needs a name."));
            return;
        }
        // Two categories sharing a name would make the table column and the
        // filter menu ambiguous, and their folders would collide on disk.
        const Category *clash = m_engine->categories().byName(trimmed);
        if (clash && clash->id != cat.id) {
            QMessageBox::warning(&dlg, tr("Edit category"),
                                 tr("\"%1\" already exists.").arg(trimmed));
            return;
        }
        dlg.accept();
    });

    if (dlg.exec() != QDialog::Accepted)
        return false;

    cat.name   = name->text().trimmed();
    cat.icon   = icon->text().trimmed();
    cat.folder = folder->text().trimmed();

    cat.extensions.clear();
    for (const QString &raw : splitRules(exts->text())) {
        const QString ext = Category::normalizeExtension(raw);
        if (!ext.isEmpty() && !cat.extensions.contains(ext))
            cat.extensions << ext;
    }
    cat.sites.clear();
    for (const QString &raw : splitRules(sites->text())) {
        // Accept a pasted URL as well as a bare host: a full URL is what lands
        // on the clipboard, and asking the user to strip it by hand is the kind
        // of small friction that makes a feature go unused.
        QString host = raw.trimmed().toLower();
        if (host.contains(QStringLiteral("://")))
            host = QUrl(host).host();
        if (host.startsWith(QLatin1String("www.")))
            host = host.mid(4);
        if (!host.isEmpty() && !cat.sites.contains(host))
            cat.sites << host;
    }
    return true;
}

} // namespace nexa
