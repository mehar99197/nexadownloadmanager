#pragma once
#include <QObject>
#include <QWidget>
#include <QUrl>
#include <QString>

class QLabel;
class QTimer;

namespace nexa {

// Watches the system clipboard and, when a download-able URL is copied
// (a known file type, a media stream, a magnet/.torrent, or a yt-dlp site),
// emits downloadableUrlDetected() once for that URL. IDM-style "grab the link
// you just copied". Toggleable; off by default until the user opts in.
class ClipboardMonitor : public QObject {
    Q_OBJECT
public:
    explicit ClipboardMonitor(QObject *parent = nullptr);

    void setEnabled(bool on);
    bool isEnabled() const { return m_enabled; }

    // True when `text` is a bare URL Nexa would actually download. Fills `out`
    // with the parsed URL on success. Reuses the engine's own detectors so the
    // monitor never offers a link the engine would reject.
    static bool looksDownloadable(const QString &text, QUrl &out);

signals:
    void downloadableUrlDetected(const QUrl &url);

private slots:
    void onClipboardChanged();

private:
    bool    m_enabled = false;
    QString m_lastHandled;   // dedupe: don't re-prompt the same copied URL
};

// A small, frameless, auto-dismissing popup anchored to the bottom-right of the
// screen: "Link detected — <url>  [Download] [Ignore]". Self-deletes when the
// user acts, the timer fires, or it's replaced. Styled to match the dark theme.
class CaptureToast : public QWidget {
    Q_OBJECT
public:
    explicit CaptureToast(const QUrl &url, QWidget *parent = nullptr);

signals:
    void accepted(const QUrl &url);

private:
    void positionToCorner();

    QUrl    m_url;
    QTimer *m_dismiss = nullptr;
};

} // namespace nexa
