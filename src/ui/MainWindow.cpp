#include "ui/MainWindow.h"
#include "core/DownloadEngine.h"
#include "core/DownloadTask.h"

#include <QTableWidget>
#include <QHeaderView>
#include <QPushButton>
#include <QStatusBar>
#include <QLabel>
#include <QProgressBar>
#include <QInputDialog>
#include <QMessageBox>
#include <QApplication>
#include <QClipboard>
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QWidget>
#include <QIcon>
#include <QColor>
#include <QUrl>

namespace nexa {

namespace {

QString humanSize(qint64 bytes)
{
    if (bytes < 0) return QStringLiteral("?");
    const char *units[] = {"B", "KB", "MB", "GB", "TB"};
    double v = double(bytes);
    int u = 0;
    while (v >= 1024.0 && u < 4) { v /= 1024.0; ++u; }
    return QStringLiteral("%1 %2").arg(v, 0, 'f', (u == 0 ? 0 : 1)).arg(units[u]);
}

QString humanSpeed(double bps)
{
    if (bps < 1.0) return QString();
    return humanSize(qint64(bps)) + QStringLiteral("/s");
}

// A distinct colour per lifecycle state for the Status column.
QColor statusColor(DownloadState s)
{
    switch (s) {
        case DownloadState::Completed:   return QColor(0x22c55e);  // green
        case DownloadState::Downloading: return QColor(0x60a5fa);  // blue
        case DownloadState::Probing:     return QColor(0x38bdf8);  // cyan
        case DownloadState::Paused:      return QColor(0xfbbf24);  // amber
        case DownloadState::Error:       return QColor(0xf87171);  // red
        case DownloadState::Queued:      return QColor(0x94a3b8);  // grey
    }
    return QColor(0xe2e8f0);
}

enum Column { ColFile = 0, ColSize, ColProgress, ColSpeed, ColStatus, ColCount };

} // namespace

MainWindow::MainWindow(DownloadEngine *engine, QWidget *parent)
    : QMainWindow(parent), m_engine(engine)
{
    setWindowTitle(QStringLiteral("Nexa Download Manager"));
    setWindowIcon(QIcon(QStringLiteral(":/nexa.png")));
    resize(960, 540);

    auto *central = new QWidget(this);
    auto *root = new QVBoxLayout(central);
    root->setContentsMargins(0, 0, 0, 0);
    root->setSpacing(0);

    // ---- Brand header: logo + title on the left, live stats on the right ----
    auto *header = new QWidget(central);
    header->setObjectName(QStringLiteral("HeaderBar"));
    auto *hl = new QHBoxLayout(header);
    hl->setContentsMargins(16, 12, 16, 12);

    auto *logo = new QLabel(header);
    logo->setPixmap(QIcon(QStringLiteral(":/nexa.png")).pixmap(26, 26));
    auto *title = new QLabel(QStringLiteral("Nexa Download Manager"), header);
    title->setObjectName(QStringLiteral("BrandTitle"));
    m_statsLabel = new QLabel(QString(), header);
    m_statsLabel->setObjectName(QStringLiteral("Stats"));

    hl->addWidget(logo);
    hl->addSpacing(8);
    hl->addWidget(title);
    hl->addStretch(1);
    hl->addWidget(m_statsLabel);
    root->addWidget(header);

    // ---- Action bar: primary buttons ----
    auto *actions = new QWidget(central);
    actions->setObjectName(QStringLiteral("ActionBar"));
    auto *al = new QHBoxLayout(actions);
    al->setContentsMargins(12, 8, 12, 8);
    al->setSpacing(8);

    auto makeBtn = [&](const QString &text, const char *obj) {
        auto *b = new QPushButton(text, actions);
        b->setObjectName(QString::fromLatin1(obj));
        b->setCursor(Qt::PointingHandCursor);
        al->addWidget(b);
        return b;
    };
    auto *addBtn    = makeBtn(QStringLiteral("  ＋  Add Download  "), "Primary");
    auto *aiBtn     = makeBtn(QStringLiteral("🤖  Smart Add"), "");
    auto *pauseBtn  = makeBtn(QStringLiteral("⏸  Pause"), "");
    auto *resumeBtn = makeBtn(QStringLiteral("▶  Resume"), "");
    auto *removeBtn = makeBtn(QStringLiteral("✕  Remove"), "");
    al->addStretch(1);
    root->addWidget(actions);

    connect(addBtn,    &QPushButton::clicked, this, &MainWindow::promptAddUrl);
    connect(aiBtn,     &QPushButton::clicked, this, &MainWindow::promptSmartAdd);
    connect(pauseBtn,  &QPushButton::clicked, this, &MainWindow::pauseSelected);
    connect(resumeBtn, &QPushButton::clicked, this, &MainWindow::resumeSelected);
    connect(removeBtn, &QPushButton::clicked, this, &MainWindow::removeSelected);

    // ---- Downloads table ----
    m_table = new QTableWidget(0, ColCount, central);
    m_table->setHorizontalHeaderLabels(
        {QStringLiteral("File"), QStringLiteral("Size"), QStringLiteral("Progress"),
         QStringLiteral("Speed"), QStringLiteral("Status")});
    m_table->horizontalHeader()->setStretchLastSection(true);
    m_table->horizontalHeader()->setSectionResizeMode(ColFile, QHeaderView::Stretch);
    m_table->horizontalHeader()->setSectionResizeMode(ColProgress, QHeaderView::Stretch);
    m_table->horizontalHeader()->setHighlightSections(false);
    m_table->setSelectionBehavior(QAbstractItemView::SelectRows);
    m_table->setSelectionMode(QAbstractItemView::SingleSelection);
    m_table->setEditTriggers(QAbstractItemView::NoEditTriggers);
    m_table->setShowGrid(false);
    m_table->setAlternatingRowColors(true);
    m_table->verticalHeader()->setVisible(false);
    m_table->verticalHeader()->setDefaultSectionSize(38);
    root->addWidget(m_table, 1);

    setCentralWidget(central);

    m_status = new QLabel(QStringLiteral("Ready"), this);
    statusBar()->addWidget(m_status);

    connect(m_engine, &DownloadEngine::taskAdded,        this, &MainWindow::onTaskAdded);
    connect(m_engine, &DownloadEngine::taskProgress,     this, &MainWindow::onTaskProgress);
    connect(m_engine, &DownloadEngine::taskStateChanged, this, &MainWindow::onTaskStateChanged);
    connect(m_engine, &DownloadEngine::taskFinished,     this, &MainWindow::onTaskFinished);
    connect(m_engine, &DownloadEngine::taskRemoved,      this, &MainWindow::onTaskRemoved);
    connect(m_engine, &DownloadEngine::taskRenamed,      this, &MainWindow::onTaskRenamed);

    updateStats();
}

void MainWindow::updateStats()
{
    int active = 0;
    double totalSpeed = 0.0;
    for (const auto &s : m_engine->snapshot()) {
        if (s.state == DownloadState::Downloading || s.state == DownloadState::Probing) {
            ++active;
            totalSpeed += s.speed;
        }
    }
    const QString spd = totalSpeed > 1.0 ? humanSpeed(totalSpeed) : QStringLiteral("idle");
    m_statsLabel->setText(QStringLiteral("%1 active   ·   %2").arg(active).arg(spd));
}

void MainWindow::promptAddUrl()
{
    // Pre-fill from clipboard if it looks like a URL — small IDM-like nicety.
    QString preset = QApplication::clipboard()->text().trimmed();
    if (!(preset.startsWith(QStringLiteral("http://")) ||
          preset.startsWith(QStringLiteral("https://")) ||
          preset.startsWith(QStringLiteral("ftp://"))))
        preset.clear();

    bool ok = false;
    const QString text = QInputDialog::getText(
        this, QStringLiteral("Add Download"),
        QStringLiteral("Enter URL:"), QLineEdit::Normal, preset, &ok);
    if (!ok || text.trimmed().isEmpty())
        return;

    const int id = m_engine->addDownload(QUrl::fromUserInput(text.trimmed()));
    if (id < 0)
        QMessageBox::warning(this, QStringLiteral("Invalid URL"),
                             QStringLiteral("That URL could not be parsed."));
}

void MainWindow::promptSmartAdd()
{
    if (!m_engine->aiAvailable()) {
        QMessageBox::information(
            this, QStringLiteral("Smart Add (AI)"),
            QStringLiteral("AI features need an Anthropic API key.\n\n"
                           "Set ANTHROPIC_API_KEY in your environment and restart Nexa, e.g.:\n"
                           "    export ANTHROPIC_API_KEY=sk-ant-...\n    ./nexa"));
        return;
    }
    bool ok = false;
    const QString text = QInputDialog::getText(
        this, QStringLiteral("Smart Add (AI)"),
        QStringLiteral("Describe what to download (URLs, and optionally when):"),
        QLineEdit::Normal, QString(), &ok);
    if (ok && !text.trimmed().isEmpty())
        m_engine->runAiCommand(text.trimmed());
}

int MainWindow::rowForId(int id) const
{
    return m_idToRow.value(id, -1);
}

int MainWindow::selectedId() const
{
    const auto rows = m_table->selectionModel()->selectedRows();
    if (rows.isEmpty())
        return -1;
    const int row = rows.first().row();
    QTableWidgetItem *it = m_table->item(row, ColFile);
    return it ? it->data(Qt::UserRole).toInt() : -1;
}

void MainWindow::pauseSelected()
{
    const int id = selectedId();
    if (id >= 0) m_engine->pause(id);
}

void MainWindow::resumeSelected()
{
    const int id = selectedId();
    if (id >= 0) m_engine->resume(id);
}

void MainWindow::removeSelected()
{
    const int id = selectedId();
    if (id < 0)
        return;
    const auto reply = QMessageBox::question(
        this, QStringLiteral("Remove Download"),
        QStringLiteral("Remove this download from the list?\n"
                       "(The partially downloaded file is kept.)"));
    if (reply == QMessageBox::Yes)
        m_engine->remove(id, false);
}

void MainWindow::onTaskAdded(int id)
{
    if (rowForId(id) >= 0)
        return;
    const int row = m_table->rowCount();
    m_table->insertRow(row);
    m_idToRow.insert(id, row);

    auto *fileItem = new QTableWidgetItem(m_engine->nameOf(id));
    fileItem->setData(Qt::UserRole, id);
    m_table->setItem(row, ColFile, fileItem);
    m_table->setItem(row, ColSize, new QTableWidgetItem(QStringLiteral("?")));

    auto *bar = new QProgressBar(m_table);
    bar->setRange(0, 100);
    bar->setValue(0);
    bar->setTextVisible(true);
    m_table->setCellWidget(row, ColProgress, bar);

    m_table->setItem(row, ColSpeed, new QTableWidgetItem(QString()));
    const DownloadState st = m_engine->stateOf(id);
    auto *statusItem = new QTableWidgetItem(stateToString(st));
    statusItem->setForeground(statusColor(st));
    m_table->setItem(row, ColStatus, statusItem);
    updateStats();
}

void MainWindow::onTaskProgress(int id, qint64 done, qint64 total, double bps)
{
    const int row = rowForId(id);
    if (row < 0)
        return;

    if (auto *sizeItem = m_table->item(row, ColSize))
        sizeItem->setText(total > 0 ? humanSize(total) : humanSize(done));

    if (auto *bar = qobject_cast<QProgressBar*>(m_table->cellWidget(row, ColProgress))) {
        if (total > 0) {
            const int pct = int((done * 100) / total);
            bar->setRange(0, 100);
            bar->setValue(pct);
            bar->setFormat(QStringLiteral("%1%  (%2 / %3)")
                               .arg(pct).arg(humanSize(done), humanSize(total)));
        } else {
            bar->setRange(0, 0);                 // busy indicator for unknown size
            bar->setFormat(humanSize(done));
        }
    }
    if (auto *speedItem = m_table->item(row, ColSpeed))
        speedItem->setText(humanSpeed(bps));

    updateStats();
}

void MainWindow::onTaskStateChanged(int id, DownloadState state, const QString &detail)
{
    const int row = rowForId(id);
    if (row < 0)
        return;
    if (auto *statusItem = m_table->item(row, ColStatus)) {
        QString s = stateToString(state);
        if (!detail.isEmpty())
            s += QStringLiteral(" — ") + detail;
        statusItem->setText(s);
        statusItem->setForeground(statusColor(state));
    }
    m_status->setText(QStringLiteral("%1: %2")
                          .arg(m_engine->nameOf(id))
                          .arg(stateToString(state)));
    updateStats();
}

void MainWindow::onTaskFinished(int id)
{
    const int row = rowForId(id);
    if (row < 0)
        return;
    if (auto *bar = qobject_cast<QProgressBar*>(m_table->cellWidget(row, ColProgress))) {
        bar->setRange(0, 100);
        bar->setValue(100);
        bar->setFormat(QStringLiteral("100%"));
    }
    if (auto *speedItem = m_table->item(row, ColSpeed))
        speedItem->setText(QString());
    updateStats();
}

void MainWindow::onTaskRenamed(int id, const QString &newName)
{
    const int row = rowForId(id);
    if (row < 0)
        return;
    if (auto *fileItem = m_table->item(row, ColFile))
        fileItem->setText(newName);
    m_status->setText(QStringLiteral("Renamed to %1").arg(newName));
}

void MainWindow::onTaskRemoved(int id)
{
    const int row = rowForId(id);
    if (row < 0)
        return;
    m_table->removeRow(row);
    m_idToRow.remove(id);
    // Row indices below the removed one shift up by one.
    for (auto it = m_idToRow.begin(); it != m_idToRow.end(); ++it) {
        if (it.value() > row)
            it.value() -= 1;
    }
    updateStats();
}

} // namespace nexa
