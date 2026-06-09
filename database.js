const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'scanner.db');
const db = new Database(dbPath, { verbose: console.log });

db.exec(`
  CREATE TABLE IF NOT EXISTS keys (
    id TEXT PRIMARY KEY,
    game TEXT NOT NULL,
    label TEXT,
    createdBy TEXT,
    createdAt TEXT,
    expiresAt TEXT,
    active INTEGER DEFAULT 1,
    maxUses INTEGER DEFAULT 1,
    currentUses INTEGER DEFAULT 0,
    notes TEXT,
    imageUrl TEXT
  );

  CREATE TABLE IF NOT EXISTS scans (
    scan_id INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL, -- The key id
    game TEXT NOT NULL,
    results_json TEXT,
    scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip_address TEXT,
    FOREIGN KEY (id) REFERENCES keys (id)
  );
`);

module.exports = db;
