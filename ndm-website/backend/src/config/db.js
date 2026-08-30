'use strict';

const mysql = require('mysql2/promise');
const config = require('./env');

let pool = null;

async function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: config.MYSQL_HOST,
      port: config.MYSQL_PORT,
      user: config.MYSQL_USER,
      password: config.MYSQL_PASS,
      database: config.MYSQL_DB,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      timezone: '+00:00',
      dateStrings: false,
    });

    // The driver is told to read every DATETIME as UTC (timezone above), but the
    // SERVER still evaluates NOW()/CURRENT_TIMESTAMP in its own zone. On a box
    // that is not on UTC the two disagree, and every timestamp we write with
    // NOW() reads back offset by that amount — which silently breaks anything
    // comparing a stored date against JS time (trial expiry, licence expiry,
    // token windows). Pinning each connection to UTC makes both sides agree.
    pool.on('connection', (connection) => {
      connection.query("SET time_zone = '+00:00'");
    });
  }
  return pool;
}

async function connectDB() {
  try {
    const p = await getPool();
    const conn = await p.getConnection();
    await conn.ping();
    conn.release();
    // eslint-disable-next-line no-console
    console.log(`[db] connected: ${config.MYSQL_HOST}/${config.MYSQL_DB}`);
    return p;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[db] connection failed:', err.message);
    process.exit(1);
  }
}

async function query(sql, params = []) {
  const p = await getPool();
  const [rows] = await p.execute(sql, params);
  return rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

async function insert(sql, params = []) {
  const p = await getPool();
  const [result] = await p.execute(sql, params);
  return result.insertId;
}

async function execute(sql, params = []) {
  const p = await getPool();
  const [result] = await p.execute(sql, params);
  return result;
}

async function withTransaction(work) {
  const pool = await getPool();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

module.exports = { connectDB, getPool, query, queryOne, insert, execute, withTransaction };
