#pragma once
#include <QDialog>

class QLineEdit;
class QSpinBox;
class QDoubleSpinBox;
class QCheckBox;

namespace nexa {

class DownloadEngine;

// A themed Preferences dialog surfacing every runtime tunable in one place:
// download folder, concurrency, the global HTTP speed cap, HLS stream
// connections, subtitle embedding, BitTorrent caps + seed ratio, AI rename,
// auto-categorise and clipboard monitoring. Values load from the engine /
// QSettings and, on OK, are applied to the engine live and persisted.
class SettingsDialog : public QDialog {
    Q_OBJECT
public:
    explicit SettingsDialog(DownloadEngine *engine, QWidget *parent = nullptr);

    // Read persisted settings from QSettings and apply them to the engine.
    // Called once at startup (before CLI flags, which may override).
    static void loadInto(DownloadEngine *engine);

private:
    void apply();   // push the dialog's values to the engine + QSettings

    DownloadEngine *m_engine;

    QLineEdit      *m_dir = nullptr;
    QCheckBox      *m_categorize = nullptr;
    QCheckBox      *m_clipboard = nullptr;
    QSpinBox       *m_maxConc = nullptr;
    QSpinBox       *m_speedKB = nullptr;       // 0 = unlimited
    QSpinBox       *m_streamConc = nullptr;
    QSpinBox       *m_plConc = nullptr;        // playlist videos in parallel
    QCheckBox      *m_subs = nullptr;
    QLineEdit      *m_subLangs = nullptr;
    QSpinBox       *m_torrentDlKB = nullptr;
    QSpinBox       *m_torrentUlKB = nullptr;
    QDoubleSpinBox *m_seedRatio = nullptr;
    QCheckBox      *m_aiRename = nullptr;
    QCheckBox      *m_errLog = nullptr;     // opt-in troubleshooting log to a file
};

} // namespace nexa
