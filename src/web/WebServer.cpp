#include "web/WebServer.h"
#include "core/DownloadEngine.h"

#include <QTcpServer>
#include <QTcpSocket>
#include <QSslServer>
#include <QSslSocket>
#include <QSslConfiguration>
#include <QSslCertificate>
#include <QSslKey>
#include <QHostAddress>
#include <QDateTime>
#include <QTimer>
#include <QFile>
#include <QJsonDocument>
#include <QJsonArray>
#include <QJsonObject>
#include <QUrl>
#include <QUrlQuery>
#include <QDebug>

namespace nexa {

namespace {

const char *reasonPhrase(int code)
{
    switch (code) {
        case 200: return "OK";
        case 204: return "No Content";
        case 400: return "Bad Request";
        case 401: return "Unauthorized";
        case 404: return "Not Found";
        case 405: return "Method Not Allowed";
        case 413: return "Payload Too Large";
        case 429: return "Too Many Requests";
        default:  return "Internal Server Error";
    }
}

// The dashboard is a single self-contained page; it reads its auth token from
// its own query string and forwards it on every API call.
QByteArray dashboardPage()
{
    return QByteArrayLiteral(R"HTML(<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Nexa — Remote</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font:14px/1.5 system-ui,sans-serif; background:#0f172a; color:#e2e8f0; }
  header { padding:14px 18px; background:#1e293b; font-size:18px; font-weight:600; position:sticky; top:0; }
  .wrap { padding:16px; max-width:980px; margin:0 auto; }
  form { display:flex; gap:8px; margin-bottom:16px; }
  input[type=text] { flex:1; padding:10px; border-radius:8px; border:1px solid #334155; background:#0b1220; color:#e2e8f0; }
  button { padding:10px 14px; border:0; border-radius:8px; background:#3b82f6; color:#fff; font-weight:600; cursor:pointer; }
  button.s { padding:6px 10px; font-size:12px; background:#334155; }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid #1e293b; vertical-align:middle; }
  th { color:#94a3b8; font-weight:600; font-size:12px; text-transform:uppercase; }
  .bar { height:8px; background:#1e293b; border-radius:6px; overflow:hidden; min-width:120px; }
  .bar > i { display:block; height:100%; background:#3b82f6; }
  .muted { color:#94a3b8; }
  .pill { font-size:12px; padding:2px 8px; border-radius:999px; background:#1e293b; }
  .actions { display:flex; gap:6px; }
</style>
</head>
<body>
<header>⬇ Nexa Download Manager — Remote</header>
<div class="wrap">
  <form id="addf">
    <input id="url" type="text" placeholder="Paste a URL, magnet link, or .m3u8 / file[1-20].jpg pattern…" autocomplete="off"/>
    <button type="submit">Add</button>
  </form>
  <table>
    <thead><tr><th>File</th><th>Size</th><th>Progress</th><th>Speed</th><th>Status</th><th></th></tr></thead>
    <tbody id="rows"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody>
  </table>
</div>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
// Send the token as a Bearer header, not in the URL, so it stays out of
// access logs / history / Referer on every API call.
const authHeaders = token ? { 'Authorization': 'Bearer ' + token } : {};
function api(path, opts){ opts = opts || {}; opts.headers = Object.assign({}, opts.headers||{}, authHeaders); return fetch(path, opts); }
function human(b){ if(b<0) return '?'; const u=['B','KB','MB','GB','TB']; let i=0,v=b; while(v>=1024&&i<4){v/=1024;i++;} return v.toFixed(i?1:0)+' '+u[i]; }
async function post(path){ try{ await api(path,{method:'POST'}); }catch(e){} refresh(); }
document.getElementById('addf').addEventListener('submit', async e=>{
  e.preventDefault();
  const url=document.getElementById('url').value.trim(); if(!url) return;
  try{ await api('/api/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})}); }catch(e){}
  document.getElementById('url').value=''; refresh();
});
function row(d){
  const pct = d.total>0 ? Math.floor(d.done*100/d.total) : (d.state==='Completed'?100:0);
  const size = d.total>0 ? human(d.total) : (d.done>0?human(d.done):'?');
  const spd = d.speed>1 ? human(d.speed)+'/s' : '';
  const canPause = d.state==='Downloading'||d.state==='Probing';
  const canResume = d.state==='Paused'||d.state==='Error';
  return `<tr>
    <td>${esc(d.name)}</td><td class="muted">${size}</td>
    <td><div class="bar"><i style="width:${pct}%"></i></div><span class="muted">${pct}%</span></td>
    <td class="muted">${spd}</td>
    <td><span class="pill">${esc(d.state)}</span></td>
    <td><div class="actions">
      ${canPause?`<button class="s" onclick="post('/api/pause?id=${d.id}')">Pause</button>`:''}
      ${canResume?`<button class="s" onclick="post('/api/resume?id=${d.id}')">Resume</button>`:''}
      <button class="s" onclick="post('/api/remove?id=${d.id}')">Remove</button>
    </div></td></tr>`;
}
function esc(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
async function refresh(){
  try{
    const r = await api('/api/downloads'); const list = await r.json();
    document.getElementById('rows').innerHTML = list.length
      ? list.map(row).join('') : '<tr><td colspan="6" class="muted">No downloads yet.</td></tr>';
  }catch(e){}
}
refresh(); setInterval(refresh, 1000);
</script>
</body>
</html>
)HTML");
}

} // namespace

WebServer::WebServer(DownloadEngine *engine, QObject *parent)
    : QObject(parent), m_engine(engine)
{
}

// If NEXA_TLS_CERT + NEXA_TLS_KEY point at a PEM cert/key, build a QSslServer so
// the dashboard is served over HTTPS (QSslSocket is a QTcpSocket, so the rest of
// the server is unchanged). Returns nullptr if TLS wasn't requested or failed,
// so the caller falls back to plain HTTP.
static QSslServer *makeTlsServer(QObject *parent)
{
    const QString certPath = qEnvironmentVariable("NEXA_TLS_CERT");
    const QString keyPath  = qEnvironmentVariable("NEXA_TLS_KEY");
    if (certPath.isEmpty() || keyPath.isEmpty())
        return nullptr;

    QFile cf(certPath), kf(keyPath);
    if (!cf.open(QIODevice::ReadOnly) || !kf.open(QIODevice::ReadOnly)) {
        qWarning() << "Nexa TLS: cannot read cert/key; serving plain HTTP";
        return nullptr;
    }
    const QSslCertificate cert(&cf, QSsl::Pem);
    const QByteArray keyPem = kf.readAll();
    // PEM private keys may be RSA, EC or DSA — try each until one parses.
    QSslKey key(keyPem, QSsl::Rsa, QSsl::Pem);
    if (key.isNull()) key = QSslKey(keyPem, QSsl::Ec,  QSsl::Pem);
    if (key.isNull()) key = QSslKey(keyPem, QSsl::Dsa, QSsl::Pem);
    if (cert.isNull() || key.isNull()) {
        qWarning() << "Nexa TLS: invalid cert/key; serving plain HTTP";
        return nullptr;
    }

    auto *ssl = new QSslServer(parent);
    QSslConfiguration cfg = QSslConfiguration::defaultConfiguration();
    cfg.setLocalCertificate(cert);
    cfg.setPrivateKey(key);
    ssl->setSslConfiguration(cfg);
    // A client that opens a TCP connection but never finishes the TLS handshake
    // isn't covered by the per-request idle timer (that only arms once a socket
    // surfaces as a connection), so bound the handshake itself and log failures
    // (a silent dead-but-bound port is otherwise hard to diagnose).
    ssl->setHandshakeTimeout(15000);
    QObject::connect(ssl, &QSslServer::errorOccurred, ssl,
                     [](QSslSocket *, QAbstractSocket::SocketError e) {
        qWarning() << "Nexa TLS handshake error:" << e;
    });
    return ssl;
}

bool WebServer::start(quint16 port, bool lanAccessible, const QString &token)
{
    m_token = token;
    if (QSslServer *ssl = makeTlsServer(this)) {
        m_server = ssl;
        m_tls = true;
    } else {
        m_server = new QTcpServer(this);
    }
    connect(m_server, &QTcpServer::newConnection, this, &WebServer::onNewConnection);

    const QHostAddress addr = lanAccessible ? QHostAddress::Any : QHostAddress::LocalHost;
    if (!m_server->listen(addr, port)) {
        qWarning() << "Nexa web server failed to bind port" << port << ":"
                   << m_server->errorString();
        return false;
    }
    m_port = m_server->serverPort();
    return true;
}

void WebServer::onNewConnection()
{
    while (m_server->hasPendingConnections()) {
        QTcpSocket *sock = m_server->nextPendingConnection();

        // Refuse new work past the cap so a flood of sockets can't exhaust file
        // descriptors / memory on the GUI thread's event loop.
        if (m_conns.size() >= kMaxConnections) {
            sock->abort();
            sock->deleteLater();
            continue;
        }

        Conn conn;
        conn.timer = new QTimer(sock);              // dies with the socket
        conn.timer->setSingleShot(true);
        m_conns.insert(sock, conn);

        connect(conn.timer, &QTimer::timeout, this, [this, sock] { closeConnection(sock); });
        connect(sock, &QTcpSocket::readyRead, this, [this, sock] {
            if (auto it = m_conns.find(sock); it != m_conns.end())
                it->timer->start(kIdleTimeoutMs);   // reset the idle deadline
            onReadyRead(sock);
        });
        connect(sock, &QTcpSocket::disconnected, this, [this, sock] {
            m_conns.remove(sock);
            sock->deleteLater();
        });
        conn.timer->start(kIdleTimeoutMs);
    }
}

void WebServer::closeConnection(QTcpSocket *sock)
{
    if (!m_conns.contains(sock))
        return;
    m_conns.remove(sock);
    // Drop our readyRead/disconnected handlers first: abort() emits disconnected
    // synchronously, and without this that slot would also run m_conns.remove +
    // deleteLater on the same socket. Disconnecting makes teardown happen once.
    sock->disconnect(this);
    sock->abort();
    sock->deleteLater();
}

void WebServer::onReadyRead(QTcpSocket *sock)
{
    auto it = m_conns.find(sock);
    if (it == m_conns.end())
        return;
    QByteArray &buf = it->buffer;
    buf.append(sock->readAll());

    if (buf.size() > kMaxRequestBytes) {
        sendResponse(sock, 413, QStringLiteral("text/plain"), "too large");
        closeConnection(sock);   // drop the buffer/state now, don't wait on the FIN
        return;
    }

    Request req;
    bool needMore = false;
    if (!tryParse(buf, req, needMore)) {
        if (!needMore)
            sendResponse(sock, 400, QStringLiteral("text/plain"), "bad request");
        return;   // needMore: wait for the rest of the request (timer guards it)
    }
    dispatch(sock, req);
}

bool WebServer::tryParse(const QByteArray &buf, Request &req, bool &needMore) const
{
    const int headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
        needMore = true;
        return false;
    }

    const QByteArray head = buf.left(headerEnd);
    const QList<QByteArray> lines = head.split('\n');
    if (lines.isEmpty())
        return false;

    // Split the request line on whitespace, ignoring runs of spaces so a
    // malformed "GET   /  HTTP/1.1" doesn't shift the target token.
    QList<QByteArray> parts;
    for (const QByteArray &p : lines.first().trimmed().split(' ')) {
        if (!p.isEmpty())
            parts.append(p);
    }
    if (parts.size() < 2)
        return false;
    req.method = QString::fromLatin1(parts.at(0));

    const QUrl target = QUrl::fromEncoded(parts.at(1), QUrl::TolerantMode);
    req.path = target.path();
    const QUrlQuery qy(target);
    for (const auto &item : qy.queryItems(QUrl::FullyDecoded))
        req.query.insert(item.first, item.second);

    for (int i = 1; i < lines.size(); ++i) {
        const QByteArray line = lines.at(i).trimmed();
        const int colon = line.indexOf(':');
        if (colon <= 0)
            continue;
        const QString key = QString::fromLatin1(line.left(colon)).trimmed().toLower();
        // Reject a request that presents two conflicting Content-Length headers
        // (a classic request-smuggling vector) rather than last-wins silently.
        if (key == QLatin1String("content-length") && req.headers.contains(key)
            && req.headers.value(key) != QString::fromUtf8(line.mid(colon + 1)).trimmed())
            return false;   // -> 400
        req.headers.insert(key, QString::fromUtf8(line.mid(colon + 1)).trimmed());
    }

    // We don't implement chunked transfer decoding; reject it explicitly rather
    // than silently mishandling the body.
    if (req.headers.value(QStringLiteral("transfer-encoding"))
            .contains(QLatin1String("chunked"), Qt::CaseInsensitive))
        return false;   // -> 400

    const int bodyStart = headerEnd + 4;
    qint64 contentLength = 0;
    if (req.headers.contains(QStringLiteral("content-length"))) {
        bool ok = false;
        contentLength = req.headers.value(QStringLiteral("content-length")).toLongLong(&ok);
        if (!ok || contentLength < 0 || contentLength > kMaxRequestBytes)
            return false;   // malformed / oversized declared length -> 400
    }
    if (contentLength > 0) {
        if (buf.size() - bodyStart < contentLength) {
            needMore = true;
            return false;
        }
        req.body = buf.mid(bodyStart, int(contentLength));
    }
    return true;
}

void WebServer::dispatch(QTcpSocket *sock, const Request &req)
{
    // CORS preflight: answered before the auth gate (the browser sends OPTIONS
    // with no Authorization header). The CORS headers ride on every response.
    if (req.method == QLatin1String("OPTIONS")) {
        sendResponse(sock, 204, QStringLiteral("text/plain"), QByteArray());
        return;
    }

    // Auth gate. Prefer an Authorization: Bearer header (the API calls use it);
    // fall back to ?token= for the initial page link the user opens.
    if (!m_token.isEmpty()) {
        const qint64 nowMs = QDateTime::currentMSecsSinceEpoch();
        const QString peer = sock->peerAddress().toString();
        // Per-IP failed-auth rate limit: throttle a client hammering 401s (matters
        // if an operator overrode the strong default with a weak --dashboard-token).
        // Evict expired entries periodically so the map doesn't grow unbounded
        // from distinct IPs probing the server over time.
        if (m_authFails.size() > 1000) {
            for (auto it = m_authFails.begin(); it != m_authFails.end(); )
                it = (nowMs - it->second > kAuthWindowMs) ? m_authFails.erase(it) : ++it;
        }
        auto &f = m_authFails[peer];
        if (nowMs - f.second > kAuthWindowMs)
            f = {0, nowMs};                       // window expired -> reset
        if (f.first >= kMaxAuthFails) {
            sendResponse(sock, 429, QStringLiteral("text/plain"), "too many attempts");
            return;
        }

        QString provided;
        const QString auth = req.headers.value(QStringLiteral("authorization"));
        if (auth.startsWith(QLatin1String("Bearer "), Qt::CaseInsensitive))
            provided = auth.mid(7).trimmed();
        else
            provided = req.query.value(QStringLiteral("token"));
        // Constant-time compare so a LAN attacker can't time-probe the token.
        auto ctEquals = [](const QString &a, const QString &b) {
            const QByteArray x = a.toUtf8(), y = b.toUtf8();
            if (x.size() != y.size()) return false;
            quint8 d = 0;
            for (int i = 0; i < x.size(); ++i) d |= quint8(x[i]) ^ quint8(y[i]);
            return d == 0;
        };
        if (!ctEquals(provided, m_token)) {
            f.first++;                            // count this failure for the window
            sendResponse(sock, 401, QStringLiteral("text/plain"), "unauthorized");
            return;
        }
        m_authFails.remove(peer);                 // success: clear the counter
    }

    if (req.method == QLatin1String("GET") && req.path == QLatin1String("/")) {
        sendResponse(sock, 200, QStringLiteral("text/html; charset=utf-8"), dashboardPage());
        return;
    }
    if (req.path == QLatin1String("/favicon.ico")) {
        sendResponse(sock, 204, QStringLiteral("image/x-icon"), QByteArray());
        return;
    }
    if (req.method == QLatin1String("GET") && req.path == QLatin1String("/api/downloads")) {
        sendJson(sock, 200, downloadsJson());
        return;
    }

    if (req.method == QLatin1String("POST") && req.path == QLatin1String("/api/add")) {
        QString url;
        const QString ctype = req.headers.value(QStringLiteral("content-type"));
        if (ctype.contains(QLatin1String("application/json")) || req.body.trimmed().startsWith('{')) {
            const QJsonObject obj = QJsonDocument::fromJson(req.body).object();
            url = obj.value(QStringLiteral("url")).toString();
        } else {
            QUrlQuery form(QString::fromUtf8(req.body));
            url = form.queryItemValue(QStringLiteral("url"), QUrl::FullyDecoded);
        }
        url = url.trimmed();
        if (url.isEmpty()) {
            sendJson(sock, 400, R"({"ok":false,"error":"missing url"})");
            return;
        }
        // Never let a LAN client read local files via file:// (the dashboard is
        // token-gated but still network-exposed). Patterns/magnets/http unaffected.
        if (QUrl::fromUserInput(url).scheme().compare(QLatin1String("file"), Qt::CaseInsensitive) == 0) {
            sendJson(sock, 400, R"({"ok":false,"error":"unsupported url scheme"})");
            return;
        }
        const QList<int> ids = m_engine->addBatch(url);
        sendJson(sock, 200, QStringLiteral("{\"ok\":true,\"added\":%1}").arg(ids.size()).toUtf8());
        return;
    }

    if (req.method == QLatin1String("POST") && req.path == QLatin1String("/api/ai")) {
        // Cooldown: each AI command hits a paid LLM and can auto-add downloads, so
        // a token-holding client can't drive unbounded spend by spamming it.
        const qint64 nowMs = QDateTime::currentMSecsSinceEpoch();
        if (nowMs - m_lastAiMs < kAiCooldownMs) {
            sendJson(sock, 429, R"({"ok":false,"error":"rate limited; try again shortly"})");
            return;
        }
        m_lastAiMs = nowMs;
        if (!m_engine->aiAvailable()) {
            sendJson(sock, 400, R"({"ok":false,"error":"AI not configured; set ANTHROPIC_API_KEY"})");
            return;
        }
        QString text;
        const QJsonObject obj = QJsonDocument::fromJson(req.body).object();
        text = obj.value(QStringLiteral("text")).toString().trimmed();
        if (text.isEmpty()) {
            sendJson(sock, 400, R"({"ok":false,"error":"missing text"})");
            return;
        }
        m_engine->runAiCommand(text);
        sendJson(sock, 200, R"({"ok":true})");
        return;
    }

    auto idParam = [&]() { return req.query.value(QStringLiteral("id")).toInt(); };

    if (req.method == QLatin1String("POST") && req.path == QLatin1String("/api/pause")) {
        m_engine->pause(idParam());
        sendJson(sock, 200, R"({"ok":true})");
        return;
    }
    if (req.method == QLatin1String("POST") && req.path == QLatin1String("/api/resume")) {
        m_engine->resume(idParam());
        sendJson(sock, 200, R"({"ok":true})");
        return;
    }
    if (req.method == QLatin1String("POST") && req.path == QLatin1String("/api/remove")) {
        m_engine->remove(idParam(), false);
        sendJson(sock, 200, R"({"ok":true})");
        return;
    }

    sendResponse(sock, 404, QStringLiteral("text/plain"), "not found");
}

QByteArray WebServer::downloadsJson() const
{
    QJsonArray arr;
    for (const auto &s : m_engine->snapshot()) {
        QJsonObject o;
        o["id"] = s.id;
        o["name"] = s.name;
        o["state"] = stateToString(s.state);
        o["done"] = double(s.done);
        o["total"] = double(s.total);
        o["speed"] = s.speed;
        arr.append(o);
    }
    return QJsonDocument(arr).toJson(QJsonDocument::Compact);
}

void WebServer::sendJson(QTcpSocket *sock, int code, const QByteArray &json) const
{
    sendResponse(sock, code, QStringLiteral("application/json"), json);
}

void WebServer::sendResponse(QTcpSocket *sock, int code, const QString &contentType,
                             const QByteArray &body) const
{
    QByteArray resp;
    resp += "HTTP/1.1 " + QByteArray::number(code) + ' ' + reasonPhrase(code) + "\r\n";
    resp += "Content-Type: " + contentType.toUtf8() + "\r\n";
    resp += "Content-Length: " + QByteArray::number(body.size()) + "\r\n";
    resp += "Cache-Control: no-store\r\n";
    resp += "Referrer-Policy: no-referrer\r\n";   // keep ?token= out of Referer
    // CORS: the API is gated by a Bearer token (not cookies), so allowing any
    // origin is safe — a cross-origin page still can't call it without the token.
    // This lets custom dashboards / scripts on other origins use the REST API.
    resp += "Access-Control-Allow-Origin: *\r\n";
    resp += "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n";
    resp += "Access-Control-Allow-Headers: Authorization, Content-Type\r\n";
    resp += "Access-Control-Max-Age: 600\r\n";
    resp += "Connection: close\r\n";
    resp += "\r\n";
    resp += body;
    sock->write(resp);
    sock->flush();
    sock->disconnectFromHost();
}

} // namespace nexa
