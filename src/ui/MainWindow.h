#pragma once
#include <QMainWindow>
#include <QHash>
#include <QSet>
#include <QPointer>
#include "core/Types.h"

class QTableWidget;
class QLabel;
class QLineEdit;
class QSystemTrayIcon;
class QCloseEvent;

namespace nexa {

class DownloadEngine;
class DownloadDetailsDialog;

// Main application window: a header + action bar + a table of downloads with
// live progress/speed and a summary footer, driven entirely by DownloadEngine
// signals. Styled to match the NexaDL redesign mockup.
class MainWindow : public QMainWindow {
    Q_OBJECT
public:
    explicit MainWindow(DownloadEngine *engine, QWidget *parent = nullptr);

    // Create a system-tray presence so the app can run in the background without
    // a visible window. Returns true if a system tray is available (and the icon
    // was installed); false otherwise, so the caller can fall back gracefully.
    bool setupTray();
    bool hasTray() const { return m_tray != nullptr; }

public slots:
    // Bring the window to the foreground (used by the single-instance guard and
    // the IPC "show" command). Safe to call when already visible.
    void showAndRaise();

protected:
    void closeEvent(QCloseEvent *event) override;   // minimise to tray if present

private slots:
    void promptAddUrl();
    void promptSmartAdd();           // natural-language AI add
    void pauseAll();
    void resumeAll();
    void removeSelected();
    void openDownloadFolder();
    void onSiteLogins();             // register a cookies.txt for an auth-gated site
    void openDetails(int id);        // open or raise the per-download details plate
    void applyFilter(const QString &text);

    void onTaskAdded(int id);
    void onTaskProgress(int id, qint64 done, qint64 total, double bps);
    void onTaskStateChanged(int id, nexa::DownloadState state, const QString &detail);
    void onTaskFinished(int id);
    void onTaskRemoved(int id);
    void onTaskRenamed(int id, const QString &newName);

private:
    int  rowForId(int id) const;
    int  selectedId() const;
    int  idAtRow(int row) const;
    void updateStats();              // refresh header pill + footer summary
    void refreshFileCell(int row, int id);
    void setRowStatus(int row, nexa::DownloadState state, const QString &detail);
    void showRowMenu(const QPoint &pos);

    DownloadEngine *m_engine;
    QTableWidget   *m_table = nullptr;
    QLineEdit      *m_search = nullptr;
    QLabel         *m_activePill = nullptr;   // "N active" header pill
    QLabel         *m_footerLeft = nullptr;
    QLabel         *m_footerRight = nullptr;
    QHash<int, int> m_idToRow;   // task id -> table row

    QHash<int, QPointer<DownloadDetailsDialog>> m_openDialogs;  // one plate per id
    QSet<int>       m_autoOpened;   // ids that already auto-popped (dedupe, lifetime)
    bool            m_restoring = false;  // true during startup snapshot replay
    QSystemTrayIcon *m_tray = nullptr;    // background/tray presence (may be null)
};

} // namespace nexa
