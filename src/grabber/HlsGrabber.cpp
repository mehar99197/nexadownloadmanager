#include "grabber/HlsGrabber.h"

#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QProcess>
#include <QFile>
#include <QDir>
#include <QFileInfo>
#include <QStandardPaths>
#include <QRegularExpression>
#include <QTextStream>

namespace nexa {

HlsGrabber::HlsGrabber(int id, const QUrl &url, const QString &savePath,
                       const HeaderList &headers, QObject *parent)
    : QObject(parent), m_id(id), m_url(url), m_savePath(savePath), m_headers(headers)
{
    m_nam = new QNetworkAccessManager(this);
}

HlsGrabber::~HlsGrabber()
{
    cleanupTemp();
}

bool HlsGrabber::isStreamUrl(const QUrl &url)
{
    const QString path = url.path().toLower();
    return path.endsWith(QStringLiteral(".m3u8")) ||
           path.endsWith(QStringLiteral(".m3u")) ||
           path.endsWith(QStringLiteral(".mpd"));
}

QString HlsGrabber::fileName() const
{
    return QFileInfo(m_savePath).fileName();
}

QString HlsGrabber::tempDir() const
{
    const QString base = QStandardPaths::writableLocation(QStandardPaths::TempLocation);
    return base + QStringLiteral("/nexa-stream-%1").arg(m_id);
}

void HlsGrabber::setState(DownloadState s, const QString &detail)
{
    m_state = s;
    emit stateChanged(m_id, s, detail);
}

void HlsGrabber::start()
{
    m_clock.start();
    QDir().mkpath(tempDir());

    // DASH and other manifests: let FFmpeg do the whole job.
    if (m_url.path().toLower().endsWith(QStringLiteral(".mpd"))) {
        muxViaFfmpegDirect();
        return;
    }

    setState(DownloadState::Probing, QStringLiteral("fetching playlist"));
    fetchPlaylist(m_url);
}

void HlsGrabber::cancel()
{
    m_cancelled = true;
    if (m_playlistReply) { m_playlistReply->abort(); m_playlistReply = nullptr; }
    if (m_ffmpeg) { m_ffmpeg->kill(); }
    setState(DownloadState::Paused, QStringLiteral("cancelled"));
}

void HlsGrabber::fetchPlaylist(const QUrl &u)
{
    QNetworkRequest req(u);
    req.setHeader(QNetworkRequest::UserAgentHeader, QStringLiteral("Nexa/0.1"));
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                     QNetworkRequest::NoLessSafeRedirectPolicy);
    for (const auto &h : m_headers)
        req.setRawHeader(h.first, h.second);

    m_playlistReply = m_nam->get(req);
    connect(m_playlistReply, &QNetworkReply::finished, this, &HlsGrabber::onPlaylistFetched);
}

void HlsGrabber::onPlaylistFetched()
{
    QNetworkReply *r = m_playlistReply;
    m_playlistReply = nullptr;
    if (!r || m_cancelled)
        return;
    r->deleteLater();

    if (r->error() != QNetworkReply::NoError) {
        setState(DownloadState::Error, r->errorString());
        return;
    }
    // Resolve relative URIs against the *final* (possibly redirected) URL.
    const QUrl finalUrl = r->url();
    if (finalUrl.isValid())
        m_url = finalUrl;

    const QString text = QString::fromUtf8(r->readAll());
    if (!text.contains(QStringLiteral("#EXTM3U"))) {
        setState(DownloadState::Error, QStringLiteral("not a valid m3u8 playlist"));
        return;
    }

    if (!m_resolvedVariant && text.contains(QStringLiteral("#EXT-X-STREAM-INF")))
        handleMaster(text);
    else
        handleMedia(text);
}

void HlsGrabber::handleMaster(const QString &text)
{
    // Pick the highest-bandwidth variant.
    const QStringList lines = text.split('\n');
    qint64 bestBw = -1;
    QString bestUri;
    QString bestRes;
    for (int i = 0; i < lines.size(); ++i) {
        const QString line = lines[i].trimmed();
        if (!line.startsWith(QStringLiteral("#EXT-X-STREAM-INF")))
            continue;
        qint64 bw = 0;
        const auto bwMatch = QRegularExpression(QStringLiteral("BANDWIDTH=(\\d+)")).match(line);
        if (bwMatch.hasMatch())
            bw = bwMatch.captured(1).toLongLong();
        QString res;
        const auto resMatch = QRegularExpression(QStringLiteral("RESOLUTION=([0-9x]+)")).match(line);
        if (resMatch.hasMatch())
            res = resMatch.captured(1);
        // The URI is the next non-empty, non-comment line.
        for (int j = i + 1; j < lines.size(); ++j) {
            const QString u = lines[j].trimmed();
            if (u.isEmpty() || u.startsWith('#'))
                continue;
            if (bw > bestBw) { bestBw = bw; bestUri = u; bestRes = res; }
            break;
        }
    }

    if (bestUri.isEmpty()) {
        setState(DownloadState::Error, QStringLiteral("no variant streams found"));
        return;
    }

    m_resolvedVariant = true;
    m_url = m_url.resolved(QUrl(bestUri));
    setState(DownloadState::Probing,
             QStringLiteral("variant %1 (%2 kbps)")
                 .arg(bestRes.isEmpty() ? QStringLiteral("best") : bestRes)
                 .arg(bestBw / 1000));
    fetchPlaylist(m_url);
}

void HlsGrabber::handleMedia(const QString &text)
{
    const QStringList lines = text.split('\n');

    // Build a local playlist that mirrors the original but points segment URIs
    // at local files. #EXT-X-KEY URIs are absolutised so FFmpeg can fetch keys.
    QString out;
    int segIndex = 0;
    for (QString raw : lines) {
        const QString line = raw.trimmed();
        if (line.isEmpty())
            continue;

        if (line.startsWith(QStringLiteral("#EXT-X-KEY"))) {
            QString fixed = line;
            const auto m = QRegularExpression(QStringLiteral("URI=\"([^\"]+)\"")).match(line);
            if (m.hasMatch()) {
                const QUrl keyAbs = m_url.resolved(QUrl(m.captured(1)));
                fixed.replace(m.captured(0),
                              QStringLiteral("URI=\"%1\"").arg(keyAbs.toString()));
            }
            out += fixed + '\n';
            continue;
        }
        if (line.startsWith('#')) {
            out += line + '\n';
            continue;
        }

        // A media segment URI.
        Segment seg;
        seg.url = m_url.resolved(QUrl(line));
        seg.localFile = QStringLiteral("seg%1.ts").arg(segIndex, 5, 10, QChar('0'));
        m_segments.append(seg);
        out += seg.localFile + '\n';
        ++segIndex;
    }

    if (m_segments.isEmpty()) {
        setState(DownloadState::Error, QStringLiteral("playlist had no segments"));
        return;
    }

    m_localPlaylist = tempDir() + QStringLiteral("/index.m3u8");
    QFile pf(m_localPlaylist);
    if (!pf.open(QIODevice::WriteOnly | QIODevice::Text)) {
        setState(DownloadState::Error, QStringLiteral("cannot write local playlist"));
        return;
    }
    pf.write(out.toUtf8());
    pf.close();

    setState(DownloadState::Downloading,
             QStringLiteral("0/%1 segments").arg(m_segments.size()));
    pumpDownloads();
}

void HlsGrabber::pumpDownloads()
{
    while (m_inFlight < kConcurrency && m_nextToFetch < m_segments.size()) {
        const int idx = m_nextToFetch++;
        const Segment &seg = m_segments[idx];

        // Own manager per request to dodge the 6-connections-per-host cap.
        auto *nam = new QNetworkAccessManager(this);
        QNetworkRequest req(seg.url);
        req.setHeader(QNetworkRequest::UserAgentHeader, QStringLiteral("Nexa/0.1"));
        req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                         QNetworkRequest::NoLessSafeRedirectPolicy);
        for (const auto &h : m_headers)
            req.setRawHeader(h.first, h.second);

        QNetworkReply *reply = nam->get(req);
        reply->setProperty("segIndex", idx);
        reply->setProperty("ownNam", QVariant::fromValue<void*>(nam));
        connect(reply, &QNetworkReply::finished, this, &HlsGrabber::onSegmentFinished);
        ++m_inFlight;
    }
}

void HlsGrabber::onSegmentFinished()
{
    auto *reply = qobject_cast<QNetworkReply*>(sender());
    if (!reply)
        return;
    const int idx = reply->property("segIndex").toInt();
    auto *nam = static_cast<QNetworkAccessManager*>(reply->property("ownNam").value<void*>());

    --m_inFlight;

    if (m_cancelled) {
        reply->deleteLater();
        if (nam) nam->deleteLater();
        return;
    }

    if (reply->error() != QNetworkReply::NoError) {
        reply->deleteLater();
        if (nam) nam->deleteLater();
        setState(DownloadState::Error,
                 QStringLiteral("segment %1: %2").arg(idx).arg(reply->errorString()));
        return;
    }

    const QByteArray data = reply->readAll();
    reply->deleteLater();
    if (nam) nam->deleteLater();

    QFile f(tempDir() + QStringLiteral("/") + m_segments[idx].localFile);
    if (f.open(QIODevice::WriteOnly)) {
        f.write(data);
        f.close();
    }
    m_segments[idx].done = true;
    m_bytes += data.size();
    ++m_doneCount;

    double bps = 0.0;
    if (m_clock.elapsed() > 0)
        bps = double(m_bytes) * 1000.0 / double(m_clock.elapsed());
    emit progress(m_id, m_bytes, -1, bps);
    setState(DownloadState::Downloading,
             QStringLiteral("%1/%2 segments").arg(m_doneCount).arg(m_segments.size()));

    if (m_doneCount == m_segments.size())
        startMux();
    else
        pumpDownloads();
}

void HlsGrabber::startMux()
{
    setState(DownloadState::Downloading, QStringLiteral("muxing to MP4"));
    QDir().mkpath(QFileInfo(m_savePath).absolutePath());

    m_ffmpeg = new QProcess(this);
    m_ffmpeg->setWorkingDirectory(tempDir());
    const QStringList args = {
        QStringLiteral("-y"),
        QStringLiteral("-allowed_extensions"), QStringLiteral("ALL"),
        QStringLiteral("-protocol_whitelist"), QStringLiteral("file,crypto,data,http,https,tcp,tls"),
        QStringLiteral("-i"), m_localPlaylist,
        QStringLiteral("-c"), QStringLiteral("copy"),
        QStringLiteral("-bsf:a"), QStringLiteral("aac_adtstoasc"),
        m_savePath
    };
    connect(m_ffmpeg, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished),
            this, [this](int code, QProcess::ExitStatus) { onMuxFinished(code); });
    m_ffmpeg->start(QStringLiteral("ffmpeg"), args);
}

void HlsGrabber::muxViaFfmpegDirect()
{
    setState(DownloadState::Downloading, QStringLiteral("downloading via FFmpeg"));
    QDir().mkpath(QFileInfo(m_savePath).absolutePath());

    QStringList args = { QStringLiteral("-y") };
    // Forward captured headers (cookies/UA/referrer) to FFmpeg.
    QString hdr;
    QString ua;
    for (const auto &h : m_headers) {
        if (h.first.compare("User-Agent", Qt::CaseInsensitive) == 0)
            ua = QString::fromUtf8(h.second);
        else
            hdr += QString::fromUtf8(h.first) + ": " + QString::fromUtf8(h.second) + "\r\n";
    }
    if (!ua.isEmpty()) args << QStringLiteral("-user_agent") << ua;
    if (!hdr.isEmpty()) args << QStringLiteral("-headers") << hdr;
    args << QStringLiteral("-i") << m_url.toString()
         << QStringLiteral("-c") << QStringLiteral("copy")
         << m_savePath;

    m_ffmpeg = new QProcess(this);
    connect(m_ffmpeg, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished),
            this, [this](int code, QProcess::ExitStatus) { onMuxFinished(code); });
    m_ffmpeg->start(QStringLiteral("ffmpeg"), args);
}

void HlsGrabber::onMuxFinished(int exitCode)
{
    const bool ok = (exitCode == 0) && QFileInfo::exists(m_savePath) &&
                    QFileInfo(m_savePath).size() > 0;
    if (m_ffmpeg) { m_ffmpeg->deleteLater(); m_ffmpeg = nullptr; }
    cleanupTemp();

    if (ok) {
        emit progress(m_id, m_bytes > 0 ? m_bytes : 1, m_bytes > 0 ? m_bytes : 1, 0.0);
        setState(DownloadState::Completed, QStringLiteral("saved %1").arg(fileName()));
        emit finished(m_id);
    } else {
        setState(DownloadState::Error, QStringLiteral("FFmpeg mux failed (code %1)").arg(exitCode));
    }
}

void HlsGrabber::cleanupTemp()
{
    const QString dir = tempDir();
    if (QDir(dir).exists())
        QDir(dir).removeRecursively();
}

} // namespace nexa
