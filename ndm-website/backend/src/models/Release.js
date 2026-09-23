'use strict';

const { query, queryOne, insert, execute, withTransaction } = require('../config/db');

// Columns update() may touch. The name is interpolated into the statement, so
// it must never come from user input — see User.js for the reasoning. The
// download counter has its own atomic increment and is deliberately absent.
const UPDATABLE_COLUMNS = new Set([
  'version', 'windows_url', 'linux_url', 'windows_sha256', 'linux_sha256',
  'windows_file', 'linux_file', 'windows_filename', 'linux_filename',
  'windows_size', 'linux_size', 'changelog', 'is_latest', 'published_at',
]);

function setClause(fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    const col = k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
    if (!UPDATABLE_COLUMNS.has(col))
      throw new Error(`Release.update: "${k}" is not an updatable column`);
    sets.push(`${col} = ?`);
    vals.push(v);
  }
  return { sets, vals };
}

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

  /**
   * Insert a release. When it is to be the latest, the old latest is demoted in
   * the SAME transaction: demoting and inserting as two separate statements
   * left the update feed with no latest release whenever the insert failed (a
   * duplicate version racing past the route's check, for one).
   */
  async create({ version, windowsUrl, linuxUrl, changelog, isLatest, windowsSha256, linuxSha256 }) {
    const sql = `INSERT INTO releases (version, windows_url, linux_url, changelog, is_latest, windows_sha256, linux_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?)`;
    const params = [version, windowsUrl || '', linuxUrl || '', changelog || '', isLatest ? 1 : 0,
      windowsSha256 || null, linuxSha256 || null];
    const id = isLatest
      ? await withTransaction(async (conn) => {
        await conn.execute('UPDATE releases SET is_latest = 0 WHERE is_latest = 1');
        const [result] = await conn.execute(sql, params);
        return result.insertId;
      })
      : await insert(sql, params);
    return Release.findById(id);
  },

  async update(id, fields) {
    const { sets, vals } = setClause(fields);
    if (sets.length === 0) return;
    vals.push(id);
    await execute(`UPDATE releases SET ${sets.join(', ')} WHERE id = ?`, vals);
  },

  /**
   * The admin edit: apply `fields`, and when `fields.isLatest` is true make
   * this the ONLY latest release — one transaction, with the row locked so a
   * concurrent delete cannot slip between the check and the writes.
   *
   * Returns 'not_found' when the release does not exist, and nothing is
   * touched (the old route demoted the current latest before finding that out,
   * which left the desktop update feed with no latest release); 'is_latest'
   * when the edit would un-latest the current latest, which ends the same way —
   * "latest" moves by promoting another release; otherwise 'ok'.
   */
  async updateKeepingOneLatest(id, fields) {
    return withTransaction(async (conn) => {
      const [rows] = await conn.execute('SELECT id, is_latest FROM releases WHERE id = ? FOR UPDATE', [id]);
      if (!rows.length) return 'not_found';
      if (fields.isLatest === false && Number(rows[0].is_latest)) return 'is_latest';
      if (fields.isLatest === true)
        await conn.execute('UPDATE releases SET is_latest = 0 WHERE is_latest = 1 AND id != ?', [id]);
      const { sets, vals } = setClause(fields);
      if (sets.length) {
        vals.push(id);
        await conn.execute(`UPDATE releases SET ${sets.join(', ')} WHERE id = ?`, vals);
      }
      return 'ok';
    });
  },

  async remove(id) {
    const result = await execute('DELETE FROM releases WHERE id = ?', [id]);
    return result.affectedRows || 0;
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
