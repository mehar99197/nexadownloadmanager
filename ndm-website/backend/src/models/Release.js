'use strict';

const { query, queryOne, insert, execute } = require('../config/db');

const Release = {
  async findLatest() {
    return queryOne('SELECT * FROM releases WHERE is_latest = 1 ORDER BY published_at DESC LIMIT 1');
  },

  async findById(id) {
    return queryOne('SELECT * FROM releases WHERE id = ?', [id]);
  },

  async listAll() {
    return query('SELECT * FROM releases ORDER BY published_at DESC');
  },

  async create({ version, windowsUrl, linuxUrl, changelog, isLatest }) {
    const id = await insert(
      'INSERT INTO releases (version, windows_url, linux_url, changelog, is_latest) VALUES (?, ?, ?, ?, ?)',
      [version, windowsUrl || '', linuxUrl || '', changelog || '', isLatest ? 1 : 0]
    );
    return Release.findById(id);
  },

  async update(id, fields) {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      const col = k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
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
};

module.exports = Release;
