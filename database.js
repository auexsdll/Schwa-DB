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

  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    email TEXT NOT NULL,
    discord TEXT,
    reason TEXT,
    status TEXT DEFAULT 'pending',
    message_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
});

try {
  db.exec(`ALTER TABLE applications ADD COLUMN message_id TEXT;`);
} catch (e) {
  // Ignore if column already exists
}

module.exports = db;
