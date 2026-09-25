#pragma once
#include <QDialog>

class QComboBox;
class QLabel;

namespace nexa {

class DownloadEngine;

// "Site logins" — lend yt-dlp your browser's login for a login-gated site (Udemy,
// Vimeo, LinkedIn Learning, …) so it can download what you have access to, one
// video or lecture at a time. "Use browser login" registers a
// --cookies-from-browser credential for the site (for a Chromium browser, the
// profile most recently logged into it), so yt-dlp reads the live session on
// every run. Modal; the confirmation says what that login does on the chosen
// site: nothing on Coursera, Skillshare or Apple Music, nor for Chrome / Edge /
// Brave on Windows.
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
