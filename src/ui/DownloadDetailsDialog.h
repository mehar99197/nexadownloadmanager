#pragma once
#include <QDialog>
#include <QString>
#include "core/Types.h"

class QLabel;
class QPushButton;
class QTableWidget;
class QTimer;

namespace nexa {

class DownloadEngine;
class ConnStrip;
class FlowBar;
class SpeedMeter;
class SpeedGraph;

// Per-download "details plate" — Nexa's themed analogue of IDM's Download-status
// window. Shows URL/status/size/speed/ETA/resume, an overall progress bar, the
// "start positions and progress by connections" strip, and a per-connection
// table (for segmented HTTP downloads). One non-modal window per task id.
class DownloadDetailsDialog : public QDialog {
    Q_OBJECT
public:
    DownloadDetailsDialog(DownloadEngine *engine, int id, QWidget *parent = nullptr);

private slots:
    void onProgress(int id, qint64 done, qint64 total, double bps);
    void onStateChanged(int id, nexa::DownloadState state, const QString &detail);
    void onRenamed(int id, const QString &newName);
    void onRemoved(int id);
    void onTick();                 // 500ms while segmented + active: poll segments

private:
    void buildUi();
    void refreshHeader();          // tile, title, host, state pill
    void refreshFields();          // url / status / size / done / rate / eta / resume
    void refreshOverallBar();
    void refreshConnections();     // strip + table
    void updateButtons();
    bool isSegmented() const;      // task(id) && rangesSupported && segments > 1
    void syncTimer();              // start/stop the poll timer for the current state

    DownloadEngine *m_engine;
    int     m_id;
    QString m_url;                 // captured once (full URL for HTTP, host otherwise)
    qint64  m_done = 0;
    qint64  m_total = -1;
    double  m_bps = 0.0;
    DownloadState m_state = DownloadState::Queued;
    QString m_detail;
    int     m_phase = 0;           // drives the indeterminate strip pulse

    // header
    QLabel *m_tile = nullptr, *m_title = nullptr, *m_host = nullptr, *m_pill = nullptr;
    // field values
    QLabel *m_vUrl = nullptr, *m_vStatus = nullptr, *m_vSize = nullptr, *m_vDone = nullptr,
           *m_vRate = nullptr, *m_vEta = nullptr, *m_vResume = nullptr;
    // progress + connections
    FlowBar      *m_bar = nullptr;
    SpeedMeter   *m_speedMeter = nullptr;
    SpeedGraph   *m_speedGraph = nullptr;
    QLabel *m_barPct = nullptr, *m_connCount = nullptr;
    ConnStrip *m_strip = nullptr;
    QTableWidget *m_table = nullptr;
    // buttons
    QPushButton *m_pause = nullptr, *m_resume = nullptr, *m_cancel = nullptr;
    QTimer *m_tick = nullptr;
};

} // namespace nexa
