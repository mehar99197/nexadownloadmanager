#include "ui/ClipboardMonitor.h"
#include "grabber/HlsGrabber.h"
#include "site/YtDlpGrabber.h"
#include "torrent/TorrentManager.h"

#include <QApplication>
#include <QClipboard>
#include <QFileInfo>
#include <QSet>
#include <QString>
#include <QLabel>
#include <QPushButton>
#include <QHBoxLayout>
#include <QVBoxLayout>
#include <QTimer>
#include <QScreen>
#include <QGuiApplication>
#include <QCursor>
#include <QFontMetrics>

namespace nexa {

// ---- ClipboardMonitor ------------------------------------------------------

ClipboardMonitor::ClipboardMonitor(QObject *parent)
    : QObject(parent)
{
    connect(QApplication::clipboard(), &QClipboard::dataChanged,
            this, &ClipboardMonitor::onClipboardChanged);
}

void ClipboardMonitor::setEnabled(bool on)
{
    m_enabled = on;
    // Seed the dedupe marker with whatever is on the clipboard right now, so
    // turning monitoring on doesn't immediately fire for a stale copy.
    if (on)
        m_lastHandled = QApplication::clipboard()->text().trimmed();
}

bool ClipboardMonitor::looksDownloadable(const QString &text, QUrl &out)
{
    const QString s = text.trimmed();
    // A bare copied URL has no internal whitespace; reject pasted prose early.
    if (s.isEmpty() || s.size() > 4096 || s.contains(QLatin1Char(' ')) ||
        s.contains(QLatin1Char('\n')) || s.contains(QLatin1Char('\t')))
        return false;

    // magnet: / *.torrent — hand straight to the torrent engine.
    if (TorrentManager::isTorrentUrl(s)) {
        out = QUrl::fromUserInput(s);
        return out.isValid();
    }

    const QUrl url = QUrl::fromUserInput(s);
    if (!url.isValid() || url.host().isEmpty())
        return false;
    const QString scheme = url.scheme().toLower();
    if (scheme != QLatin1String("http") && scheme != QLatin1String("https") &&
        scheme != QLatin1String("ftp"))
        return false;

    // Media streams (.m3u8/.mpd) and yt-dlp sites (YouTube, Vimeo, …).
    if (HlsGrabber::isStreamUrl(url) || YtDlpGrabber::isSiteVideoUrl(url)) {
        out = url;
        return true;
    }

    // Otherwise only offer real downloadable file types — keeps the toast from
    // firing on every ordinary web page you copy.
    static const QSet<QString> kExts = {
        // video
        QStringLiteral("mp4"), QStringLiteral("mkv"), QStringLiteral("avi"),
        QStringLiteral("mov"), QStringLiteral("wmv"), QStringLiteral("flv"),
        QStringLiteral("webm"), QStringLiteral("m4v"), QStringLiteral("mpg"),
        QStringLiteral("mpeg"), QStringLiteral("ts"), QStringLiteral("3gp"),
        // audio
        QStringLiteral("mp3"), QStringLiteral("wav"), QStringLiteral("flac"),
        QStringLiteral("aac"), QStringLiteral("m4a"), QStringLiteral("ogg"),
        QStringLiteral("wma"), QStringLiteral("opus"),
        // documents
        QStringLiteral("pdf"), QStringLiteral("doc"), QStringLiteral("docx"),
        QStringLiteral("xls"), QStringLiteral("xlsx"), QStringLiteral("ppt"),
        QStringLiteral("pptx"), QStringLiteral("txt"), QStringLiteral("epub"),
        QStringLiteral("csv"), QStringLiteral("odt"),
        // archives
        QStringLiteral("zip"), QStringLiteral("rar"), QStringLiteral("7z"),
        QStringLiteral("tar"), QStringLiteral("gz"), QStringLiteral("bz2"),
        QStringLiteral("xz"), QStringLiteral("tgz"),
        // programs / images
        QStringLiteral("exe"), QStringLiteral("msi"), QStringLiteral("deb"),
        QStringLiteral("rpm"), QStringLiteral("dmg"), QStringLiteral("pkg"),
        QStringLiteral("apk"), QStringLiteral("appimage"), QStringLiteral("bin"),
        QStringLiteral("iso"), QStringLiteral("img"),
        QStringLiteral("jpg"), QStringLiteral("jpeg"), QStringLiteral("png"),
        QStringLiteral("gif"), QStringLiteral("svg"), QStringLiteral("webp"),
    };
    const QString ext = QFileInfo(url.path()).suffix().toLower();
    if (!ext.isEmpty() && kExts.contains(ext)) {
        out = url;
        return true;
    }
    return false;
}

void ClipboardMonitor::onClipboardChanged()
{
    if (!m_enabled)
        return;
    const QString text = QApplication::clipboard()->text().trimmed();
    if (text.isEmpty() || text == m_lastHandled)
        return;

    QUrl url;
    if (!looksDownloadable(text, url))
        return;

    m_lastHandled = text;             // only prompt once per copied URL
    emit downloadableUrlDetected(url);
}

// ---- CaptureToast ----------------------------------------------------------

CaptureToast::CaptureToast(const QUrl &url, QWidget *parent)
    : QWidget(parent, Qt::Tool | Qt::FramelessWindowHint | Qt::WindowStaysOnTopHint),
      m_url(url)
{
    setAttribute(Qt::WA_DeleteOnClose);
    setAttribute(Qt::WA_ShowWithoutActivating);   // don't steal focus from the browser
    setFixedWidth(360);

    auto *plate = new QWidget(this);
    plate->setObjectName(QStringLiteral("Plate"));
    auto *outer = new QVBoxLayout(this);
    outer->setContentsMargins(0, 0, 0, 0);
    outer->addWidget(plate);

    auto *v = new QVBoxLayout(plate);
    v->setContentsMargins(16, 13, 16, 13);
    v->setSpacing(8);

    auto *title = new QLabel(QStringLiteral("🔗  Link detected"), plate);
    title->setObjectName(QStringLiteral("Dd_title"));

    auto *link = new QLabel(plate);
    link->setObjectName(QStringLiteral("Dd_host"));
    // Elide the URL so a long link can't blow the toast width out.
    const QString shown = QFontMetrics(link->font())
        .elidedText(url.toString(), Qt::ElideMiddle, width() - 40);
    link->setText(shown);
    link->setToolTip(url.toString());

    auto *row = new QHBoxLayout;
    row->setContentsMargins(0, 2, 0, 0);
    row->setSpacing(8);
    auto *ignore = new QPushButton(QStringLiteral("Ignore"), plate);
    ignore->setCursor(Qt::PointingHandCursor);
    auto *download = new QPushButton(QStringLiteral("Download"), plate);
    download->setObjectName(QStringLiteral("Primary"));
    download->setCursor(Qt::PointingHandCursor);
    row->addStretch(1);
    row->addWidget(ignore);
    row->addWidget(download);

    v->addWidget(title);
    v->addWidget(link);
    v->addLayout(row);

    connect(ignore, &QPushButton::clicked, this, &QWidget::close);
    connect(download, &QPushButton::clicked, this, [this]() {
        emit accepted(m_url);
        close();
    });

    // Auto-dismiss after a few seconds so an ignored toast cleans itself up.
    m_dismiss = new QTimer(this);
    m_dismiss->setSingleShot(true);
    m_dismiss->setInterval(9000);
    connect(m_dismiss, &QTimer::timeout, this, &QWidget::close);
    m_dismiss->start();

    positionToCorner();
}

void CaptureToast::positionToCorner()
{
    // Prefer the screen under the cursor (multi-monitor), fall back to primary.
    QScreen *screen = QGuiApplication::screenAt(QCursor::pos());
    if (!screen)
        screen = QGuiApplication::primaryScreen();
    if (!screen)
        return;
    const QRect area = screen->availableGeometry();
    adjustSize();
    const int margin = 22;
    // Clamp so the toast is always fully on-screen even if it's wide/tall.
    const int x = qMax(area.left() + margin, area.right()  - width()  - margin);
    const int y = qMax(area.top()  + margin, area.bottom() - height() - margin);
    move(x, y);
}

} // namespace nexa
