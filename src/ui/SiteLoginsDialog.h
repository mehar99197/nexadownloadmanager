#pragma once
#include <QDialog>

class QComboBox;
class QLabel;

namespace nexa {

class DownloadEngine;

// "Site logins" — lend yt-dlp your browser's login for an auth-gated site (Udemy,
// Coursera, Vimeo, …) so it can download courses you're enrolled in. "Use browser
// login" registers a --cookies-from-browser credential for the site (for a
// Chromium browser, the profile most recently logged into it), so yt-dlp reads
// the live session on every run. Modal; shows AuthenticationManager's verdict.
class SiteLoginsDialog : public QDialog {
    Q_OBJECT
public:
    explicit SiteLoginsDialog(DownloadEngine *engine, QWidget *parent = nullptr);

private slots:
    void onUseBrowser();             // "use my logged-in browser" (no export)

private:
    void buildUi();

    DownloadEngine *m_engine;
    QComboBox *m_domain  = nullptr;   // editable, pre-seeded with the auth sites
    QComboBox *m_browser = nullptr;   // chrome / firefox / … for the live browser login
    QLabel    *m_status  = nullptr;   // green ok / red AuthResult.detail
};

} // namespace nexa
