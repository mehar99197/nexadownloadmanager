#pragma once
#include <QDialog>

class QLineEdit;
class QSpinBox;
class QDoubleSpinBox;
class QCheckBox;
class QLabel;
class QComboBox;

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

signals:
    // Fired after Save: everything is persisted and applied to the engine.
    // MainWindow forwards it so main() can re-apply dashboard settings.
    void settingsApplied();

signals:
    // A theme was previewed or committed from this dialog (live stylesheet
    // change) — MainWindow repaints the widgets it draws itself.
    void themeChanged();

private:
    void apply();   // push the dialog's values to the engine + QSettings
    // Show a theme immediately so it can be judged; Cancel puts back whatever
    // was in force when the dialog opened.
    void applyThemePreview(const QString &id);
    // Grey out the themes this licence does not include and snap the selection
    // back if the one in force stopped being allowed. Runs when the dialog is
    // built and again whenever entitlements change, so a lapsed subscription
    // does not leave a paid theme selectable.
    void refreshThemeEntitlement();
    // True when this licence may use `id`. Mirrors ThemeGalleryDialog.
    bool allowsTheme(const QString &id) const;

    QString m_themeOnOpen;   // restored if the dialog is cancelled

    DownloadEngine *m_engine;

    QLineEdit      *m_dir = nullptr;
    QCheckBox      *m_categorize = nullptr;
    QCheckBox      *m_clipboard = nullptr;
    QCheckBox      *m_confirmStart = nullptr;   // IDM-style ask-before-download
    QCheckBox      *m_showComplete = nullptr;   // IDM-style completion prompt
    QCheckBox      *m_notify = nullptr;         // tray/desktop notifications
    QCheckBox      *m_autoUpdate = nullptr;     // silent daily update check
    QComboBox      *m_whenDone = nullptr;       // post-download action
    QCheckBox      *m_dashEnabled = nullptr;    // remote web dashboard
    QSpinBox       *m_dashPort = nullptr;
    QCheckBox      *m_dashLan = nullptr;
    QComboBox      *m_theme = nullptr;
    QComboBox      *m_language = nullptr;
    QComboBox      *m_proxyMode = nullptr;
    QLineEdit      *m_proxyHost = nullptr;
    QSpinBox       *m_proxyPort = nullptr;
    QLineEdit      *m_proxyUser = nullptr;
    QLineEdit      *m_proxyPass = nullptr;
    QLabel         *m_dashUrl = nullptr;        // current URL (+token) or "not running"
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
    QCheckBox      *m_virusScan = nullptr;
    QLineEdit      *m_virusCmd = nullptr;
    QCheckBox      *m_errLog = nullptr;     // opt-in troubleshooting log to a file
    QLineEdit      *m_licenseKey = nullptr;
    QLabel         *m_licenseStatus = nullptr;
};

} // namespace nexa
