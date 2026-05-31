#pragma once
#include <QObject>
#include <QUrl>
#include <QString>
#include <QStringList>
#include "core/Types.h"

class QProcess;

namespace nexa {

// Downloads a video from YouTube (and any other yt-dlp-supported site) by
// driving the `yt-dlp` CLI, which handles signature ciphers, SABR, format
// selection and video+audio muxing (via FFmpeg) — the robust, maintained way
// to do what IDM does for streaming sites. Emits the same signals as the other
// download types so the engine/UI treat it uniformly.
class YtDlpGrabber : public QObject {
    Q_OBJECT
public:
    // outputDir: where to save (e.g. .../Downloads/Video). fixedName: the desired
    // base filename (no extension); empty -> use the video's own title.
    YtDlpGrabber(int id, const QUrl &pageUrl, const QString &outputDir,
                 const QString &fixedName, const QString &formatSelector,
                 const HeaderList &headers, QObject *parent = nullptr);
    ~YtDlpGrabber() override;

    void start();
    void cancel();

    int           id()       const { return m_id; }
    QUrl          url()      const { return m_url; }
    QString       savePath() const { return m_savePath; }
    QString       fileName() const;
    DownloadState state()    const { return m_state; }

    static bool   isSiteVideoUrl(const QUrl &url);          // youtube.com / youtu.be / ...
    static bool   available();                              // is yt-dlp on PATH?
    static QString formatForQuality(const QString &quality); // "1080" -> yt-dlp -f string

signals:
    void progress(int id, qint64 done, qint64 total, double bytesPerSec);
    void stateChanged(int id, DownloadState state, const QString &detail);
    void finished(int id);

private slots:
    void onOutput();
    void onProcessFinished(int exitCode);

private:
    void setState(DownloadState s, const QString &detail = QString());
    void resolveOutputFile();

    int             m_id;
    QUrl            m_url;
    QString         m_dir;        // output directory
    QString         m_fixedName;  // desired base name (empty -> video's title)
    QString         m_outFile;    // path yt-dlp records the final file to
    QString         m_savePath;   // resolved final file (best guess until done)
    QString         m_format;
    HeaderList      m_headers;
    DownloadState   m_state = DownloadState::Queued;
    QProcess       *m_proc = nullptr;
    bool            m_cancelled = false;
    int             m_lastPct = -1;
    QString         m_lastError;          // last "ERROR:" line from yt-dlp
    QStringList     m_tail;               // recent output lines (for diagnostics)
};

} // namespace nexa
