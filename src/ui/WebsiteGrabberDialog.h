#pragma once
#include <QDialog>
#include "grabber/SiteCrawler.h"

class QLineEdit;
class QSpinBox;
class QComboBox;
class QCheckBox;
class QPushButton;
class QProgressBar;
class QLabel;
class QTableWidget;
class QGroupBox;

namespace nexa {

class DownloadEngine;

// Dialog for configuring and running a website grab.
class WebsiteGrabberDialog : public QDialog {
    Q_OBJECT
public:
    explicit WebsiteGrabberDialog(DownloadEngine* engine, QWidget* parent = nullptr);
    ~WebsiteGrabberDialog() override;
    
    // Pre-fill URL from browser extension or clipboard
    void setUrl(const QString& url);
    
private slots:
    void onStartGrabbing();
    void onPauseResume();
    void onCancel();
    void onBrowseFolder();
    void onPresetChanged(int index);
    
    void onPageCrawled(const QUrl& url, int filesFound);
    void onFileFound(const QUrl& fileUrl, const QString& mimeType, qint64 size);
    void onFileDownloaded(const CrawlFileResult& result);
    void onFileFailed(const QUrl& fileUrl, const QString& error);
    void onProgress(int pagesCrawled, int filesFound, int filesDownloaded);
    void onFinished(const CrawlSummary& summary);
    
private:
    void setupUi();
    void setupConnections();
    void updateUiForStatus(CrawlStatus status);
    CrawlConfig buildConfig() const;
    void addRecentFile(const QString& status, const QString& name, const QString& detail);
    
    DownloadEngine* m_engine;
    SiteCrawler* m_crawler = nullptr;
    
    // Config tab
    QLineEdit* m_urlEdit = nullptr;
    QComboBox* m_presetCombo = nullptr;
    QLineEdit* m_includeEdit = nullptr;
    QLineEdit* m_excludeEdit = nullptr;
    QSpinBox* m_depthSpin = nullptr;
    QSpinBox* m_maxFilesSpin = nullptr;
    QCheckBox* m_sameDomainCheck = nullptr;
    QCheckBox* m_preserveStructureCheck = nullptr;
    QLineEdit* m_folderEdit = nullptr;
    QPushButton* m_browseBtn = nullptr;
    QPushButton* m_startBtn = nullptr;
    
    // Progress tab
    QLabel* m_statusLabel = nullptr;
    QProgressBar* m_progressBar = nullptr;
    QLabel* m_statsLabel = nullptr;
    QTableWidget* m_recentFilesTable = nullptr;
    QPushButton* m_pauseResumeBtn = nullptr;
    QPushButton* m_cancelBtn = nullptr;
    
    // Results
    QLabel* m_resultLabel = nullptr;
};

} // namespace nexa