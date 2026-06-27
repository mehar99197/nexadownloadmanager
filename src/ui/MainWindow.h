#pragma once
#include <QMainWindow>
#include <QHash>
#include <QSet>
#include <QPointer>
#include "core/Types.h"

class QTableWidget;
class QStackedWidget;
class QLabel;
class QLineEdit;
class QPushButton;
class QSystemTrayIcon;
class QCloseEvent;

namespace nexa {

class DownloadEngine;
class DownloadDetailsDialog;
class ClipboardMonitor;
class UpdateChecker;

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
    void pauseAll();
    void resumeAll();
    void clearCompleted();           // drop all finished downloads from the list
    void removeSelected();
    void openDownloadFolder();
    void onSiteLogins();             // register a cookies.txt for an auth-gated site
    void onSettings();               // open the Preferences dialog
    void onCheckUpdates();           // manual "Check for updates…"
    void setClipboardMonitoring(bool on);   // toggle IDM-style link capture (persisted)
    void onClipboardUrl(const QUrl &url);   // a download-able URL was copied; offer it
    void openDetails(int id);        // open or raise the per-download details plate
    void showConfirmPrompt(int id);  // IDM-style "ask before download" for a held add
    void showCompleteDialog(int id); // IDM-style "download complete" prompt
    void applyFilter(const QString &text);
    void showFilterMenu();           // toolbar "Filter" — limit the list by state
    void showSortMenu();             // toolbar "Sort" — reorder the visible rows

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
    QList<int> currentOrder() const;          // ids in present row order
    void rebuildInOrder(const QList<int> &order);  // re-lay the table in a new order
    void moveRow(int from, int to);           // reorder one row (drag or menu)
    void moveSelected(int delta);             // menu: shift selection up/down
    void updateStats();              // refresh header pill + footer summary
    void updateEmptyState();         // show the empty page when there are no downloads
    void refreshFileCell(int row, int id);
    void setRowStatus(int row, nexa::DownloadState state, const QString &detail);
    void showRowMenu(const QPoint &pos);
    QWidget *buildActionsCell(int id);        // per-row pause/resume + more buttons
    void showRowMenuFor(int id, const QPoint &globalPos);   // menu for one task id

    DownloadEngine *m_engine;
    QTableWidget   *m_table = nullptr;
    QStackedWidget *m_content = nullptr;      // swaps table <-> empty-state page
    QLineEdit      *m_search = nullptr;
    QLabel         *m_footerLeft = nullptr;
    QPushButton    *m_footerClear = nullptr;  // bottom-right "Clear completed downloads"
    QLabel         *m_footerRight = nullptr;

    // Dashboard metric tiles (updated live in updateStats()).
    QLabel *m_metActiveVal = nullptr, *m_metActiveSub = nullptr;
    QLabel *m_metSpeedVal  = nullptr, *m_metSpeedSub  = nullptr;
    QLabel *m_metDoneVal   = nullptr, *m_metDoneSub   = nullptr;
    QLabel *m_metStoreVal  = nullptr, *m_metStoreSub  = nullptr;

    // Toolbar "Filter": -1 = all, else only show rows in this DownloadState.
    int m_stateFilter = -1;
    // Count of downloads that completed during THIS session (metrics "+N").
    int m_completedThisSession = 0;
    QSet<int> m_countedDone;   // ids already counted, so a re-emit doesn't double-count
    QHash<int, int> m_idToRow;   // task id -> table row
    QHash<int, QString> m_stateDetail;  // last state detail per id (survives sort/rebuild)

    QHash<int, QPointer<DownloadDetailsDialog>> m_openDialogs;  // one plate per id
    QSet<int>       m_autoOpened;   // ids that already auto-popped (dedupe, lifetime)
    bool            m_restoring = false;  // true during startup snapshot replay
    QSystemTrayIcon *m_tray = nullptr;    // background/tray presence (may be null)
    ClipboardMonitor *m_clipboard = nullptr;          // IDM-style link capture
    QPointer<QWidget> m_captureToast;                 // at most one toast on screen
    QPointer<QWidget> m_settingsDlg;                  // single non-modal Settings window
    UpdateChecker    *m_updates = nullptr;            // version-check (not auto-install)
    bool              m_manualUpdateCheck = false;    // menu check vs silent startup check
};

} // namespace nexa
