#pragma once
#include <QMainWindow>
#include <QHash>
#include "core/Types.h"

class QTableWidget;
class QLabel;

namespace nexa {

class DownloadEngine;

// Main application window: a toolbar + a table of downloads with live
// progress/speed, driven entirely by DownloadEngine signals.
class MainWindow : public QMainWindow {
    Q_OBJECT
public:
    explicit MainWindow(DownloadEngine *engine, QWidget *parent = nullptr);

private slots:
    void promptAddUrl();
    void pauseSelected();
    void resumeSelected();
    void removeSelected();

    void onTaskAdded(int id);
    void onTaskProgress(int id, qint64 done, qint64 total, double bps);
    void onTaskStateChanged(int id, nexa::DownloadState state, const QString &detail);
    void onTaskFinished(int id);
    void onTaskRemoved(int id);

private:
    int  rowForId(int id) const;
    int  selectedId() const;
    void refreshRow(int id);

    DownloadEngine *m_engine;
    QTableWidget   *m_table;
    QLabel         *m_status;
    QHash<int, int> m_idToRow;   // task id -> table row
};

} // namespace nexa
