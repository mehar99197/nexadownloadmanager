#pragma once
#include <QWizard>
#include <QStringList>

class QLineEdit;
class QCheckBox;
class QLabel;
class QPushButton;
namespace nexa::motion { class ThemedBar; }

namespace nexa {

class DownloadEngine;

// First-launch setup: pick the download folder, confirm the browser extension
// is wired up, and run a short test download to see the engine in action. Shown
// once (Settings key firstRunDone); reachable later via Tools → Setup guide…
class FirstRunWizard : public QWizard {
    Q_OBJECT
public:
    explicit FirstRunWizard(DownloadEngine *engine, QWidget *parent = nullptr);

    static bool shouldShow();   // never completed on this machine
    static void markDone();

    // Browsers with a profile on this machine (for the "extension" page).
    static QStringList detectedBrowsers();

protected:
    void accept() override;

private:
    QWizardPage *welcomePage();
    QWizardPage *browserPage();
    QWizardPage *testPage();
    void startTestDownload();

    DownloadEngine *m_engine;
    QLineEdit    *m_dir = nullptr;
    QCheckBox    *m_categorize = nullptr;
    QCheckBox    *m_notify = nullptr;
    QCheckBox    *m_clipboard = nullptr;
    QLabel       *m_testStatus = nullptr;
    nexa::motion::ThemedBar *m_testBar = nullptr;
    QPushButton  *m_testBtn = nullptr;
    int           m_testId = -1;
    bool          m_testWired = false;   // engine signals connected once
    qint64        m_testStartedMs = 0;
};

} // namespace nexa
