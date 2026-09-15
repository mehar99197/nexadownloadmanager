#include "grabber/HlsGrabber.h"
#include "core/ExternalTools.h"
#include "auth/AuthUtils.h"
#include "auth/CloudProviders.h"
#include "web/PublicUrlPolicy.h"

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
#include <QUuid>

namespace nexa {

// isSensitiveHeader() / isCredentialHeader() come from auth/AuthUtils.h. The
// second is the one that matters here: it is what start() tests to decide
// whether this stream can be handed to FFmpeg at all, since FFmpeg takes headers
// only on its command line and argv is readable by other local processes.

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
    return m_tempPath;
}

void HlsGrabber::setConcurrency(int n)
{
    m_concurrency = qBound(1, n, 64);
}

// True when this stream needs a secret header that FFmpeg cannot be given
// safely. Decides which of the two download strategies start() uses.
bool HlsGrabber::needsCredentialedFetch() const
{
    const HeaderList headers = scopedHeaders(m_url);
    for (const auto &h : headers)
        if (isCredentialHeader(h.first))
            return true;
    return false;
}

HeaderList HlsGrabber::scopedHeaders(const QUrl &target) const
{
    const QString host = target.host().toLower();
    const bool inScope = !m_credentialHost.isEmpty()
        && (host == m_credentialHost
            || (m_providers && m_providers->sameCredentialScope(host, m_credentialHost)));
    HeaderList out;
    out.reserve(m_headers.size());
    for (const auto &h : m_headers) {
        if (!isSensitiveHeader(h.first) || inScope)
            out.append(h);
    }
    return out;
}

void HlsGrabber::setState(DownloadState s, const QString &detail)
{
    m_state = s;
    // A failed grab can't be resumed from its partial temp files (HLS restarts
    // from scratch), so drop them now instead of leaking a temp dir per error
    // until the job is eventually removed.
    if (s == DownloadState::Error)
        cleanupTemp();
    emit stateChanged(m_id, s, detail);
}

void HlsGrabber::start()
{
    if (m_publicNetworkOnly && !isPublicHttpUrl(m_url)) {
        setState(DownloadState::Error,
                 QStringLiteral("stream target is not a public HTTP(S) address"));
        return;
    }
    // HLS has no partial resume: a (re)start downloads from scratch. Reset all
    // per-run state and clear any stale temp dir so a restart after a cancel or
    // error can't append to the previous run's segment list or files.
    cleanupTemp();
    ++m_runGen;            // any reply tagged with an older gen is now stale
    m_cancelled = false;
    m_resolvedVariant = false;
    m_segments.clear();
    m_nextToFetch = 0;
    m_inFlight = 0;
    m_doneCount = 0;
    m_bytes = 0;
    m_localPlaylist.clear();
    m_redirects = 0;

    const QString base = QStandardPaths::writableLocation(QStandardPaths::TempLocation);
    m_tempPath = QDir(base).filePath(
        QStringLiteral("nexa-stream-%1").arg(QUuid::createUuid().toString(QUuid::Id128)));

    m_clock.start();
    QDir().mkpath(tempDir());
    QFile::setPermissions(tempDir(), QFileDevice::ReadOwner |
                                      QFileDevice::WriteOwner |
                                      QFileDevice::ExeOwner);

    // Two strategies, chosen by whether this stream needs a credential.
    //
    // Default — hand the playlist straight to FFmpeg. Its built-in HLS client
    // has robust retry logic and handles AES-128 encryption, multi-bitrate
    // variant selection and redirects better than replaying individual segment
    // URLs through QNetworkAccessManager ourselves. The per-segment path was the
    // original design (for progress granularity), but a segment download that
    // silently failed left a local playlist referencing missing files, which
    // surfaced as an opaque "FFmpeg mux failed (code 8)".
    //
    // Exception — a stream behind a login. FFmpeg accepts headers only on its
    // command line, and argv is readable by other processes on this machine, so
    // handing it a session cookie is not an option. Those streams go through the
    // per-segment path instead: the credential travels inside Qt's network stack
    // and FFmpeg only ever sees local files. Before this split such a stream got
    // no credential at all and simply 403'd.
    if (needsCredentialedFetch()) {
        setState(DownloadState::Probing, QStringLiteral("fetching playlist"));
        fetchPlaylist(m_url);
    } else {
        muxViaFfmpegDirect();
    }
}

void HlsGrabber::cancel()
{
    m_cancelled = true;
    if (QNetworkReply *r = m_playlistReply) {
        // Null the member BEFORE abort(): it fires finished() synchronously,
        // and onPlaylistFetched() bailing out on m_cancelled would otherwise
        // leave the reply undeleted until the grabber itself goes away.
        m_playlistReply = nullptr;
        r->disconnect(this);
        r->abort();
        r->deleteLater();
    }
    // Disconnect BEFORE killing: otherwise the killed process's finished() fires
    // onMuxFinished, which would overwrite this "cancelled" state with an Error.
    if (m_ffmpeg) {
        m_ffmpeg->disconnect(this);
        m_ffmpeg->kill();
        m_ffmpeg->deleteLater();
        m_ffmpeg = nullptr;
    }
    cleanupTemp();   // partial segments are unusable on the next (scratch) start
    setState(DownloadState::Paused, QStringLiteral("cancelled"));
}

void HlsGrabber::fetchPlaylist(const QUrl &u)
{
    // Unconditional, even for a trusted local download: a master playlist names
    // its variant URI, and QNetworkAccessManager will happily GET a file:// one.
    // The public-network rule below is the untrusted-caller policy; this is the
    // floor underneath it.
    const QString scheme = u.scheme().toLower();
    if (scheme != QLatin1String("http") && scheme != QLatin1String("https")) {
        setState(DownloadState::Error, QStringLiteral("playlist target is not HTTP(S)"));
        return;
    }
    if (m_publicNetworkOnly && !isPublicHttpUrl(u)) {
        setState(DownloadState::Error,
                 QStringLiteral("playlist target is not a public HTTP(S) address"));
        return;
    }
    QNetworkRequest req(u);
    req.setHeader(QNetworkRequest::UserAgentHeader, QStringLiteral("Nexa/0.1"));
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                     QNetworkRequest::ManualRedirectPolicy);
    for (const auto &h : scopedHeaders(u))
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
    const int status = r->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    if (status >= 300 && status < 400) {
        if (++m_redirects > 8) {
            setState(DownloadState::Error, QStringLiteral("too many playlist redirects"));
            return;
        }
        const QByteArray location = r->rawHeader("Location");
        const QUrl target = location.isEmpty() ? QUrl()
            : r->url().resolved(QUrl::fromEncoded(location));
        const QString scheme = target.scheme().toLower();
        if (!target.isValid() || (scheme != QLatin1String("http") &&
                                  scheme != QLatin1String("https"))) {
            setState(DownloadState::Error, QStringLiteral("playlist redirect is not HTTP(S)"));
            return;
        }
        m_url = target;
        fetchPlaylist(target);
        return;
    }
    // Resolve relative URIs against the *final* (possibly redirected) URL.
    const QUrl finalUrl = r->url();
    if (finalUrl.isValid())
        m_url = finalUrl;

    // A real m3u8 is small; reject oversized responses BEFORE reading the body.
    const qint64 cl = r->header(QNetworkRequest::ContentLengthHeader).toLongLong();
    if (cl > 8 * 1024 * 1024) {
        setState(DownloadState::Error, QStringLiteral("playlist too large"));
        return;
    }
    const QByteArray body = r->readAll();
    if (body.size() > 8 * 1024 * 1024) {
        setState(DownloadState::Error, QStringLiteral("playlist too large"));
        return;
    }
    const QString text = QString::fromUtf8(body);
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

// A tag carrying a URI= attribute is refused. See the long note at its call
// site in handleMedia() for why: FFmpeg's HLS demuxer opens the URI on several
// tags, and only #EXT-X-KEY and #EXT-X-MAP are inspected before that point.
bool HlsGrabber::tagIsSafeToMirror(const QString &tagLine)
{
    if (!tagLine.startsWith(QLatin1Char('#')))
        return false;
    return !tagLine.contains(QLatin1String("URI="), Qt::CaseInsensitive);
}

void HlsGrabber::handleMedia(const QString &text)
{
    const QStringList lines = text.split('\n');

    // A segment/key/init URI from an untrusted playlist must be http(s) ONLY:
    // `file:///etc/passwd` (local-file read) or an internal-network http target
    // (SSRF) would otherwise be fetched and muxed into the output the user opens.
    auto httpOk = [this](const QUrl &u) {
        const QString s = u.scheme().toLower();
        return (s == QStringLiteral("http") || s == QStringLiteral("https"))
            && (!m_publicNetworkOnly || isPublicHttpUrl(u));
    };
    // Cap the number of segments so a malicious/huge playlist can't exhaust
    // memory / file descriptors / disk or freeze the UI building the list.
    constexpr int kMaxSegments = 100000;

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
                if (!httpOk(keyAbs)) {
                    setState(DownloadState::Error,
                             QStringLiteral("playlist key URI is not http(s)"));
                    return;
                }
                fixed.replace(m.captured(0),
                              QStringLiteral("URI=\"%1\"").arg(keyAbs.toString()));
            }
            out += fixed + '\n';
            continue;
        }
        // fMP4/CMAF initialization segment. Download it (with our auth headers) like
        // any other segment and rewrite the URI to the local file — otherwise the
        // relative "init.mp4" stays relative and FFmpeg can't fetch it (mux fails).
        if (line.startsWith(QStringLiteral("#EXT-X-MAP"))) {
            QString fixed = line;
            const auto m = QRegularExpression(QStringLiteral("URI=\"([^\"]+)\"")).match(line);
            if (m.hasMatch()) {
                Segment seg;
                seg.url = m_url.resolved(QUrl(m.captured(1)));
                if (!httpOk(seg.url)) {
                    setState(DownloadState::Error,
                             QStringLiteral("playlist init-segment URI is not http(s)"));
                    return;
                }
                if (m_segments.size() >= kMaxSegments) {
                    setState(DownloadState::Error, QStringLiteral("playlist too large"));
                    return;
                }
                seg.localFile = QStringLiteral("init%1.mp4").arg(segIndex, 5, 10, QChar('0'));
                m_segments.append(seg);
                fixed.replace(m.captured(0),
                              QStringLiteral("URI=\"%1\"").arg(seg.localFile));
                ++segIndex;
            }
            out += fixed + '\n';
            continue;
        }
        // Every OTHER tag is mirrored verbatim — but only if it carries no URI.
        //
        // This is the hole that used to be here. Exactly two tags were inspected
        // above (#EXT-X-KEY and #EXT-X-MAP); everything else beginning with '#'
        // was copied straight into the local index.m3u8 that FFmpeg is then
        // handed with `-protocol_whitelist file,crypto,http,https,tcp,tls`.
        // HLS has several other URI-bearing tags — #EXT-X-MEDIA,
        // #EXT-X-I-FRAME-STREAM-INF, #EXT-X-SESSION-KEY/DATA, and the LL-HLS
        // trio #EXT-X-PART / #EXT-X-PRELOAD-HINT / #EXT-X-RENDITION-REPORT — and
        // FFmpeg's HLS demuxer opens the URI on several of them. So a hostile
        // playlist could smuggle a target past BOTH checks that guard this path:
        // the http(s)-only rule and isPublicHttpUrl(). Verified against
        // ffmpeg 8.1: a rendition URI of http://127.0.0.1:9911/ was fetched, and
        // one of file:///... was opened for reading.
        //
        // Nothing legitimate is lost by dropping them. By this point every
        // segment has been downloaded and rewritten to a local file, so the
        // playlist we emit is self-contained; alternate renditions, I-frame
        // streams and low-latency hints are not part of what we mux.
        if (line.startsWith('#')) {
            if (tagIsSafeToMirror(line))
                out += line + '\n';
            continue;
        }

        // A media segment URI.
        Segment seg;
        seg.url = m_url.resolved(QUrl(line));
        if (!httpOk(seg.url)) {
            setState(DownloadState::Error,
                     QStringLiteral("playlist segment URI is not http(s)"));
            return;
        }
        if (m_segments.size() >= kMaxSegments) {
            setState(DownloadState::Error, QStringLiteral("playlist too large"));
            return;
        }
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
    while (m_inFlight < m_concurrency && m_nextToFetch < m_segments.size()) {
        const int idx = m_nextToFetch++;
        startSegmentRequest(idx, 0);
        ++m_inFlight;
    }
}

void HlsGrabber::startSegmentRequest(int index, int redirects)
{
    const Segment &seg = m_segments.at(index);
    // Own manager per request to dodge the 6-connections-per-host cap.
    auto *nam = new QNetworkAccessManager(this);
    QNetworkRequest req(seg.url);
    req.setHeader(QNetworkRequest::UserAgentHeader, QStringLiteral("Nexa/0.1"));
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                     QNetworkRequest::ManualRedirectPolicy);
    for (const auto &h : scopedHeaders(seg.url))
        req.setRawHeader(h.first, h.second);

    QNetworkReply *reply = nam->get(req);
    reply->setProperty("segIndex", index);
    reply->setProperty("redirects", redirects);
    reply->setProperty("gen", m_runGen);
    reply->setProperty("ownNam", QVariant::fromValue<void*>(nam));
    connect(reply, &QNetworkReply::finished, this, &HlsGrabber::onSegmentFinished);
}

void HlsGrabber::onSegmentFinished()
{
    auto *reply = qobject_cast<QNetworkReply*>(sender());
    if (!reply)
        return;
    const int idx = reply->property("segIndex").toInt();
    auto *nam = static_cast<QNetworkAccessManager*>(reply->property("ownNam").value<void*>());

    // Reject replies from a previous run (a cancel/restart bumped m_runGen) or
    // after we've cancelled / already errored. These mustn't touch m_inFlight or
    // index into the current m_segments — the old index may be out of bounds.
    const bool stale = reply->property("gen").toInt() != m_runGen ||
                       m_cancelled || m_state == DownloadState::Error;
    if (stale) {
        reply->deleteLater();
        if (nam) nam->deleteLater();
        return;
    }

    --m_inFlight;

    const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    if (status >= 300 && status < 400) {
        const int redirects = reply->property("redirects").toInt();
        const QByteArray location = reply->rawHeader("Location");
        const QUrl target = location.isEmpty() ? QUrl()
            : reply->url().resolved(QUrl::fromEncoded(location));
        const QString scheme = target.scheme().toLower();
        if (redirects >= 8 || !target.isValid() ||
            (scheme != QLatin1String("http") && scheme != QLatin1String("https")) ||
            (m_publicNetworkOnly && !isPublicHttpUrl(target))) {
            reply->deleteLater();
            if (nam) nam->deleteLater();
            setState(DownloadState::Error, QStringLiteral("invalid segment redirect"));
            return;
        }
        m_segments[idx].url = target;
        reply->deleteLater();
        if (nam) nam->deleteLater();
        ++m_inFlight;
        startSegmentRequest(idx, redirects + 1);
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

    if (idx < 0 || idx >= m_segments.size())   // defense-in-depth (gen guard already covers this)
        return;
    QFile f(tempDir() + QStringLiteral("/") + m_segments[idx].localFile);
    if (!f.open(QIODevice::WriteOnly) || f.write(data) != data.size()) {
        // A missing/truncated segment file would make FFmpeg fail later with an
        // opaque error; surface it now as a clear segment error.
        setState(DownloadState::Error, QStringLiteral("cannot write segment %1").arg(idx));
        return;
    }
    f.close();
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
    const QString ffmpeg = resolveTool(QStringLiteral("ffmpeg"));
    if (ffmpeg.isEmpty()) {
        setState(DownloadState::Error, QStringLiteral("FFmpeg is not installed or executable"));
        return;
    }
    setState(DownloadState::Downloading, QStringLiteral("muxing to MP4"));
    QDir().mkpath(QFileInfo(m_savePath).absolutePath());

    m_ffmpeg = new QProcess(this);
    m_ffmpeg->setWorkingDirectory(tempDir());
    const QStringList args = {
        QStringLiteral("-y"),
        QStringLiteral("-rw_timeout"), QStringLiteral("30000000"),   // 30s I/O timeout
        QStringLiteral("-allowed_extensions"), QStringLiteral("ALL"),
        QStringLiteral("-protocol_whitelist"), QStringLiteral("file,crypto,http,https,tcp,tls"),
        QStringLiteral("-i"), m_localPlaylist,
        QStringLiteral("-c"), QStringLiteral("copy"),
        QStringLiteral("-bsf:a"), QStringLiteral("aac_adtstoasc"),
        m_savePath
    };
    connect(m_ffmpeg, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished),
            this, [this](int code, QProcess::ExitStatus) { onMuxFinished(code); });
    connect(m_ffmpeg, &QProcess::errorOccurred, this,
            [this](QProcess::ProcessError error) {
        if (!m_cancelled && error == QProcess::FailedToStart)
            setState(DownloadState::Error, QStringLiteral("FFmpeg could not be started"));
    });
    m_ffmpeg->start(ffmpeg, args);   // bundled exe isn't on PATH on Windows
    m_ffmpeg->closeWriteChannel();   // EOF on stdin: ffmpeg never blocks on a prompt
}

void HlsGrabber::muxViaFfmpegDirect()
{
    if (m_publicNetworkOnly && !isPublicHttpUrl(m_url)) {
        setState(DownloadState::Error,
                 QStringLiteral("stream target is not a public HTTP(S) address"));
        return;
    }
    const QString ffmpeg = resolveTool(QStringLiteral("ffmpeg"));
    if (ffmpeg.isEmpty()) {
        setState(DownloadState::Error, QStringLiteral("FFmpeg is not installed or executable"));
        return;
    }
    setState(DownloadState::Downloading, QStringLiteral("downloading via FFmpeg"));
    QDir().mkpath(QFileInfo(m_savePath).absolutePath());

    QStringList args = { QStringLiteral("-y"),
                         // Machine-readable progress on stdout instead of the
                         // human "frame= … size= …" stats on stderr, which
                         // nothing read. Without it this path emitted no
                         // progress at all: a stream sat at 0 B with no size,
                         // speed or ETA for its entire download.
                         QStringLiteral("-nostats"),
                         QStringLiteral("-progress"), QStringLiteral("pipe:1"),
                         QStringLiteral("-rw_timeout"), QStringLiteral("30000000"),
                         QStringLiteral("-protocol_whitelist"),
                         // `crypto` is REQUIRED for AES-128 HLS (#EXT-X-KEY):
                         // ffmpeg opens each encrypted segment through the crypto
                         // protocol, and without it every such stream dies with
                         // "Protocol 'crypto' not on whitelist" and writes nothing.
                         // `file` is deliberately NOT listed here — this path takes
                         // a REMOTE playlist, so allowing file: would let a hostile
                         // playlist mux local files into the user's output.
                         QStringLiteral("crypto,http,https,tcp,tls") };  // 30s I/O timeout
    // Forward captured headers (cookies/UA/referrer) to FFmpeg. Strip any CR/LF
    // from values so a header can't smuggle extra request headers into ffmpeg.
    auto noCRLF = [](const QString &s) { QString o = s; o.remove('\r'); o.remove('\n'); return o; };
    QString hdr;
    QString ua;
    // Credential-bearing headers never reach this path — start() routes a stream
    // that needs one through the per-segment fetch instead. The guard stays as a
    // second line of defence: nothing may put a secret into argv here.
    for (const auto &h : scopedHeaders(m_url)) {
        if (isCredentialHeader(h.first))
            continue;
        if (h.first.compare("User-Agent", Qt::CaseInsensitive) == 0)
            ua = noCRLF(QString::fromUtf8(h.second));
        else
            hdr += noCRLF(QString::fromUtf8(h.first)) + ": "
                 + noCRLF(QString::fromUtf8(h.second)) + "\r\n";
    }
    if (!ua.isEmpty()) args << QStringLiteral("-user_agent") << ua;
    if (!hdr.isEmpty()) args << QStringLiteral("-headers") << hdr;
    args << QStringLiteral("-i") << m_url.toString()
         << QStringLiteral("-c") << QStringLiteral("copy")
         << m_savePath;

    m_progressTail.clear();
    m_ffmpeg = new QProcess(this);
    connect(m_ffmpeg, &QProcess::readyReadStandardOutput,
            this, &HlsGrabber::onFfmpegProgress);
    connect(m_ffmpeg, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished),
            this, [this](int code, QProcess::ExitStatus) { onMuxFinished(code); });
    connect(m_ffmpeg, &QProcess::errorOccurred, this,
            [this](QProcess::ProcessError error) {
        if (!m_cancelled && error == QProcess::FailedToStart)
            setState(DownloadState::Error, QStringLiteral("FFmpeg could not be started"));
    });
    m_ffmpeg->start(ffmpeg, args);   // bundled exe isn't on PATH on Windows
    m_ffmpeg->closeWriteChannel();   // EOF on stdin: ffmpeg never blocks on a prompt
}

// FFmpeg's `-progress pipe:1` stream: blocks of key=value lines, each block
// terminated by "progress=continue" (or "progress=end"). `total_size` is how
// many bytes it has written to the output so far, which is the only meaningful
// progress figure for a stream whose final length nobody knows up front.
void HlsGrabber::onFfmpegProgress()
{
    if (!m_ffmpeg || m_cancelled)
        return;
    m_progressTail += m_ffmpeg->readAllStandardOutput();

    bool blockEnded = false;
    qsizetype nl;
    while ((nl = m_progressTail.indexOf('\n')) >= 0) {
        const QByteArray line = m_progressTail.left(nl).trimmed();
        m_progressTail.remove(0, nl + 1);
        const qsizetype eq = line.indexOf('=');
        if (eq <= 0)
            continue;
        const QByteArray key = line.left(eq).trimmed();
        const QByteArray value = line.mid(eq + 1).trimmed();
        if (key == "progress") {
            blockEnded = true;
        } else if (key == "total_size") {
            bool ok = false;
            const qint64 written = value.toLongLong(&ok);
            if (ok && written >= 0)
                m_bytes = written;
        }
    }
    // A build that doesn't speak -progress would otherwise grow this buffer for
    // the life of the download; it is line-oriented or it is not used at all.
    if (m_progressTail.size() > 8 * 1024)
        m_progressTail.clear();
    if (!blockEnded)
        return;

    const qint64 elapsed = m_clock.elapsed();
    const double bps = elapsed > 0 ? double(m_bytes) * 1000.0 / double(elapsed) : 0.0;
    // total = -1: an adaptive stream has no size until it is muxed, and the UI
    // already renders that as "unknown" rather than inventing a percentage.
    emit progress(m_id, m_bytes, -1, bps);
}

void HlsGrabber::onMuxFinished(int exitCode)
{
    // A late finish from a process we already killed on cancel must not resurrect
    // an Error/Completed state over the user's "cancelled".
    if (m_cancelled) {
        if (m_ffmpeg) { m_ffmpeg->deleteLater(); m_ffmpeg = nullptr; }
        return;
    }
    const bool ok = (exitCode == 0) && QFileInfo::exists(m_savePath) &&
                    QFileInfo(m_savePath).size() > 0;
    if (m_ffmpeg) { m_ffmpeg->deleteLater(); m_ffmpeg = nullptr; }
    cleanupTemp();

    if (ok) {
        // The finished file on disk is the authoritative size. m_bytes tracks
        // FFmpeg's output counter on the direct path and downloaded bytes on the
        // segment path — neither is the answer, and the old placeholder of 1
        // reported every completed stream to the UI and the phone dashboard as
        // being one byte long.
        const qint64 finalSize = QFileInfo(m_savePath).size();
        const qint64 total = finalSize > 0 ? finalSize : qMax<qint64>(m_bytes, 0);
        emit progress(m_id, total, total, 0.0);
        setState(DownloadState::Completed, QStringLiteral("saved %1").arg(fileName()));
        emit finished(m_id);
    } else {
        setState(DownloadState::Error, QStringLiteral("FFmpeg mux failed (code %1)").arg(exitCode));
    }
}

void HlsGrabber::cleanupTemp()
{
    const QString dir = tempDir();
    if (!dir.isEmpty() && QDir(dir).exists())
        QDir(dir).removeRecursively();
    m_tempPath.clear();
}

} // namespace nexa
