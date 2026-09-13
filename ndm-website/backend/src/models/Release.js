'use strict';

const { query, queryOne, insert, execute } = require('../config/db');

// Columns update() may touch. The name is interpolated into the statement, so
// it must never come from user input — see User.js for the reasoning. The
// download counter has its own atomic increment and is deliberately absent.
const UPDATABLE_COLUMNS = new Set([
  'version', 'windows_url', 'linux_url', 'windows_sha256', 'linux_sha256',
  'windows_file', 'linux_file', 'windows_filename', 'linux_filename',
  'windows_size', 'linux_size', 'changelog', 'is_latest', 'published_at',
]);

const Release = {
  async findLatest() {
    return queryOne('SELECT * FROM releases WHERE is_latest = 1 ORDER BY published_at DESC LIMIT 1');
  },

  async findById(id) {
    return queryOne('SELECT * FROM releases WHERE id = ?', [id]);
  },

  async findByVersion(version) {
    return queryOne('SELECT * FROM releases WHERE version = ?', [String(version).trim()]);
  },

  async listAll() {
    return query('SELECT * FROM releases ORDER BY published_at DESC');
  },

  async create({ version, windowsUrl, linuxUrl, changelog, isLatest, windowsSha256, linuxSha256 }) {
    const id = await insert(
      `INSERT INTO releases (version, windows_url, linux_url, changelog, is_latest, windows_sha256, linux_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [version, windowsUrl || '', linuxUrl || '', changelog || '', isLatest ? 1 : 0,
       windowsSha256 || null, linuxSha256 || null]
    );
    return Release.findById(id);
  },

  async update(id, fields) {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      const col = k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
      if (!UPDATABLE_COLUMNS.has(col))
        throw new Error(`Release.update: "${k}" is not an updatable column`);
      sets.push(`${col} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await execute(`UPDATE releases SET ${sets.join(', ')} WHERE id = ?`, vals);
  },

  async remove(id) {
    const result = await execute('DELETE FROM releases WHERE id = ?', [id]);
    return result.affectedRows || 0;
  },

  async unsetLatest() {
    await execute('UPDATE releases SET is_latest = 0 WHERE is_latest = 1');
  },

  async unsetLatestExcept(id) {
    await execute('UPDATE releases SET is_latest = 0 WHERE is_latest = 1 AND id != ?', [id]);
  },

  // Atomic counter bump for the public download redirect.
  async incrementDownloadCount(id) {
    const result = await execute(
      'UPDATE releases SET download_count = download_count + 1 WHERE id = ?', [id]
    );
    return result.affectedRows || 0;
  },

  // Real total across every release (feeds GET /api/stats).
  async sumDownloadCount() {
    const r = await queryOne('SELECT COALESCE(SUM(download_count), 0) AS total FROM releases');
    return r ? Number(r.total) || 0 : 0;
  },
};

module.exports = Release;
