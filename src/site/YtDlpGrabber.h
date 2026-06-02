#pragma once
#include <QObject>
#include <QUrl>
#include <QString>
#include <QStringList>
#include <QVector>
#include <QHash>
#include <QElapsedTimer>
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
    // `authArgs` are FINISHED yt-dlp CLI flags (e.g. {"--cookies","/abs/x.txt"})
    // pre-built by the engine's AuthenticationManager for this domain. The grabber
    // stays decoupled — it splices opaque flags, never the manager.
    // `playlist` downloads every video in the playlist (yt-dlp --yes-playlist),
    // numbered into a per-playlist subfolder, instead of just the linked video.
    YtDlpGrabber(int id, const QUrl &pageUrl, const QString &outputDir,
                 const QString &fixedName, const QString &formatSelector,
                 const HeaderList &headers, const QStringList &authArgs = {},
                 bool playlist = false, QObject *parent = nullptr);
    ~YtDlpGrabber() override;

    void start();
    void cancel();

    // Download and embed subtitles into the output (manual + auto-generated) for
    // the given comma-separated languages (e.g. "en,en-US"). Off by default; the
    // engine wires this to the user's Settings value. No-op for audio-only grabs.
    void setSubtitles(bool embed, const QString &langs);

    // For playlist jobs: how many videos to download in PARALLEL (default 3).
    // yt-dlp itself downloads a playlist one video at a time, which leaves most
    // of the bandwidth idle for small videos — so we run N yt-dlp workers, each
    // taking a round-robin slice of the playlist (--playlist-items "j::N").
    void setPlaylistConcurrency(int n);

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
    void renamed(int id, const QString &name);   // real (playlist/video) name discovered

private slots:
    void onOutput();
    void onProcessFinished(int exitCode);
    void onPlOutput();          // a parallel playlist worker produced output
    void onPlProcFinished();    // a parallel playlist worker exited

private:
    void setState(DownloadState s, const QString &detail = QString());
    void resolveOutputFile();
    QStringList commonArgs(const QString &outputTemplate) const;   // args shared by all workers
    void startPlaylistParallel(const QStringList &common, const QUrl &runUrl);
    void emitPlaylistProgress();   // aggregate videos-done + combined speed
    int  countPlaylistDone() const;

    int             m_id;
    QUrl            m_url;
    QString         m_dir;        // output directory
    QString         m_fixedName;  // desired base name (empty -> video's title)
    QString         m_outFile;    // path yt-dlp records the final file to
    QString         m_savePath;   // resolved final file (best guess until done)
    QString         m_format;
    HeaderList      m_headers;
    QStringList     m_authArgs;   // pre-built domain-scoped yt-dlp auth flags
    bool            m_playlist = false;   // download the whole playlist
    bool            m_embedSubs = false;  // fetch + embed subtitles
    QString         m_subLangs = QStringLiteral("en");   // comma-separated languages
    int             m_plItem = 0;         // current playlist item (1-based)
    int             m_plTotal = 0;        // playlist item count
    DownloadState   m_state = DownloadState::Queued;
    QProcess       *m_proc = nullptr;     // single-video worker

    // ---- parallel playlist workers (only used when m_playlist) ----
    int             m_plConcurrency = 3;        // videos downloaded at once
    QVector<QProcess*>       m_plProcs;         // the N worker processes
    QStringList              m_plOutFiles;      // each worker's finalised-path file
    QHash<QProcess*, double> m_plRates;         // each worker's last reported speed
    int             m_plFinished = 0;           // workers that have exited
    int             m_plDoneVideos = 0;         // videos finished across all workers
    QString         m_plName;                   // real playlist title (parsed from yt-dlp)
    qint64          m_plLastEmitMs = 0;         // throttle aggregate progress emits
    QElapsedTimer   m_plClock;
    bool            m_cancelled = false;
    int             m_lastPct = -1;
    qint64          m_lastEmitDone = -1;  // throttle UI updates to meaningful deltas
    int             m_conns = 16;         // parallel fragment connections in use
    QString         m_lastError;          // last "ERROR:" line from yt-dlp
    QStringList     m_tail;               // recent output lines (for diagnostics)
};

} // namespace nexa
