#include "ui/MainWindow.h"
#include "core/DownloadEngine.h"
#include "core/DownloadTask.h"

#include <QTableWidget>
#include <QHeaderView>
#include <QToolBar>
#include <QAction>
#include <QStatusBar>
#include <QLabel>
#include <QProgressBar>
#include <QInputDialog>
#include <QMessageBox>
#include <QApplication>
#include <QClipboard>
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

enum Column { ColFile = 0, ColSize, ColProgress, ColSpeed, ColStatus, ColCount };

} // namespace

MainWindow::MainWindow(DownloadEngine *engine, QWidget *parent)
    : QMainWindow(parent), m_engine(engine)
{
    setWindowTitle(QStringLiteral("Nexa Download Manager"));
    resize(880, 480);

    auto *tb = addToolBar(QStringLiteral("Main"));
    tb->setMovable(false);
    auto *addAct    = tb->addAction(QStringLiteral("Add URL"));
    auto *pauseAct  = tb->addAction(QStringLiteral("Pause"));
    auto *resumeAct = tb->addAction(QStringLiteral("Resume"));
    auto *removeAct = tb->addAction(QStringLiteral("Remove"));

    connect(addAct,    &QAction::triggered, this, &MainWindow::promptAddUrl);
    connect(pauseAct,  &QAction::triggered, this, &MainWindow::pauseSelected);
    connect(resumeAct, &QAction::triggered, this, &MainWindow::resumeSelected);
    connect(removeAct, &QAction::triggered, this, &MainWindow::removeSelected);

    m_table = new QTableWidget(0, ColCount, this);
    m_table->setHorizontalHeaderLabels(
        {QStringLiteral("File"), QStringLiteral("Size"), QStringLiteral("Progress"),
         QStringLiteral("Speed"), QStringLiteral("Status")});
    m_table->horizontalHeader()->setStretchLastSection(true);
    m_table->horizontalHeader()->setSectionResizeMode(ColFile, QHeaderView::Stretch);
    m_table->horizontalHeader()->setSectionResizeMode(ColProgress, QHeaderView::Stretch);
    m_table->setSelectionBehavior(QAbstractItemView::SelectRows);
    m_table->setSelectionMode(QAbstractItemView::SingleSelection);
    m_table->setEditTriggers(QAbstractItemView::NoEditTriggers);
    m_table->verticalHeader()->setVisible(false);
    setCentralWidget(m_table);

    m_status = new QLabel(QStringLiteral("Ready"), this);
    statusBar()->addWidget(m_status);

    connect(m_engine, &DownloadEngine::taskAdded,        this, &MainWindow::onTaskAdded);
    connect(m_engine, &DownloadEngine::taskProgress,     this, &MainWindow::onTaskProgress);
    connect(m_engine, &DownloadEngine::taskStateChanged, this, &MainWindow::onTaskStateChanged);
    connect(m_engine, &DownloadEngine::taskFinished,     this, &MainWindow::onTaskFinished);
    connect(m_engine, &DownloadEngine::taskRemoved,      this, &MainWindow::onTaskRemoved);
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

    DownloadTask *t = m_engine->task(id);
    auto *fileItem = new QTableWidgetItem(t ? t->fileName() : QStringLiteral("download"));
    fileItem->setData(Qt::UserRole, id);
    m_table->setItem(row, ColFile, fileItem);
    m_table->setItem(row, ColSize, new QTableWidgetItem(QStringLiteral("?")));

    auto *bar = new QProgressBar(m_table);
    bar->setRange(0, 100);
    bar->setValue(0);
    bar->setTextVisible(true);
    m_table->setCellWidget(row, ColProgress, bar);

    m_table->setItem(row, ColSpeed, new QTableWidgetItem(QString()));
    m_table->setItem(row, ColStatus,
                     new QTableWidgetItem(t ? stateToString(t->state())
                                            : QStringLiteral("Queued")));
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
    }
    DownloadTask *t = m_engine->task(id);
    m_status->setText(QStringLiteral("%1: %2")
                          .arg(t ? t->fileName() : QStringLiteral("task"))
                          .arg(stateToString(state)));
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
}

} // namespace nexa
