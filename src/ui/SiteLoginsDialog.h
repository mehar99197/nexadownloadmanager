#pragma once
#include <QDialog>

class QLineEdit;
class QComboBox;
class QLabel;

namespace nexa {

class DownloadEngine;

// "Site logins" — register a Netscape cookies.txt for an auth-gated site (Udemy,
// Coursera, Vimeo, …) so yt-dlp can download courses you're enrolled in. Modal;
// validates the file eagerly via AuthenticationManager and reports the result.
class SiteLoginsDialog : public QDialog {
    Q_OBJECT
public:
    explicit SiteLoginsDialog(DownloadEngine *engine, QWidget *parent = nullptr);

private slots:
    void onBrowse();
    void onRegister();
    void onUseBrowser();             // "use my logged-in browser" (no export)
    void onBrowserChanged();         // repopulate the profile list for the new browser

private:
    void buildUi();
    // Fill m_profile with the chosen browser's profiles (Chromium-family: parsed
    // from its "Local State" file). First item is always the default profile
    // (empty data); detected non-default profiles follow, data = profile dir name.
    void populateProfiles();

    DownloadEngine *m_engine;
    QComboBox *m_domain  = nullptr;   // editable, pre-seeded with the auth sites
    QComboBox *m_browser = nullptr;   // chrome / firefox / … for --cookies-from-browser
    QComboBox *m_profile = nullptr;   // browser profile (data = dir name, "" = default)
    QLineEdit *m_path    = nullptr;   // read-only, filled by Browse
    QLabel    *m_status  = nullptr;   // green ok / red AuthResult.detail
};

} // namespace nexa
