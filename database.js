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
    imageUrl TEXT,
    discord_id TEXT,
    email TEXT,
    role TEXT DEFAULT 'member'
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

  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    leader_username TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS team_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    username TEXT NOT NULL UNIQUE,
    role TEXT DEFAULT 'member',
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    discord_id TEXT,
    email TEXT,
    FOREIGN KEY (team_id) REFERENCES teams (id)
  );

  CREATE TABLE IF NOT EXISTS referrals (
    code TEXT PRIMARY KEY,
    team_id INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    is_used INTEGER DEFAULT 0,
    used_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (team_id) REFERENCES teams (id)
  );
`);

try {
  db.exec(`ALTER TABLE applications ADD COLUMN message_id TEXT;`);
} catch (e) {}

try {
  db.exec(`ALTER TABLE keys ADD COLUMN discord_id TEXT;`);
} catch (e) {}

try {
  db.exec(`ALTER TABLE keys ADD COLUMN email TEXT;`);
} catch (e) {}

try {
  db.exec(`ALTER TABLE team_members ADD COLUMN discord_id TEXT;`);
} catch (e) {}

try {
  db.exec(`ALTER TABLE team_members ADD COLUMN email TEXT;`);
} catch (e) {}

module.exports = db;
