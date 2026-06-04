#pragma once
#include <QObject>
#include <QString>
#include <memory>
#include "core/Types.h"

namespace nexa {

#ifdef NEXA_TORRENT_ENABLED

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

#else

// ── Stub (no-torrent build: Windows CI, or -DNEXA_TORRENT=OFF) ─────────────
// m_torrents is always nullptr when NEXA_TORRENT=OFF so connect() is never
// called — the stub just needs to compile, not emit real signals. We inherit
// QObject so DownloadEngine::connect(m_torrents, ...) compiles, but we DON'T
// use Q_OBJECT (avoids needing MOC / TorrentManager.cpp in this build).
class TorrentManager : public QObject {
public:
    explicit TorrentManager(QObject *parent = nullptr) : QObject(parent) {}
    bool  add(int, const QString &, const QString &) { return false; }
    void  pause(int)  {}
    void  resume(int) {}
    void  remove(int, bool = false) {}
    bool  has(int)      const { return false; }
    QString nameOf(int) const { return {}; }
    DownloadState stateOf(int) const { return DownloadState::Queued; }
    void  setSpeedLimits(int, int) {}
    void  setSeedRatio(double) {}
    static bool isTorrentUrl(const QString &) { return false; }
    // Fake signal declarations so connect() calls compile (never actually wired)
    void progress(int, qint64, qint64, double) {}
    void stateChanged(int, DownloadState, const QString &) {}
    void finished(int) {}
};

#endif // NEXA_TORRENT_ENABLED

} // namespace nexa
