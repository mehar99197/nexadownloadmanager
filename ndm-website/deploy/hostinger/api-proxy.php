<?php
/**
 * api-proxy.php — /api/* reverse proxy for the Nexa Download Manager backend.
 *
 * Hostinger shared hosting has no nginx and no root: the Node backend listens
 * on 127.0.0.1:3001 outside the web root, and LiteSpeed rewrites every /api/*
 * request to this script (see .htaccess). This script streams the request to
 * the backend and streams the response back, byte for byte, buffering nothing:
 *   - a 1 GB installer PUT flows php://input -> curl -> Node in 64 KB chunks;
 *   - installer downloads (200 and 206 byte-range responses) flow out chunk by
 *     chunk with an explicit flush, so resume/range requests work end to end;
 *   - the Stripe webhook body passes through untouched, which the signature
 *     check requires.
 *
 * Header contract (mirrors deploy/nginx.conf, which this file replaces here):
 *   - Host: the original request host — nginx used `proxy_set_header Host
 *     $host`, and nothing in the backend routes on Host, so parity is safest.
 *   - X-Forwarded-For: client-sent value with REMOTE_ADDR APPENDED. The
 *     backend runs `app.set('trust proxy', TRUST_PROXY)` with exactly one
 *     trusted hop, so Express takes the rightmost (our, truthful) entry for
 *     req.ip — rate limiting and the admin IP allowlist depend on this.
 *   - X-Real-IP / X-Forwarded-Proto: set from the actual connection; any
 *     client-sent values are dropped (spoofing guard). `Forwarded` and
 *     X-Forwarded-Host/-Port/-Server are dropped for the same reason.
 *   - Cookie and Authorization pass through untouched (admin bearer tokens,
 *     the httpOnly refresh cookies, the session-hint cookie).
 *   - Hop-by-hop headers are stripped in both directions per RFC 9110 §7.6.1.
 *   - Every Set-Cookie is forwarded as its own header, never merged — login
 *     responses set two cookies at once.
 *
 * Failure mode: upstream unreachable => 502 {ok:false,error:{code:"UPSTREAM_DOWN"}}
 * in the backend's own error envelope. PHP errors are never displayed.
 *
 * Requires: PHP >= 8.0 with ext-curl (present on Hostinger PHP 8.3). No
 * Composer dependencies.
 */

declare(strict_types=1);

const UPSTREAM_ORIGIN   = 'http://127.0.0.1:3001';
const DEFAULT_HOST      = 'nexadownloadmanager.com';
const CONNECT_TIMEOUT_S = 5;
const CURL_BUFFER_BYTES = 65536;

error_reporting(E_ALL);
@ini_set('display_errors', '0');
@ini_set('log_errors', '1');
@ini_set('zlib.output_compression', '0');
@set_time_limit(0);                     // a 1 GB transfer outlives any default
ignore_user_abort(false);               // we WANT to notice a vanished client
while (ob_get_level() > 0) { @ob_end_clean(); }
header_remove('X-Powered-By');
if (function_exists('apache_setenv')) { @apache_setenv('no-gzip', '1'); }

/** Emit the backend's error envelope and stop. Safe before headers only. */
function bail(int $status, string $code, string $message): void
{
    if (!headers_sent()) {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
    }
    echo json_encode(['ok' => false, 'error' => ['code' => $code, 'message' => $message]]);
    exit;
}

/** Strip anything that could smuggle a header or split a request line. */
function clean(string $v): string
{
    return str_replace(["\r", "\n", "\0"], '', $v);
}

/**
 * The original request headers with their original names.
 *
 * getallheaders() exists under LiteSpeed's LSAPI and preserves exact header
 * names; the $_SERVER fallback reconstructs names from HTTP_* (losing the
 * dash/underscore distinction, which no header we care about uses).
 * Authorization sometimes only survives as REDIRECT_HTTP_AUTHORIZATION after
 * a rewrite — recover it explicitly, since every admin call depends on it.
 */
function incoming_headers(): array
{
    $headers = [];
    if (function_exists('getallheaders')) {
        $all = getallheaders();
        if (is_array($all)) {
            foreach ($all as $name => $value) { $headers[(string)$name] = (string)$value; }
        }
    }
    if ($headers === []) {
        foreach ($_SERVER as $key => $value) {
            if (strncmp($key, 'HTTP_', 5) === 0) {
                $name = str_replace(' ', '-', ucwords(strtolower(str_replace('_', ' ', substr($key, 5)))));
                $headers[$name] = (string)$value;
            }
        }
    }
    $lower = array_change_key_case($headers, CASE_LOWER);
    if (!isset($lower['content-type']) && ($_SERVER['CONTENT_TYPE'] ?? '') !== '') {
        $headers['Content-Type'] = (string)$_SERVER['CONTENT_TYPE'];
    }
    if (!isset($lower['authorization'])) {
        $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
        if ($auth !== '') { $headers['Authorization'] = (string)$auth; }
    }
    return $headers;
}

// ---------------------------------------------------------------------------
// Validate the request line.
// ---------------------------------------------------------------------------

$method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? ''));
if (!in_array($method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'], true)) {
    bail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
}

// REQUEST_URI survives the internal rewrite untouched: original path AND query
// string, still percent-encoded exactly as the client sent them.
$uri = (string)($_SERVER['REQUEST_URI'] ?? '');
if ($uri === '' || $uri[0] !== '/' || $uri !== clean($uri) || strpos($uri, ' ') !== false) {
    bail(400, 'BAD_REQUEST', 'Malformed request URI');
}
if (!preg_match('#^/api(?:[/?]|$)#', $uri)) {
    // Direct hits on /api-proxy.php (or anything else) proxy nothing.
    bail(404, 'NOT_FOUND', 'Not found');
}
$targetUrl = UPSTREAM_ORIGIN . $uri;

// ---------------------------------------------------------------------------
// Build the upstream request headers.
// ---------------------------------------------------------------------------

$stripRequest = [
    // Hop-by-hop (RFC 9110 §7.6.1) — these describe OUR two connections.
    'connection' => 1, 'keep-alive' => 1, 'transfer-encoding' => 1, 'te' => 1,
    'trailer' => 1, 'upgrade' => 1, 'proxy-authorization' => 1,
    'proxy-authenticate' => 1, 'proxy-connection' => 1,
    // Recomputed below.
    'host' => 1, 'content-length' => 1,
    // 100-continue would stall the loopback hop for nothing.
    'expect' => 1,
    // Forwarding metadata must be OURS, never client-supplied (IP spoofing).
    'forwarded' => 1, 'x-real-ip' => 1, 'x-forwarded-proto' => 1,
    'x-forwarded-host' => 1, 'x-forwarded-port' => 1, 'x-forwarded-server' => 1,
];

$xff = '';
$hasAccept = false;
$hasUserAgent = false;
$upstreamHeaders = [];
foreach (incoming_headers() as $name => $value) {
    $lname = strtolower(trim($name));
    if ($lname === '' || isset($stripRequest[$lname])) { continue; }
    if ($lname === 'x-forwarded-for') { $xff = clean(trim($value)); continue; }
    if ($lname === 'accept') { $hasAccept = true; }
    if ($lname === 'user-agent') { $hasUserAgent = true; }
    $upstreamHeaders[] = clean(trim($name)) . ': ' . clean($value);
}

$clientIp = clean((string)($_SERVER['REMOTE_ADDR'] ?? ''));
$isHttps  = (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off')
    || (string)($_SERVER['SERVER_PORT'] ?? '') === '443';
$host = clean((string)($_SERVER['HTTP_HOST'] ?? ''));
if ($host === '') { $host = DEFAULT_HOST; }

$upstreamHeaders[] = 'Host: ' . $host;
$upstreamHeaders[] = 'X-Forwarded-For: ' . ($xff !== '' ? $xff . ', ' . $clientIp : $clientIp);
$upstreamHeaders[] = 'X-Real-IP: ' . $clientIp;
$upstreamHeaders[] = 'X-Forwarded-Proto: ' . ($isHttps ? 'https' : 'http');
$upstreamHeaders[] = 'Expect:';                        // suppress curl's 100-continue
if (!$hasAccept)    { $upstreamHeaders[] = 'Accept:'; }      // no curl default
if (!$hasUserAgent) { $upstreamHeaders[] = 'User-Agent:'; }  // no curl default

// ---------------------------------------------------------------------------
// Request body: stream php://input, never a string in memory.
// ---------------------------------------------------------------------------

$contentLength = null;
if (($_SERVER['CONTENT_LENGTH'] ?? '') !== '' && ctype_digit((string)$_SERVER['CONTENT_LENGTH'])) {
    $contentLength = (int)$_SERVER['CONTENT_LENGTH'];
}
$mayHaveBody = in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true);
$chunkedIn = stripos((string)($_SERVER['HTTP_TRANSFER_ENCODING'] ?? ''), 'chunked') !== false;
$hasBody = $mayHaveBody && (($contentLength !== null && $contentLength > 0) || $chunkedIn);
if ($mayHaveBody && !$hasBody && $method !== 'DELETE') {
    $upstreamHeaders[] = 'Content-Length: 0';
}

// ---------------------------------------------------------------------------
// Proxy the request with curl, streaming both directions.
// ---------------------------------------------------------------------------

$state = new class {
    public int $status = 0;
    /** @var string[] raw header lines of the current upstream header block */
    public array $headerLines = [];
    public bool $headersOut = false;
    public bool $clientGone = false;
};

/**
 * Replay the buffered upstream header block to our client: status code first,
 * then every header except hop-by-hop ones. Set-Cookie always appends (a login
 * sets two cookies); any other repeated header appends after its first
 * occurrence replaces PHP's defaults.
 */
$emitHeaders = function () use ($state): void {
    if ($state->headersOut) { return; }
    $state->headersOut = true;
    http_response_code($state->status > 0 ? $state->status : 200);
    $stripResponse = [
        'connection' => 1, 'keep-alive' => 1, 'transfer-encoding' => 1, 'te' => 1,
        'trailer' => 1, 'upgrade' => 1, 'proxy-authenticate' => 1, 'proxy-connection' => 1,
    ];
    $seen = [];
    foreach ($state->headerLines as $line) {
        $pos = strpos($line, ':');
        if ($pos === false || $pos === 0) { continue; }
        $name  = trim(substr($line, 0, $pos));
        $lname = strtolower($name);
        if (isset($stripResponse[$lname])) { continue; }
        $value = trim(substr($line, $pos + 1));
        if ($lname === 'set-cookie') {
            header($name . ': ' . $value, false);
            continue;
        }
        $replace = !isset($seen[$lname]);
        $seen[$lname] = true;
        header($name . ': ' . $value, $replace);
    }
    $state->headerLines = [];
};

$ch = curl_init();
if ($ch === false) {
    bail(502, 'UPSTREAM_DOWN', 'The API backend is not reachable');
}

$options = [
    CURLOPT_URL            => $targetUrl,
    CURLOPT_CUSTOMREQUEST  => $method,
    CURLOPT_HTTP_VERSION   => CURL_HTTP_VERSION_1_1,
    CURLOPT_PROTOCOLS      => CURLPROTO_HTTP,
    CURLOPT_CONNECTTIMEOUT => CONNECT_TIMEOUT_S,
    CURLOPT_TIMEOUT        => 0,        // a 1 GB transfer sets its own pace
    CURLOPT_FOLLOWLOCATION => false,    // 302s (legacy release URLs) pass through
    CURLOPT_RETURNTRANSFER => false,
    CURLOPT_HEADER         => false,
    CURLOPT_BUFFERSIZE     => CURL_BUFFER_BYTES,
    CURLOPT_HTTPHEADER     => $upstreamHeaders,

    // Interim 1xx blocks are swallowed; the final block is replayed the moment
    // its terminating blank line arrives (so 204/304/HEAD emit correctly too).
    CURLOPT_HEADERFUNCTION => function ($ch, string $line) use ($state, $emitHeaders): int {
        $len = strlen($line);
        $trimmed = rtrim($line, "\r\n");
        if ($trimmed === '') {
            if ($state->status >= 200) {
                $emitHeaders();
            } else {
                $state->status = 0;
                $state->headerLines = [];
            }
            return $len;
        }
        if (preg_match('#^HTTP/\d(?:\.\d)?\s+(\d{3})#i', $trimmed, $m)) {
            $state->status = (int)$m[1];
            $state->headerLines = [];
            return $len;
        }
        $state->headerLines[] = $trimmed;
        return $len;
    },

    // Body chunks go straight out with a flush. echo blocks while the client
    // drains, which back-pressures curl — a slow downloader never makes this
    // process buffer. A vanished client aborts the upstream transfer (-1).
    CURLOPT_WRITEFUNCTION => function ($ch, string $chunk) use ($state, $emitHeaders): int {
        if (!$state->headersOut) { $emitHeaders(); }
        if (connection_aborted()) {
            $state->clientGone = true;
            return -1;
        }
        echo $chunk;
        flush();
        return strlen($chunk);
    },
];

if ($method === 'HEAD') {
    $options[CURLOPT_NOBODY] = true;
}

$bodyStream = null;
if ($hasBody) {
    $bodyStream = fopen('php://input', 'rb');
    if ($bodyStream === false) {
        bail(502, 'UPSTREAM_DOWN', 'The request body could not be read');
    }
    $options[CURLOPT_UPLOAD] = true;    // stream INFILE; CUSTOMREQUEST keeps the verb
    $options[CURLOPT_INFILE] = $bodyStream;
    if ($contentLength !== null) {
        $options[CURLOPT_INFILESIZE] = $contentLength;   // upstream gets Content-Length
    }                                                    // else curl sends chunked
}

curl_setopt_array($ch, $options);
curl_exec($ch);
$errno = curl_errno($ch);
$error = curl_error($ch);
curl_close($ch);
if (is_resource($bodyStream)) { fclose($bodyStream); }

if ($errno !== 0) {
    if ($state->clientGone) { exit; }   // nobody left to tell
    if (!$state->headersOut) {
        error_log('[api-proxy] upstream unreachable (curl ' . $errno . '): ' . $error);
        bail(502, 'UPSTREAM_DOWN', 'The API backend is not reachable');
    }
    // Headers already sent: all we can do is end the body short so the client
    // sees a truncated transfer, never a fake success.
    error_log('[api-proxy] transfer aborted mid-stream (curl ' . $errno . '): ' . $error);
    exit;
}
if (!$state->headersOut) {
    bail(502, 'UPSTREAM_DOWN', 'The API backend returned no response');
}
exit;
