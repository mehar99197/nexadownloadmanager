'use strict';

/**
 * Storage for uploaded installers.
 *
 * Releases used to be pure metadata pointing at an external URL. They can now
 * carry the actual artifact, so these helpers own everything to do with bytes
 * on disk: where they live, how they get there, and how they are served back.
 *
 * Two rules shape the implementation:
 *   - Never buffer an installer in memory. Uploads stream request → disk and
 *     downloads stream disk → response, so a 400 MB build costs a few KB of RAM.
 *   - Never trust a client-supplied name for a filesystem path. The stored name
 *     is generated here; the original is kept only as a display label.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const config = require('./../config/env');

const OS_KEYS = ['windows', 'linux'];

// Extensions we are willing to store and hand back. An installer is the only
// thing this endpoint is for; anything else is a mistake or an upload attack.
const ALLOWED_EXTENSIONS = new Set([
  '.exe', '.msi', '.deb', '.rpm', '.appimage', '.zip', '.tar', '.gz', '.xz', '.tgz',
]);

function uploadDir() {
  return config.RELEASE_UPLOAD_DIR;
}

async function ensureUploadDir() {
  await fsp.mkdir(uploadDir(), { recursive: true });
  return uploadDir();
}

/** Strip everything but a safe basename, then validate the extension. */
function safeExtension(originalName) {
  const base = path.basename(String(originalName || '')).toLowerCase();
  const ext = path.extname(base);
  // ".tar.gz" reads as ".gz" via extname, which is in the allow-list already.
  if (!ALLOWED_EXTENSIONS.has(ext)) return null;
  return ext;
}

/** Display name kept for Content-Disposition. Never used as a path. */
function safeDisplayName(originalName, fallback) {
  const base = path.basename(String(originalName || '')).replace(/["\\\r\n]/g, '');
  return base && base !== '.' && base !== '..' ? base.slice(0, 200) : fallback;
}

/**
 * Stream a request body into the upload directory.
 *
 * Writes to a temporary name first and renames only after the stream closes
 * cleanly, so an aborted upload can never leave a truncated file that looks
 * like a valid installer. Hashes while streaming — one pass, no re-read.
 */
async function storeUpload(req, { os, version, originalName, maxBytes }) {
  if (!OS_KEYS.includes(os)) throw Object.assign(new Error('Unsupported OS'), { status: 400, code: 'BAD_OS' });
  const ext = safeExtension(originalName);
  if (!ext) {
    throw Object.assign(
      new Error(`Unsupported file type. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`),
      { status: 400, code: 'BAD_FILE_TYPE' }
    );
  }

  await ensureUploadDir();
  const stored = `${os}-${String(version).replace(/[^\w.-]/g, '_')}-${crypto.randomUUID()}${ext}`;
  const tempPath = path.join(uploadDir(), `.incoming-${crypto.randomUUID()}`);
  const finalPath = path.join(uploadDir(), stored);

  const hash = crypto.createHash('sha256');
  let size = 0;
  let tooBig = false;

  const meter = new (require('stream').Transform)({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (maxBytes && size > maxBytes) {
        tooBig = true;
        return cb(Object.assign(new Error('Upload exceeds the maximum allowed size'), {
          status: 413, code: 'FILE_TOO_LARGE',
        }));
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  try {
    await pipeline(req, meter, fs.createWriteStream(tempPath));
  } catch (err) {
    await fsp.rm(tempPath, { force: true });
    if (tooBig) throw err;
    throw Object.assign(new Error('Upload failed or was interrupted'), {
      status: 400, code: 'UPLOAD_FAILED', cause: err,
    });
  }

  if (size === 0) {
    await fsp.rm(tempPath, { force: true });
    throw Object.assign(new Error('Uploaded file is empty'), { status: 400, code: 'EMPTY_UPLOAD' });
  }

  await fsp.rename(tempPath, finalPath);
  return {
    file: stored,
    filename: safeDisplayName(originalName, stored),
    size,
    sha256: hash.digest('hex'),
  };
}

/** Absolute path for a stored name, refusing anything that escapes the dir. */
function resolveStoredPath(storedName) {
  if (!storedName) return null;
  const base = path.basename(String(storedName));
  if (base !== String(storedName)) return null;
  const abs = path.join(uploadDir(), base);
  // Defence in depth: even after basename(), confirm containment.
  if (path.relative(uploadDir(), abs).startsWith('..')) return null;
  return abs;
}

/** The uploaded artifact for an OS, or null when the release has none. */
function artifactFor(release, os) {
  if (!release || !OS_KEYS.includes(os)) return null;
  const stored = os === 'windows' ? release.windows_file : release.linux_file;
  if (!stored) return null;
  const abs = resolveStoredPath(stored);
  if (!abs) return null;
  return {
    storedName: stored,
    absPath: abs,
    filename: (os === 'windows' ? release.windows_filename : release.linux_filename) || stored,
    size: Number(os === 'windows' ? release.windows_size : release.linux_size) || 0,
    sha256: (os === 'windows' ? release.windows_sha256 : release.linux_sha256) || '',
  };
}

async function removeStored(storedName) {
  const abs = resolveStoredPath(storedName);
  if (!abs) return false;
  await fsp.rm(abs, { force: true });
  return true;
}

/**
 * Serve a file with byte-range support.
 *
 * NDM is a download manager: its own users — and the app's updater — expect to
 * resume a partial installer download. Without Accept-Ranges a dropped transfer
 * restarts from zero, so this speaks 206/416 properly rather than only 200.
 */
function sendFile(req, res, artifact) {
  const { absPath, filename } = artifact;
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null; // caller turns this into a 404
  }
  const total = stat.size;

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Accept-Ranges', 'bytes');
  if (artifact.sha256) res.setHeader('X-Checksum-Sha256', artifact.sha256);

  const range = req.headers.range;
  if (!range) {
    res.setHeader('Content-Length', total);
    if (req.method === 'HEAD') return res.status(200).end();
    return fs.createReadStream(absPath).pipe(res);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (!match) {
    res.setHeader('Content-Range', `bytes */${total}`);
    return res.status(416).end();
  }
  const [, rawStart, rawEnd] = match;
  let start;
  let end;
  if (rawStart === '') {
    // Suffix form "bytes=-500" — the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      res.setHeader('Content-Range', `bytes */${total}`);
      return res.status(416).end();
    }
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? total - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    res.setHeader('Content-Range', `bytes */${total}`);
    return res.status(416).end();
  }
  end = Math.min(end, total - 1);

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  res.setHeader('Content-Length', end - start + 1);
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(absPath, { start, end }).pipe(res);
}

module.exports = {
  OS_KEYS, ALLOWED_EXTENSIONS,
  uploadDir, ensureUploadDir, storeUpload, artifactFor, removeStored, sendFile,
  safeExtension, safeDisplayName, resolveStoredPath,
};
