'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
let db;

function init() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS licenses (
      key          TEXT PRIMARY KEY,
      email        TEXT NOT NULL,
      tier         TEXT NOT NULL,
      conversions  INTEGER DEFAULT 0,
      max_monthly  INTEGER NOT NULL,
      created_at   TEXT DEFAULT (datetime('now')),
      expires_at   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      license_key  TEXT NOT NULL,
      slide_count  INTEGER,
      created_at   TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function verifyKey(key) {
  const row = db.prepare('SELECT * FROM licenses WHERE key = ?').get(key);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null; // expired
  return row;
}

function checkQuota(license) {
  if (license.max_monthly === -1) return true; // unlimited
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const count = db.prepare(
    'SELECT COUNT(*) as c FROM conversions WHERE license_key = ? AND created_at >= ?'
  ).get(license.key, monthStart.toISOString()).c;
  return count < license.max_monthly;
}

function recordConversion(licenseKey, slideCount) {
  db.prepare(
    'INSERT INTO conversions (license_key, slide_count) VALUES (?, ?)'
  ).run(licenseKey, slideCount);
  db.prepare(
    'UPDATE licenses SET conversions = conversions + 1 WHERE key = ?'
  ).run(licenseKey);
}

function createLicense({ key, email, tier, maxMonthly, expiresAt }) {
  db.prepare(`
    INSERT OR REPLACE INTO licenses (key, email, tier, max_monthly, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(key, email, tier, maxMonthly, expiresAt);
}

module.exports = { init, verifyKey, checkQuota, recordConversion, createLicense };
