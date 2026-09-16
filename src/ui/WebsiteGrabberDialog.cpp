#include "ui/WebsiteGrabberDialog.h"

#include <QMessageBox>
#include "core/DownloadEngine.h"

#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QFormLayout>
#include <QLineEdit>
#include <QSpinBox>
#include <QComboBox>
#include <QCheckBox>
#include <QPushButton>
#include <QProgressBar>
#include <QLabel>
#include <QTableWidget>
#include <QHeaderView>
#include <QFileDialog>
#include <QGroupBox>
#include <QStandardPaths>

namespace nexa {

WebsiteGrabberDialog::WebsiteGrabberDialog(DownloadEngine* engine, QWidget* parent)
    : QDialog(parent), m_engine(engine)
{
    setupUi();
    setupConnections();
    m_crawler = new SiteCrawler(engine, this);
    
    connect(m_crawler, &SiteCrawler::pageCrawled, this, &WebsiteGrabberDialog::onPageCrawled);
    connect(m_crawler, &SiteCrawler::fileDownloaded, this, &WebsiteGrabberDialog::onFileDownloaded);
    connect(m_crawler, &SiteCrawler::fileFound, this, &WebsiteGrabberDialog::onFileFound);
    connect(m_crawler, &SiteCrawler::fileFailed, this, &WebsiteGrabberDialog::onFileFailed);
    connect(m_crawler, &SiteCrawler::progress, this, &WebsiteGrabberDialog::onProgress);
    connect(m_crawler, &SiteCrawler::finished, this, &WebsiteGrabberDialog::onFinished);
    connect(m_crawler, &SiteCrawler::pageFailed, this,
            [this](const QUrl &url, const QString &why) {
        addRecentFile(QString::fromUtf8("⚠"), url.toString(), why);
    });
    connect(m_crawler, &SiteCrawler::error, this, [this](const QString &message) {
        m_statusLabel->setText(message);
        QMessageBox::warning(this, tr("Website Grabber"), message);
    });
}

WebsiteGrabberDialog::~WebsiteGrabberDialog()
{
    if (m_crawler && m_crawler->status() == CrawlStatus::Running) {
        m_crawler->cancel(false);
    }
}

void WebsiteGrabberDialog::setUrl(const QString& url) { m_urlEdit->setText(url); }

void WebsiteGrabberDialog::setupUi()
{
    setWindowTitle(tr("Website Grabber"));
    setMinimumSize(600, 500);
    
    auto* mainLayout = new QVBoxLayout(this);
    
    auto* urlLayout = new QHBoxLayout;
    urlLayout->addWidget(new QLabel(tr("URL:")));
    m_urlEdit = new QLineEdit;
    m_urlEdit->setPlaceholderText(tr("https://example.com/gallery"));
    urlLayout->addWidget(m_urlEdit);
    mainLayout->addLayout(urlLayout);
    
    auto* presetLayout = new QHBoxLayout;
    presetLayout->addWidget(new QLabel(tr("Download:")));
    m_presetCombo = new QComboBox;
    m_presetCombo->addItem(tr("All files"), "all");
    m_presetCombo->addItem(tr("Images"), "images");
    m_presetCombo->addItem(tr("Videos"), "videos");
    m_presetCombo->addItem(tr("Documents"), "documents");
    m_presetCombo->addItem(tr("Offline website"), "offline");
    presetLayout->addWidget(m_presetCombo);
    presetLayout->addStretch();
    mainLayout->addLayout(presetLayout);
    
    auto* settingsGroup = new QGroupBox(tr("Settings"));
    auto* settingsLayout = new QFormLayout(settingsGroup);
    
    m_includeEdit = new QLineEdit;
    m_includeEdit->setPlaceholderText(tr("*.jpg, *.png"));
    settingsLayout->addRow(tr("Include:"), m_includeEdit);
    
    m_excludeEdit = new QLineEdit;
    m_excludeEdit->setPlaceholderText(tr("*/thumb/*"));
    settingsLayout->addRow(tr("Exclude:"), m_excludeEdit);
    
    auto* limitsLayout = new QHBoxLayout;
    m_depthSpin = new QSpinBox;
    m_depthSpin->setRange(0, 999);
    m_depthSpin->setValue(3);
    m_maxFilesSpin = new QSpinBox;
    m_maxFilesSpin->setRange(0, 100000);
    m_maxFilesSpin->setValue(1000);
    limitsLayout->addWidget(new QLabel(tr("Depth:")));
    limitsLayout->addWidget(m_depthSpin);
    limitsLayout->addWidget(new QLabel(tr("Max files:")));
    limitsLayout->addWidget(m_maxFilesSpin);
    limitsLayout->addStretch();
    settingsLayout->addRow(QString(), limitsLayout);
    
    auto* checkLayout = new QHBoxLayout;
    m_sameDomainCheck = new QCheckBox(tr("Same domain only"));
    m_sameDomainCheck->setChecked(true);
    m_preserveStructureCheck = new QCheckBox(tr("Preserve structure"));
    m_preserveStructureCheck->setChecked(true);
    checkLayout->addWidget(m_sameDomainCheck);
    checkLayout->addWidget(m_preserveStructureCheck);
    settingsLayout->addRow(QString(), checkLayout);
    
    mainLayout->addWidget(settingsGroup);
    
    auto* folderLayout = new QHBoxLayout;
    m_folderEdit = new QLineEdit;
    m_browseBtn = new QPushButton(tr("Browse"));
    folderLayout->addWidget(new QLabel(tr("Save to:")));
    folderLayout->addWidget(m_folderEdit);
    folderLayout->addWidget(m_browseBtn);
    mainLayout->addLayout(folderLayout);
    
    auto* progressGroup = new QGroupBox(tr("Progress"));
    auto* progressLayout = new QVBoxLayout(progressGroup);
    
    m_statusLabel = new QLabel(tr("Ready"));
    m_progressBar = new QProgressBar;
    m_statsLabel = new QLabel(tr("Pages: 0 | Files: 0 | Downloaded: 0"));
    m_recentFilesTable = new QTableWidget;
    m_recentFilesTable->setColumnCount(3);
    m_recentFilesTable->setHorizontalHeaderLabels({tr("Status"), tr("File"), tr("Detail")});
    m_recentFilesTable->horizontalHeader()->setStretchLastSection(true);
    m_recentFilesTable->setMaximumHeight(120);
    m_recentFilesTable->setEditTriggers(QAbstractItemView::NoEditTriggers);
    
    progressLayout->addWidget(m_statusLabel);
    progressLayout->addWidget(m_progressBar);
    progressLayout->addWidget(m_statsLabel);
    progressLayout->addWidget(m_recentFilesTable);
    mainLayout->addWidget(progressGroup);
    
    auto* btnLayout = new QHBoxLayout;
    m_startBtn = new QPushButton(tr("Start Grabbing"));
    m_pauseResumeBtn = new QPushButton(tr("Pause"));
    m_pauseResumeBtn->setEnabled(false);
    m_cancelBtn = new QPushButton(tr("Cancel"));
    m_cancelBtn->setEnabled(false);
    btnLayout->addStretch();
    btnLayout->addWidget(m_startBtn);
    btnLayout->addWidget(m_pauseResumeBtn);
    btnLayout->addWidget(m_cancelBtn);
    mainLayout->addLayout(btnLayout);
}

void WebsiteGrabberDialog::setupConnections()
{
    connect(m_startBtn, &QPushButton::clicked, this, &WebsiteGrabberDialog::onStartGrabbing);
    connect(m_pauseResumeBtn, &QPushButton::clicked, this, &WebsiteGrabberDialog::onPauseResume);
    connect(m_cancelBtn, &QPushButton::clicked, this, &WebsiteGrabberDialog::onCancel);
    connect(m_browseBtn, &QPushButton::clicked, this, &WebsiteGrabberDialog::onBrowseFolder);
    connect(m_presetCombo, &QComboBox::currentIndexChanged,
            this, &WebsiteGrabberDialog::onPresetChanged);
    onPresetChanged(m_presetCombo->currentIndex());
}

void WebsiteGrabberDialog::onStartGrabbing()
{
    QUrl url(m_urlEdit->text().trimmed());
    if (!url.isValid() || !url.scheme().startsWith("http")) {
        m_statusLabel->setText(tr("Please enter a valid URL"));
        return;
    }
    
    QString folder = m_folderEdit->text().trimmed();
    if (folder.isEmpty()) {
        folder = QStandardPaths::writableLocation(QStandardPaths::DownloadLocation) + "/Grabbed/" + url.host();
        m_folderEdit->setText(folder);
    }
    
    CrawlConfig config = buildConfig();
    m_crawler->start(config);
    updateUiForStatus(CrawlStatus::Running);
    m_statusLabel->setText(tr("Crawling..."));
    m_recentFilesTable->setRowCount(0);
}

void WebsiteGrabberDialog::onPauseResume()
{
    if (m_crawler->status() == CrawlStatus::Running) {
        m_crawler->pause();
        m_pauseResumeBtn->setText(tr("Resume"));
        m_statusLabel->setText(tr("Paused"));
    } else if (m_crawler->status() == CrawlStatus::Paused) {
        m_crawler->resume();
        m_pauseResumeBtn->setText(tr("Pause"));
        m_statusLabel->setText(tr("Crawling..."));
    }
}

void WebsiteGrabberDialog::onCancel()
{
    m_crawler->cancel(false);
    updateUiForStatus(CrawlStatus::Cancelled);
    m_statusLabel->setText(tr("Cancelled"));
}

void WebsiteGrabberDialog::onBrowseFolder()
{
    QString folder = QFileDialog::getExistingDirectory(this, tr("Select Folder"));
    if (!folder.isEmpty()) m_folderEdit->setText(folder);
}

void WebsiteGrabberDialog::onPresetChanged(int index)
{
    // Built from the same factory functions the crawler ships, so the preset
    // shown in the fields and the preset the crawler means are one thing.
    const QString key = m_presetCombo->itemData(index).toString();
    const QUrl url(m_urlEdit->text().trimmed());
    const QString folder = m_folderEdit->text().trimmed();

    CrawlConfig preset;
    if (key == QLatin1String("images"))         preset = CrawlConfig::forImages(url, folder);
    else if (key == QLatin1String("videos"))    preset = CrawlConfig::forVideos(url, folder);
    else if (key == QLatin1String("documents")) preset = CrawlConfig::forDocuments(url, folder);
    else if (key == QLatin1String("offline"))   preset = CrawlConfig::forOffline(url, folder);
    else                                        preset = CrawlConfig::forAllFiles(url, folder);

    m_includeEdit->setText(preset.includePatterns.join(QStringLiteral(", ")));
    m_depthSpin->setValue(preset.maxDepth);
    m_maxFilesSpin->setValue(preset.maxFiles);
    m_sameDomainCheck->setChecked(preset.sameDomainOnly);
    m_preserveStructureCheck->setChecked(preset.preserveStructure);
}

void WebsiteGrabberDialog::onFileFound(const QUrl& fileUrl, const QString&, qint64 size)
{
    // "Found" is not "downloaded": the row is added when the crawler decides to
    // fetch it, and the tick arrives later from fileDownloaded.
    addRecentFile(QString::fromUtf8("…"), fileUrl.fileName(),
                  size > 0 ? tr("%1 KB").arg(size / 1024) : tr("queued"));
}

CrawlConfig WebsiteGrabberDialog::buildConfig() const
{
    CrawlConfig config;
    config.seedUrl = QUrl(m_urlEdit->text().trimmed());
    config.saveFolder = m_folderEdit->text().trimmed();
    config.maxDepth = m_depthSpin->value();
    config.maxFiles = m_maxFilesSpin->value();
    config.sameDomainOnly = m_sameDomainCheck->isChecked();
    config.preserveStructure = m_preserveStructureCheck->isChecked();
    
    QString include = m_includeEdit->text().trimmed();
    if (!include.isEmpty()) {
        config.includePatterns = include.split(',', Qt::SkipEmptyParts);
        for (QString& p : config.includePatterns) p = p.trimmed();
    }
    QString exclude = m_excludeEdit->text().trimmed();
    if (!exclude.isEmpty()) {
        config.excludePatterns = exclude.split(',', Qt::SkipEmptyParts);
        for (QString& p : config.excludePatterns) p = p.trimmed();
    }
    return config;
}

void WebsiteGrabberDialog::updateUiForStatus(CrawlStatus status)
{
    bool running = (status == CrawlStatus::Running);
    bool paused = (status == CrawlStatus::Paused);
    m_startBtn->setEnabled(!running && !paused);
    m_pauseResumeBtn->setEnabled(running || paused);
    m_cancelBtn->setEnabled(running || paused);
    m_urlEdit->setEnabled(!running && !paused);
    m_presetCombo->setEnabled(!running && !paused);
}

void WebsiteGrabberDialog::onPageCrawled(const QUrl&, int filesFound)
{
    m_statusLabel->setText(tr("Crawling... Found %1 files").arg(filesFound));
}

void WebsiteGrabberDialog::onFileDownloaded(const CrawlFileResult& result)
{
    addRecentFile(result.skipped ? QString::fromUtf8("\u23ED") : QString::fromUtf8("\u2713"), 
                  result.localPath, result.error);
}

void WebsiteGrabberDialog::onFileFailed(const QUrl& fileUrl, const QString& error)
{
    addRecentFile(QString::fromUtf8("\u2717"), fileUrl.fileName(), error);
}

void WebsiteGrabberDialog::onProgress(int pages, int found, int downloaded)
{
    m_statsLabel->setText(tr("Pages: %1 | Files found: %2 | Downloaded: %3")
                              .arg(pages).arg(found).arg(downloaded));
    // Against the files found so far this ran backwards, because `found` keeps
    // growing while the crawl walks. Busy-indicator until the crawl stops
    // discovering, which is honest about not knowing the total.
    if (found > 0 && downloaded >= found) {
        m_progressBar->setRange(0, 100);
        m_progressBar->setValue(100);
    } else {
        m_progressBar->setRange(0, 0);
    }
}

void WebsiteGrabberDialog::onFinished(const CrawlSummary& summary)
{
    m_progressBar->setRange(0, 100);
    m_progressBar->setValue(100);
    // Integer division showed "0 MB" for every crawl under a megabyte, which
    // is most of them.
    const double mb = double(summary.totalBytes) / (1024.0 * 1024.0);
    QString text = tr("Done: %1 pages, %2 files (%3 MB)")
                       .arg(summary.pagesCrawled)
                       .arg(summary.filesDownloaded)
                       .arg(mb, 0, 'f', mb < 10 ? 2 : 1);
    if (summary.filesSkipped > 0)
        text += tr(", %n skipped", nullptr, summary.filesSkipped);
    if (summary.filesFailed > 0)
        text += tr(", %n failed", nullptr, summary.filesFailed);
    m_statusLabel->setText(text);
    updateUiForStatus(m_crawler ? m_crawler->status() : CrawlStatus::Completed);
}

void WebsiteGrabberDialog::addRecentFile(const QString& status, const QString& name, const QString& detail)
{
    constexpr int kMaxRows = 200;
    while (m_recentFilesTable->rowCount() >= kMaxRows)
        m_recentFilesTable->removeRow(0);
    int row = m_recentFilesTable->rowCount();
    m_recentFilesTable->insertRow(row);
    m_recentFilesTable->setItem(row, 0, new QTableWidgetItem(status));
    m_recentFilesTable->setItem(row, 1, new QTableWidgetItem(QFileInfo(name).fileName()));
    m_recentFilesTable->setItem(row, 2, new QTableWidgetItem(detail));
    m_recentFilesTable->scrollToBottom();
}

} // namespace nexa