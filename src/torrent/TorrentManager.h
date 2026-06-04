#pragma once
#include <QObject>
#include <QString>
#include <memory>
#include "core/Types.h"

namespace nexa {

// Wraps a single libtorrent session and drives many torrents. Magnet links and
// .torrent files are added here; status is polled on a timer and surfaced
// through the same signals as DownloadTask/HlsGrabber so the engine and UI
// treat torrents uniformly. libtorrent headers are hidden behind a pimpl.
class TorrentManager : public QObject {
    Q_OBJECT
public:
    explicit TorrentManager(QObject *parent = nullptr);
    ~TorrentManager() override;

    // magnetOrPath: a "magnet:?..." URI or a local .torrent file path.
    bool add(int id, const QString &magnetOrPath, const QString &saveDir);
    void pause(int id);
    void resume(int id);
    void remove(int id, bool deleteFiles = false);

    bool          has(int id) const;
    QString       nameOf(int id) const;
    DownloadState stateOf(int id) const;

    // Session-wide rate caps in bytes/sec; 0 = unlimited. Applied live.
    void setSpeedLimits(int downloadBytesPerSec, int uploadBytesPerSec);
    // Seed until upload/download ratio reaches `ratio`, then stop. 0 (default)
    // means don't seed at all — stop the moment the download completes.
    void setSeedRatio(double ratio);

    static bool isTorrentUrl(const QString &s);   // magnet: or *.torrent

signals:
    void progress(int id, qint64 done, qint64 total, double bytesPerSec);
    void stateChanged(int id, DownloadState state, const QString &detail);
    void finished(int id);

private slots:
    void poll();

private:
    struct Impl;
    std::unique_ptr<Impl> d;
};

} // namespace nexa
