#pragma once
#include <QDialog>

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
    void onUseBrowser();             // "use my logged-in browser" (no export)

private:
    void buildUi();

    DownloadEngine *m_engine;
    QComboBox *m_domain  = nullptr;   // editable, pre-seeded with the auth sites
    QComboBox *m_browser = nullptr;   // chrome / firefox / … for the live browser login
    QLabel    *m_status  = nullptr;   // green ok / red AuthResult.detail
};

} // namespace nexa
